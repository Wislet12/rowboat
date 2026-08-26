import { createHash } from 'node:crypto';
import { z } from 'zod';

import { importBrainNotes, type BrainNoteImportResult } from './import_notes.js';
import {
    exists,
    readFile,
    remove,
    resolveWorkspacePath,
    stat,
    writeFile,
} from '../workspace/workspace.js';
import fs from 'node:fs/promises';

export const NOTEBOOKS_ROOT = 'knowledge/Brain/Notebooks';
const MANIFEST_NAME = '.rowboat-notebook.json';
const SOURCES_FOLDER_NAME = 'Sources';
const MAX_NOTEBOOK_SOURCES = 50;
const MAX_CONTEXT_CHARS = 90_000;
const CHUNK_CHARS = 5_000;
const CHUNK_OVERLAP_CHARS = 500;

export const NotebookRetrievalProfileSchema = z.enum(['fast', 'balanced', 'precise']);
export type NotebookRetrievalProfile = z.infer<typeof NotebookRetrievalProfileSchema>;

const RETRIEVAL_PROFILES: Record<NotebookRetrievalProfile, {
    maxContextChars: number;
    maxChunksPerSource: number;
    parentContextRadius: number;
}> = {
    fast: { maxContextChars: 45_000, maxChunksPerSource: 2, parentContextRadius: 0 },
    balanced: { maxContextChars: MAX_CONTEXT_CHARS, maxChunksPerSource: 5, parentContextRadius: 0 },
    precise: { maxContextChars: 120_000, maxChunksPerSource: 8, parentContextRadius: 1 },
};

const NotebookSourceSchema = z.object({
    path: z.string().min(1),
    title: z.string().min(1),
    enabled: z.boolean(),
    contextMode: z.enum(['off', 'overview', 'full']).optional(),
    addedAt: z.string().min(1),
    sourceFilePath: z.string().min(1).optional(),
    format: z.string().min(1).optional(),
    contentLength: z.number().int().nonnegative().optional(),
    extraction: z.enum(['plain-text', 'local-parser', 'model-vision']).optional(),
}).transform((source) => ({
    ...source,
    contextMode: source.contextMode ?? (source.enabled ? 'full' as const : 'off' as const),
}));

const NotebookManifestSchema = z.object({
    version: z.literal(1),
    title: z.string().min(1),
    description: z.string().max(2_000).default(''),
    retrievalProfile: NotebookRetrievalProfileSchema.default('balanced'),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    sources: z.array(NotebookSourceSchema).max(MAX_NOTEBOOK_SOURCES),
});

export type NotebookSource = z.infer<typeof NotebookSourceSchema>;
export type NotebookManifest = z.infer<typeof NotebookManifestSchema>;

export type NotebookSourceDescriptor = NotebookSource & {
    available: boolean;
    modifiedAt: number | null;
    size: number | null;
};

export type NotebookDescriptor = Omit<NotebookManifest, 'sources'> & {
    path: string;
    sources: NotebookSourceDescriptor[];
};

export type NotebookContextSource = {
    id: string;
    path: string;
    title: string;
    content: string;
    truncated: boolean;
    contextMode: 'overview' | 'full';
};

export type NotebookContextSnapshot = {
    kind: 'notebook';
    path: string;
    contextId: string;
    title: string;
    description: string;
    retrievalProfile: NotebookRetrievalProfile;
    query?: string;
    sources: NotebookContextSource[];
    selectedSourceCount: number;
    unavailableSources: Array<{ path: string; title: string }>;
    retrievalEvidence: {
        queryTermCount: number;
        candidateChunkCount: number;
        selectedChunkCount: number;
        readableSourceCount: number;
    };
    capturedAt: string;
};

type SourceReader = (sourcePath: string) => Promise<string>;

const STOP_WORDS = new Set([
    'about', 'after', 'again', 'also', 'and', 'are', 'because', 'before', 'being',
    'between', 'could', 'does', 'from', 'have', 'into', 'just', 'more', 'most',
    'notes', 'notebook', 'should', 'that', 'their', 'them', 'then', 'there', 'these',
    'they', 'this', 'those', 'through', 'what', 'when', 'where', 'which', 'while',
    'with', 'would', 'your',
]);

function normalizePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

export function isNotebookPath(value: string): boolean {
    const normalized = normalizePath(value);
    const parts = normalized.split('/');
    return parts.length === 4
        && parts[0] === 'knowledge'
        && parts[1] === 'Brain'
        && parts[2] === 'Notebooks'
        && Boolean(parts[3]);
}

export function findNotebookPath(value?: string): string | null {
    if (!value) return null;
    const normalized = normalizePath(value);
    const parts = normalized.split('/');
    if (parts.length < 4) return null;
    const candidate = parts.slice(0, 4).join('/');
    return isNotebookPath(candidate) ? candidate : null;
}

function assertNotebookPath(value: string): string {
    const normalized = normalizePath(value);
    if (!isNotebookPath(normalized)) {
        throw new Error('Notebook path must identify a notebook inside Brain/Notebooks.');
    }
    return normalized;
}

function manifestPath(notebookPath: string): string {
    return `${assertNotebookPath(notebookPath)}/${MANIFEST_NAME}`;
}

function cleanNotebookTitle(value: string): string {
    const title = value.replace(/[\0\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!title) throw new Error('Notebook name is required.');
    return title.slice(0, 120);
}

function cleanNotebookDescription(value: string): string {
    return value.replace(/\0/g, '').replace(/\r\n/g, '\n').trim().slice(0, 2_000);
}

function cleanSourceTitle(value: string): string {
    const title = value.replace(/[\0\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!title) throw new Error('Source title is required.');
    return title.slice(0, 160);
}

function slugForTitle(title: string): string {
    const slug = title
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()
        .slice(0, 80);
    return slug || 'notebook';
}

async function uniqueNotebookPath(title: string): Promise<string> {
    const stem = slugForTitle(title);
    for (let index = 0; index < 10_000; index += 1) {
        const suffix = index === 0 ? '' : `-${index + 1}`;
        const candidate = `${NOTEBOOKS_ROOT}/${stem}${suffix}`;
        if (!(await exists(candidate)).exists) return candidate;
    }
    throw new Error('Could not allocate a unique notebook folder.');
}

async function persistNotebook(notebookPath: string, manifest: NotebookManifest): Promise<void> {
    const parsed = NotebookManifestSchema.parse(manifest);
    await writeFile(manifestPath(notebookPath), `${JSON.stringify(parsed, null, 2)}\n`, {
        encoding: 'utf8',
        mkdirp: true,
        atomic: true,
    });
}

export async function createNotebook(titleInput: string): Promise<NotebookDescriptor> {
    const title = cleanNotebookTitle(titleInput);
    const notebookPath = await uniqueNotebookPath(title);
    const timestamp = new Date().toISOString();
    const manifest: NotebookManifest = {
        version: 1,
        title,
        description: '',
        retrievalProfile: 'balanced',
        createdAt: timestamp,
        updatedAt: timestamp,
        sources: [],
    };
    await fs.mkdir(resolveWorkspacePath(`${notebookPath}/${SOURCES_FOLDER_NAME}`), { recursive: true });
    await persistNotebook(notebookPath, manifest);
    return { path: notebookPath, ...manifest, sources: [] };
}

export async function getNotebook(notebookPathInput: string): Promise<NotebookDescriptor> {
    const notebookPath = assertNotebookPath(notebookPathInput);
    const result = await readFile(manifestPath(notebookPath));
    const manifest = NotebookManifestSchema.parse(JSON.parse(result.data));
    const sources: NotebookSourceDescriptor[] = await Promise.all(manifest.sources.map(async (source) => {
        try {
            const sourceStat = await stat(source.path);
            return {
                ...source,
                available: sourceStat.kind === 'file',
                modifiedAt: sourceStat.mtimeMs,
                size: sourceStat.size,
            };
        } catch {
            return { ...source, available: false, modifiedAt: null, size: null };
        }
    }));
    return { path: notebookPath, ...manifest, sources };
}

export async function importNotebookSources(
    notebookPathInput: string,
    sourcePaths: string[],
): Promise<BrainNoteImportResult> {
    const notebookPath = assertNotebookPath(notebookPathInput);
    const notebook = await getNotebook(notebookPath);
    const remaining = Math.max(0, MAX_NOTEBOOK_SOURCES - notebook.sources.length);
    if (remaining === 0) throw new Error(`This notebook already has ${MAX_NOTEBOOK_SOURCES} sources.`);

    const result = await importBrainNotes(
        sourcePaths.slice(0, remaining),
        `${notebookPath}/${SOURCES_FOLDER_NAME}`,
    );
    if (result.imported.length === 0) return result;

    const timestamp = new Date().toISOString();
    const knownPaths = new Set(notebook.sources.map((source) => source.path));
    const addedSources: NotebookSource[] = result.imported
        .filter((item) => !knownPaths.has(item.path))
        .map((item) => ({
            path: item.path,
            title: item.title,
            enabled: true,
            contextMode: 'full' as const,
            addedAt: timestamp,
            sourceFilePath: item.sourcePath,
            format: item.format,
            contentLength: item.contentLength,
            extraction: item.extraction,
        }));
    await persistNotebook(notebookPath, {
        ...notebook,
        updatedAt: timestamp,
        sources: [...notebook.sources, ...addedSources].slice(0, MAX_NOTEBOOK_SOURCES),
    });
    return result;
}

export async function updateNotebook(
    notebookPathInput: string,
    input: { title?: string; description?: string; retrievalProfile?: NotebookRetrievalProfile },
): Promise<NotebookDescriptor> {
    const notebookPath = assertNotebookPath(notebookPathInput);
    const notebook = await getNotebook(notebookPath);
    const updatedAt = new Date().toISOString();
    await persistNotebook(notebookPath, {
        ...notebook,
        title: input.title === undefined ? notebook.title : cleanNotebookTitle(input.title),
        description: input.description === undefined
            ? notebook.description
            : cleanNotebookDescription(input.description),
        retrievalProfile: input.retrievalProfile === undefined
            ? notebook.retrievalProfile
            : NotebookRetrievalProfileSchema.parse(input.retrievalProfile),
        updatedAt,
    });
    return getNotebook(notebookPath);
}

export async function deleteNotebook(notebookPathInput: string): Promise<{ ok: true }> {
    const notebookPath = assertNotebookPath(notebookPathInput);
    await getNotebook(notebookPath);
    return remove(notebookPath, { recursive: true, trash: true });
}

export async function updateNotebookSource(
    notebookPathInput: string,
    sourcePathInput: string,
    input: { title: string },
): Promise<NotebookDescriptor> {
    const notebookPath = assertNotebookPath(notebookPathInput);
    const sourcePath = normalizePath(sourcePathInput);
    const notebook = await getNotebook(notebookPath);
    if (!notebook.sources.some((source) => source.path === sourcePath)) {
        throw new Error('That source does not belong to this notebook.');
    }
    const sources = notebook.sources.map((source) => source.path === sourcePath
        ? { ...source, title: cleanSourceTitle(input.title) }
        : source);
    const updatedAt = new Date().toISOString();
    await persistNotebook(notebookPath, { ...notebook, sources, updatedAt });
    return getNotebook(notebookPath);
}

export async function removeNotebookSource(
    notebookPathInput: string,
    sourcePathInput: string,
): Promise<NotebookDescriptor> {
    const notebookPath = assertNotebookPath(notebookPathInput);
    const sourcePath = normalizePath(sourcePathInput);
    const notebook = await getNotebook(notebookPath);
    const source = notebook.sources.find((candidate) => candidate.path === sourcePath);
    if (!source) throw new Error('That source does not belong to this notebook.');
    if (!sourcePath.startsWith(`${notebookPath}/`)) {
        throw new Error('Notebook source deletion is restricted to this notebook.');
    }

    const updatedAt = new Date().toISOString();
    const sources = notebook.sources.filter((candidate) => candidate.path !== sourcePath);
    // Remove authority first. If moving a file to trash is interrupted, an
    // orphan may remain on disk, but it can no longer enter chat or voice.
    await persistNotebook(notebookPath, { ...notebook, sources, updatedAt });

    for (const candidate of [source.path, source.sourceFilePath]) {
        if (!candidate) continue;
        const normalized = normalizePath(candidate);
        if (!normalized.startsWith(`${notebookPath}/`)) continue;
        if ((await exists(normalized)).exists) {
            await remove(normalized, { trash: true });
        }
    }
    return getNotebook(notebookPath);
}

export async function setNotebookSourceEnabled(
    notebookPathInput: string,
    sourcePathInput: string,
    enabled: boolean,
): Promise<NotebookDescriptor> {
    const notebookPath = assertNotebookPath(notebookPathInput);
    const sourcePath = normalizePath(sourcePathInput);
    const notebook = await getNotebook(notebookPath);
    let changed = false;
    const sources = notebook.sources.map((source) => {
        if (source.path !== sourcePath || source.enabled === enabled) return source;
        changed = true;
        return {
            ...source,
            enabled,
            contextMode: enabled
                ? (source.contextMode === 'off' ? 'full' as const : source.contextMode)
                : 'off' as const,
        };
    });
    if (!notebook.sources.some((source) => source.path === sourcePath)) {
        throw new Error('That source does not belong to this notebook.');
    }
    if (!changed) return notebook;
    const updatedAt = new Date().toISOString();
    await persistNotebook(notebookPath, { ...notebook, sources, updatedAt });
    return { ...notebook, sources, updatedAt };
}

export async function setNotebookSourceContextMode(
    notebookPathInput: string,
    sourcePathInput: string,
    contextMode: 'off' | 'overview' | 'full',
): Promise<NotebookDescriptor> {
    const notebookPath = assertNotebookPath(notebookPathInput);
    const sourcePath = normalizePath(sourcePathInput);
    const notebook = await getNotebook(notebookPath);
    if (!notebook.sources.some((source) => source.path === sourcePath)) {
        throw new Error('That source does not belong to this notebook.');
    }
    const sources = notebook.sources.map((source) => source.path === sourcePath
        ? { ...source, enabled: contextMode !== 'off', contextMode }
        : source);
    const updatedAt = new Date().toISOString();
    await persistNotebook(notebookPath, { ...notebook, sources, updatedAt });
    return { ...notebook, sources, updatedAt };
}

function queryTerms(query: string): string[] {
    return [...new Set(
        query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)
            ?.filter((term) => !STOP_WORDS.has(term)) ?? [],
    )].slice(0, 24);
}

function splitIntoChunks(content: string): string[] {
    const normalized = content.replace(/\0/g, '').trim();
    if (!normalized) return [];
    if (normalized.length <= CHUNK_CHARS) return [normalized];

    const chunks: string[] = [];
    let start = 0;
    while (start < normalized.length) {
        let end = Math.min(normalized.length, start + CHUNK_CHARS);
        if (end < normalized.length) {
            const paragraphBreak = normalized.lastIndexOf('\n\n', end);
            if (paragraphBreak > start + CHUNK_CHARS / 2) end = paragraphBreak;
        }
        chunks.push(normalized.slice(start, end).trim());
        if (end >= normalized.length) break;
        start = Math.max(start + 1, end - CHUNK_OVERLAP_CHARS);
    }
    return chunks.filter(Boolean);
}

function scoreChunk(chunk: string, title: string, terms: string[], chunkIndex: number): number {
    if (terms.length === 0) return Math.max(1, 20 - chunkIndex);
    const haystack = `${title}\n${chunk}`.toLowerCase();
    let score = chunkIndex === 0 ? 1 : 0;
    for (const term of terms) {
        let count = 0;
        let cursor = 0;
        while (count < 8) {
            const found = haystack.indexOf(term, cursor);
            if (found < 0) break;
            count += 1;
            cursor = found + term.length;
        }
        score += count * 4;
        if (title.toLowerCase().includes(term)) score += 12;
    }
    return score;
}

export async function buildNotebookContextFromManifest(
    notebook: NotebookDescriptor,
    query = '',
    readSource: SourceReader,
): Promise<NotebookContextSnapshot> {
    const retrievalProfile = notebook.retrievalProfile ?? 'balanced';
    const profile = RETRIEVAL_PROFILES[retrievalProfile];
    const enabledSources = notebook.sources
        .map((source, manifestIndex) => ({ source, manifestIndex }))
        .filter(({ source }) => source.enabled && source.contextMode !== 'off');
    const unavailableSources: Array<{ path: string; title: string }> = [];
    const terms = queryTerms(query);
    const candidates: Array<{
        sourceIndex: number;
        manifestIndex: number;
        chunkIndex: number;
        score: number;
        content: string;
        source: NotebookSource;
        sourceLength: number;
    }> = [];

    await Promise.all(enabledSources.map(async ({ source, manifestIndex }, sourceIndex) => {
        try {
            const fullContent = await readSource(source.path);
            const content = source.contextMode === 'overview'
                ? fullContent.slice(0, 3_000)
                : fullContent;
            const chunks = splitIntoChunks(content);
            chunks.forEach((chunk, chunkIndex) => {
                candidates.push({
                    sourceIndex,
                    manifestIndex,
                    chunkIndex,
                    score: scoreChunk(chunk, source.title, terms, chunkIndex),
                    content: chunk,
                    source,
                    sourceLength: fullContent.length,
                });
            });
        } catch {
            unavailableSources.push({ path: source.path, title: source.title });
        }
    }));

    candidates.sort((left, right) =>
        right.score - left.score
        || left.sourceIndex - right.sourceIndex
        || left.chunkIndex - right.chunkIndex,
    );

    const rankedCandidates = [...candidates];
    if (profile.parentContextRadius > 0) {
        const byKey = new Map(candidates.map((candidate) => [
            `${candidate.sourceIndex}:${candidate.chunkIndex}`,
            candidate,
        ]));
        const parentCandidates: typeof candidates = [];
        for (const candidate of candidates.filter((item) => item.score > 0)) {
            for (let offset = -profile.parentContextRadius; offset <= profile.parentContextRadius; offset += 1) {
                if (offset === 0) continue;
                const neighbor = byKey.get(`${candidate.sourceIndex}:${candidate.chunkIndex + offset}`);
                if (neighbor) parentCandidates.push({ ...neighbor, score: Math.max(neighbor.score, candidate.score - 0.5) });
            }
        }
        const merged = new Map<string, (typeof candidates)[number]>();
        for (const candidate of [...rankedCandidates, ...parentCandidates]) {
            const key = `${candidate.sourceIndex}:${candidate.chunkIndex}`;
            const previous = merged.get(key);
            if (!previous || candidate.score > previous.score) merged.set(key, candidate);
        }
        rankedCandidates.splice(0, rankedCandidates.length, ...merged.values());
        rankedCandidates.sort((left, right) =>
            right.score - left.score
            || left.sourceIndex - right.sourceIndex
            || left.chunkIndex - right.chunkIndex,
        );
    }

    const selected = new Map<number, typeof candidates>();
    let usedChars = 0;
    for (const candidate of rankedCandidates) {
        if (candidate.score <= 0 && selected.size > 0) continue;
        const cost = candidate.content.length + 160;
        if (usedChars + cost > profile.maxContextChars) continue;
        const sourceChunks = selected.get(candidate.sourceIndex) ?? [];
        if (sourceChunks.length >= profile.maxChunksPerSource) continue;
        sourceChunks.push(candidate);
        selected.set(candidate.sourceIndex, sourceChunks);
        usedChars += cost;
    }

    const sources: NotebookContextSource[] = [...selected.entries()]
        .sort(([left], [right]) => left - right)
        .map(([sourceIndex, chunks]) => {
            const { source, manifestIndex } = enabledSources[sourceIndex];
            const contextMode: 'overview' | 'full' = source.contextMode === 'overview' ? 'overview' : 'full';
            const ordered = [...chunks].sort((left, right) => left.chunkIndex - right.chunkIndex);
            return {
                id: `S${manifestIndex + 1}`,
                path: source.path,
                title: source.title,
                content: ordered.map((chunk) => chunk.content).join('\n\n[…]\n\n'),
                truncated: contextMode === 'overview'
                    || ordered.reduce((total, chunk) => total + chunk.content.length, 0) < ordered[0].sourceLength,
                contextMode,
            };
        });

    return {
        kind: 'notebook',
        path: notebook.path,
        contextId: `${notebook.path}@${notebook.updatedAt}:${createHash('sha256')
            .update(sources.map((source) => `${source.path}\0${source.content}`).join('\0'))
            .digest('hex')
            .slice(0, 16)}`,
        title: notebook.title,
        description: notebook.description,
        retrievalProfile,
        ...(query.trim() ? { query: query.trim().slice(0, 2_000) } : {}),
        sources,
        selectedSourceCount: enabledSources.length,
        unavailableSources,
        retrievalEvidence: {
            queryTermCount: terms.length,
            candidateChunkCount: candidates.length,
            selectedChunkCount: [...selected.values()].reduce((total, chunks) => total + chunks.length, 0),
            readableSourceCount: sources.length,
        },
        capturedAt: new Date().toISOString(),
    };
}

function cleanArtifactTitle(value: string): string {
    return cleanNotebookTitle(value || 'Chat response');
}

export async function saveChatOutput(input: {
    markdown: string;
    title?: string;
    notebookPath?: string;
}): Promise<{ path: string; title: string }> {
    const markdown = input.markdown.replace(/\0/g, '').trim();
    if (!markdown) throw new Error('There is no chat output to save.');
    const title = cleanArtifactTitle(input.title ?? 'Chat response');
    const notebookPath = input.notebookPath ? assertNotebookPath(input.notebookPath) : null;
    if (notebookPath) await getNotebook(notebookPath);
    const folder = notebookPath
        ? `${notebookPath}/Artifacts`
        : 'knowledge/Brain/Chat Outputs';
    const stem = slugForTitle(title) || 'chat-response';
    let target = '';
    for (let index = 0; index < 10_000; index += 1) {
        const suffix = index === 0 ? '' : `-${index + 1}`;
        const candidate = `${folder}/${stem}${suffix}.md`;
        if (!(await exists(candidate)).exists) {
            target = candidate;
            break;
        }
    }
    if (!target) throw new Error('Could not allocate a filename for this chat output.');
    const createdAt = new Date().toISOString();
    const content = [
        '---',
        'type: brain',
        'source: rowboat-chat-output',
        `title: ${JSON.stringify(title)}`,
        `created_at: ${JSON.stringify(createdAt)}`,
        ...(notebookPath ? [`notebook: ${JSON.stringify(notebookPath)}`] : []),
        '---',
        '',
        `# ${title}`,
        '',
        markdown,
        '',
    ].join('\n');
    await writeFile(target, content, { encoding: 'utf8', mkdirp: true, atomic: true });
    return { path: target, title };
}

export async function buildNotebookContext(
    notebookPathInput: string,
    query = '',
    readSource: SourceReader = async (sourcePath) => (await readFile(sourcePath)).data,
): Promise<NotebookContextSnapshot> {
    const notebook = await getNotebook(notebookPathInput);
    return buildNotebookContextFromManifest(notebook, query, readSource);
}
