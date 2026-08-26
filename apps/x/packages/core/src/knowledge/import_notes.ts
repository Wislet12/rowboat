import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { frontmatter } from '@x/shared';

import { WorkDir } from '../config/config.js';
import { isPathInside } from '../filesystem/files.js';
import {
    LLMPARSE_MIME_TYPES,
    LOCAL_PARSE_EXTENSIONS,
    parseFileLocally,
    parseFileWithLlm,
} from '../runtime/tools/domains/parsing.js';
import { resolveWorkspacePath, writeFile } from '../workspace/workspace.js';

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const DEFAULT_IMPORT_FOLDER = 'knowledge/Brain/Imports';
const SOURCE_FOLDER_NAME = '_sources';

const TEXT_EXTENSIONS = new Set([
    '.md', '.markdown', '.txt', '.text', '.csv', '.tsv', '.json', '.jsonl',
    '.yaml', '.yml', '.xml', '.log', '.rst', '.adoc', '.ini', '.toml', '.env',
    '.org', '.tex', '.texi', '.typ', '.properties', '.cfg', '.conf', '.ics', '.vcf',
    '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cs', '.go', '.rs', '.c',
    '.cpp', '.h', '.hpp', '.sql', '.sh', '.zsh', '.fish', '.ps1', '.bat',
]);

const HTML_EXTENSIONS = new Set(['.html', '.htm']);

export const IMPORT_NOTE_DIALOG_EXTENSIONS = [
    'md', 'markdown', 'txt', 'text', 'rtf', 'html', 'htm', 'pdf', 'doc', 'docx',
    'docm', 'dotx', 'dotm', 'ppt', 'pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm',
    'xls', 'xlsx', 'xlsm', 'xltx', 'xltm', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml',
    'xml', 'odt', 'ott', 'ods', 'ots', 'odp', 'otp', 'epub', 'ipynb',
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
    'bmp', 'tif', 'tiff', 'log', 'rst', 'adoc', 'ini', 'toml', 'js', 'jsx',
    'ts', 'tsx', 'py', 'java', 'cs', 'go', 'rs', 'c', 'cpp', 'h', 'hpp',
    'sql', 'sh', 'zsh', 'fish', 'ps1', 'bat', 'org', 'tex', 'texi', 'typ',
    'properties', 'cfg', 'conf', 'ics', 'vcf',
];

export type ImportStrategy = 'text' | 'html' | 'local-document' | 'model-document' | 'unknown';
export type ImportExtraction = 'plain-text' | 'local-parser' | 'model-vision';

export type ImportedBrainNote = {
    path: string;
    sourcePath: string;
    title: string;
    format: string;
    contentLength: number;
    extraction: ImportExtraction;
};

export type BrainNoteImportFailure = {
    sourcePath: string;
    error: string;
};

export type BrainNoteImportResult = {
    imported: ImportedBrainNote[];
    failures: BrainNoteImportFailure[];
};

export type ImportedSourceNoteContext = {
    sourcePath: string;
    notePath: string;
    title: string;
    content: string;
    contentReadable: boolean;
    metadata: Record<string, string | string[]>;
};

function slashPath(value: string): string {
    return value.replace(/\\/g, '/').replace(/\/+$/g, '');
}

function decodeFrontmatterScalar(value: string | string[] | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('"')) {
        try {
            const parsed = JSON.parse(trimmed);
            return typeof parsed === 'string' ? parsed : null;
        } catch {
            return null;
        }
    }
    return trimmed;
}

export function parseImportedSourceNote(
    notePath: string,
    markdown: string,
): ImportedSourceNoteContext | null {
    const parsed = frontmatter.parseFrontmatter(markdown);
    const sourcePath = decodeFrontmatterScalar(parsed.fields.source_file);
    if (!sourcePath) return null;
    const title = decodeFrontmatterScalar(parsed.fields.title)
        ?? path.basename(notePath, path.extname(notePath));
    return {
        sourcePath: slashPath(sourcePath).replace(/^\.\//, ''),
        notePath: slashPath(notePath).replace(/^\.\//, ''),
        title,
        content: parsed.body,
        contentReadable: hasMeaningfulImportedContent(parsed.body),
        metadata: parsed.fields,
    };
}

export function hasMeaningfulImportedContent(value: string): boolean {
    const substantive = value
        // pdf-parse emits these even when a PDF has no extractable text layer.
        .replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gim, '')
        .replace(/_No extractable text was found in this file\._/gi, '')
        .replace(/[#*_`>\-\s]/g, '');
    return /[\p{L}\p{N}]{2,}/u.test(substantive);
}

/**
 * Resolve an original imported binary (PDF, Office, image, and similar) to
 * the extracted Markdown note created alongside it during import.
 *
 * Only the direct parent of the reserved `_sources` folder is inspected.
 * This keeps lookup bounded, prevents cross-notebook/source confusion, and
 * re-reads the companion note for every chat or voice turn so edits, deletes,
 * and permission changes take effect immediately.
 */
export async function getImportedSourceNoteContext(
    sourcePathInput: string,
): Promise<ImportedSourceNoteContext | null> {
    const sourcePath = slashPath(sourcePathInput.trim()).replace(/^\.\//, '');
    const absoluteSource = path.resolve(resolveWorkspacePath(sourcePath));
    const knowledgeRoot = path.resolve(WorkDir, 'knowledge');
    if (!isPathInside(knowledgeRoot, absoluteSource)) {
        throw new Error('Imported note sources must stay inside the knowledge folder.');
    }

    const sourceFolder = path.dirname(absoluteSource);
    if (path.basename(sourceFolder) !== SOURCE_FOLDER_NAME) return null;

    const noteFolder = path.dirname(sourceFolder);
    const entries = await fs.readdir(noteFolder, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
        const absoluteNotePath = path.join(noteFolder, entry.name);
        const notePath = slashPath(path.relative(WorkDir, absoluteNotePath));
        const markdown = await fs.readFile(absoluteNotePath, 'utf8');
        const candidate = parseImportedSourceNote(notePath, markdown);
        if (candidate?.sourcePath === sourcePath) return candidate;
    }
    return null;
}

export function normalizeBrainImportFolder(targetFolder?: string): string {
    const normalized = slashPath((targetFolder || DEFAULT_IMPORT_FOLDER).trim()).replace(/^\.\//, '');
    if (!normalized || normalized === 'knowledge') return DEFAULT_IMPORT_FOLDER;
    if (normalized === 'knowledge/Meetings' || normalized.startsWith('knowledge/Meetings/')) {
        throw new Error('Meeting notes must be imported from the Meetings section.');
    }
    if (normalized === 'knowledge/Workspace' || normalized.startsWith('knowledge/Workspace/')) {
        throw new Error('Workspace files are not Brain notes.');
    }
    if (!normalized.startsWith('knowledge/')) {
        throw new Error('Brain imports must stay inside the knowledge folder.');
    }

    const absoluteTarget = path.resolve(resolveWorkspacePath(normalized));
    const knowledgeRoot = path.resolve(WorkDir, 'knowledge');
    if (!isPathInside(knowledgeRoot, absoluteTarget)) {
        throw new Error('Brain import target escapes the knowledge folder.');
    }
    return normalized;
}

export function getImportStrategy(filePath: string): ImportStrategy {
    const ext = path.extname(filePath).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext)) return 'text';
    if (HTML_EXTENSIONS.has(ext)) return 'html';
    if (LOCAL_PARSE_EXTENSIONS.has(ext)) return 'local-document';
    if (LLMPARSE_MIME_TYPES[ext]) return 'model-document';
    return 'unknown';
}

function escapeFrontmatterString(value: string): string {
    return JSON.stringify(value);
}

export function buildImportedNoteMarkdown(input: {
    title: string;
    body: string;
    importedAt: string;
    sourceName: string;
    sourcePath: string;
    sourceFormat: string;
    sourceHash: string;
    extraction?: ImportExtraction;
}): string {
    const body = input.body.trim();
    return [
        '---',
        'type: brain',
        'source: file-import',
        `title: ${escapeFrontmatterString(input.title)}`,
        `imported_at: ${escapeFrontmatterString(input.importedAt)}`,
        `source_name: ${escapeFrontmatterString(input.sourceName)}`,
        `source_file: ${escapeFrontmatterString(input.sourcePath)}`,
        `source_format: ${escapeFrontmatterString(input.sourceFormat)}`,
        `source_sha256: ${escapeFrontmatterString(input.sourceHash)}`,
        ...(input.extraction ? [`extraction: ${escapeFrontmatterString(input.extraction)}`] : []),
        '---',
        '',
        `# ${input.title}`,
        '',
        body || '_No extractable text was found in this file._',
        '',
    ].join('\n');
}

function cleanBaseName(filePath: string): string {
    const base = path.basename(filePath, path.extname(filePath))
        .replace(/[\\/*?:"<>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return base || 'Imported note';
}

function cleanSourceName(filePath: string): string {
    return path.basename(filePath).replace(/[\\/*?:"<>|]/g, '').trim() || 'source-file';
}

async function uniqueWorkspacePath(folder: string, stem: string, extension: string): Promise<string> {
    for (let index = 0; index < 10_000; index += 1) {
        const suffix = index === 0 ? '' : `-${index}`;
        const candidate = `${folder}/${stem}${suffix}${extension}`;
        try {
            await fs.access(resolveWorkspacePath(candidate));
        } catch {
            return candidate;
        }
    }
    throw new Error(`Could not allocate a unique filename for ${stem}${extension}`);
}

function looksLikeText(buffer: Buffer): boolean {
    const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
    if (sample.includes(0)) return false;
    let controls = 0;
    for (const byte of sample) {
        if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) controls += 1;
    }
    return sample.length === 0 || controls / sample.length < 0.02;
}

export async function extractImportedNoteContent(
    sourcePath: string,
    strategy: ImportStrategy = getImportStrategy(sourcePath),
    sourceBuffer?: Buffer,
): Promise<{ body: string; extraction: ImportExtraction }> {
    const buffer = sourceBuffer ?? await fs.readFile(sourcePath);
    if (strategy === 'text') return { body: buffer.toString('utf8'), extraction: 'plain-text' };
    if (strategy === 'html') {
        return { body: NodeHtmlMarkdown.translate(buffer.toString('utf8')), extraction: 'plain-text' };
    }

    if (strategy === 'local-document') {
        const parsed = await parseFileLocally(sourcePath);
        const localBody = parsed.content?.trim() ?? '';
        if (parsed.success && hasMeaningfulImportedContent(localBody)) {
            return { body: localBody, extraction: 'local-parser' };
        }

        // Scanned PDFs, image-only Office files, and malformed local archives
        // can contain useful visible notes even when their text layer is empty.
        // Use the configured multimodal provider only as a bounded fallback.
        if (LLMPARSE_MIME_TYPES[path.extname(sourcePath).toLowerCase()]) {
            const modelParsed = await parseFileWithLlm(
                sourcePath,
                'Extract every readable note from this document into faithful, well-structured markdown. Preserve headings, slide numbers, speaker notes, tables, lists, dates, names, and important metadata. For scans or images, use OCR. Do not invent missing content.',
            );
            if (modelParsed.success && modelParsed.content?.trim()) {
                return { body: modelParsed.content.trim(), extraction: 'model-vision' };
            }
            throw new Error(modelParsed.error || parsed.error || 'Document parsing found no readable content.');
        }
        throw new Error(parsed.error || 'Local document parsing found no readable content.');
    }

    if (strategy === 'model-document') {
        const parsed = await parseFileWithLlm(
            sourcePath,
            'Convert this note or document into faithful, well-structured markdown. Preserve headings, tables, lists, dates, names, and important metadata. Do not invent missing content.',
        );
        if (!parsed.success) throw new Error(parsed.error || 'Document parsing failed.');
        if (!parsed.content?.trim()) throw new Error('Document parsing found no readable content.');
        return { body: parsed.content.trim(), extraction: 'model-vision' };
    }

    // Unknown extensions still import when they are genuinely text. This makes
    // the Brain useful for uncommon note/code formats without pretending that
    // arbitrary binary formats can be decoded safely.
    if (looksLikeText(buffer)) return { body: buffer.toString('utf8'), extraction: 'plain-text' };
    throw new Error('Unsupported binary format. Convert it to text, PDF, Office, OpenDocument, or an image first.');
}

async function importOneBrainNote(sourcePath: string, targetFolder: string): Promise<ImportedBrainNote> {
    const sourceStat = await fs.stat(sourcePath);
    if (!sourceStat.isFile()) throw new Error('The selected item is not a file.');
    if (sourceStat.size > MAX_IMPORT_BYTES) throw new Error('File is larger than the 50 MB import limit.');

    const sourceBuffer = await fs.readFile(sourcePath);
    const strategy = getImportStrategy(sourcePath);
    const extracted = await extractImportedNoteContent(sourcePath, strategy, sourceBuffer);
    const body = extracted.body;
    const sourceName = cleanSourceName(sourcePath);
    const title = cleanBaseName(sourcePath);
    const extension = path.extname(sourceName).toLowerCase();
    const sourceFolder = `${targetFolder}/${SOURCE_FOLDER_NAME}`;
    const importedSourcePath = await uniqueWorkspacePath(
        sourceFolder,
        path.basename(sourceName, extension),
        extension,
    );
    const notePath = await uniqueWorkspacePath(targetFolder, title, '.md');
    const sourceHash = createHash('sha256').update(sourceBuffer).digest('hex');

    await fs.mkdir(path.dirname(resolveWorkspacePath(importedSourcePath)), { recursive: true });
    await fs.writeFile(resolveWorkspacePath(importedSourcePath), sourceBuffer);

    const markdown = buildImportedNoteMarkdown({
        title,
        body,
        importedAt: new Date().toISOString(),
        sourceName,
        sourcePath: importedSourcePath,
        sourceFormat: extension.slice(1) || 'text',
        sourceHash,
        extraction: extracted.extraction,
    });
    await writeFile(notePath, markdown, { encoding: 'utf8', mkdirp: true, atomic: true });

    return {
        path: notePath,
        sourcePath: importedSourcePath,
        title,
        format: extension.slice(1) || 'text',
        contentLength: body.length,
        extraction: extracted.extraction,
    };
}

export async function importBrainNotes(sourcePaths: string[], targetFolder?: string): Promise<BrainNoteImportResult> {
    const normalizedTarget = normalizeBrainImportFolder(targetFolder);
    const imported: ImportedBrainNote[] = [];
    const failures: BrainNoteImportFailure[] = [];

    // Run sequentially to keep model-backed extraction and disk pressure
    // bounded while a meeting recording may be active.
    for (const sourcePath of sourcePaths) {
        try {
            imported.push(await importOneBrainNote(path.resolve(sourcePath), normalizedTarget));
        } catch (error) {
            failures.push({
                sourcePath,
                error: error instanceof Error ? error.message : 'Import failed.',
            });
        }
    }

    return { imported, failures };
}
