import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NodeHtmlMarkdown } from 'node-html-markdown';

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
    '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cs', '.go', '.rs', '.c',
    '.cpp', '.h', '.hpp', '.sql', '.sh', '.zsh', '.fish', '.ps1', '.bat',
]);

const HTML_EXTENSIONS = new Set(['.html', '.htm']);

export const IMPORT_NOTE_DIALOG_EXTENSIONS = [
    'md', 'markdown', 'txt', 'text', 'rtf', 'html', 'htm', 'pdf', 'doc', 'docx',
    'ppt', 'pptx', 'xls', 'xlsx', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml',
    'xml', 'odt', 'ods', 'odp', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
    'bmp', 'tif', 'tiff', 'log', 'rst', 'adoc', 'ini', 'toml', 'js', 'jsx',
    'ts', 'tsx', 'py', 'java', 'cs', 'go', 'rs', 'c', 'cpp', 'h', 'hpp',
    'sql', 'sh', 'zsh', 'fish', 'ps1', 'bat',
];

export type ImportStrategy = 'text' | 'html' | 'local-document' | 'model-document' | 'unknown';

export type ImportedBrainNote = {
    path: string;
    sourcePath: string;
    title: string;
    format: string;
    contentLength: number;
};

export type BrainNoteImportFailure = {
    sourcePath: string;
    error: string;
};

export type BrainNoteImportResult = {
    imported: ImportedBrainNote[];
    failures: BrainNoteImportFailure[];
};

function slashPath(value: string): string {
    return value.replace(/\\/g, '/').replace(/\/+$/g, '');
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

async function extractImportBody(sourcePath: string, strategy: ImportStrategy, sourceBuffer: Buffer): Promise<string> {
    if (strategy === 'text') return sourceBuffer.toString('utf8');
    if (strategy === 'html') return NodeHtmlMarkdown.translate(sourceBuffer.toString('utf8'));

    if (strategy === 'local-document') {
        const parsed = await parseFileLocally(sourcePath);
        if (!parsed.success) throw new Error(parsed.error || 'Local document parsing failed.');
        return parsed.content || '';
    }

    if (strategy === 'model-document') {
        const parsed = await parseFileWithLlm(
            sourcePath,
            'Convert this note or document into faithful, well-structured markdown. Preserve headings, tables, lists, dates, names, and important metadata. Do not invent missing content.',
        );
        if (!parsed.success) throw new Error(parsed.error || 'Document parsing failed.');
        return parsed.content || '';
    }

    // Unknown extensions still import when they are genuinely text. This makes
    // the Brain useful for uncommon note/code formats without pretending that
    // arbitrary binary formats can be decoded safely.
    if (looksLikeText(sourceBuffer)) return sourceBuffer.toString('utf8');
    throw new Error('Unsupported binary format. Convert it to text, PDF, Office, OpenDocument, or an image first.');
}

async function importOneBrainNote(sourcePath: string, targetFolder: string): Promise<ImportedBrainNote> {
    const sourceStat = await fs.stat(sourcePath);
    if (!sourceStat.isFile()) throw new Error('The selected item is not a file.');
    if (sourceStat.size > MAX_IMPORT_BYTES) throw new Error('File is larger than the 50 MB import limit.');

    const sourceBuffer = await fs.readFile(sourcePath);
    const strategy = getImportStrategy(sourcePath);
    const body = await extractImportBody(sourcePath, strategy, sourceBuffer);
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
    });
    await writeFile(notePath, markdown, { encoding: 'utf8', mkdirp: true, atomic: true });

    return {
        path: notePath,
        sourcePath: importedSourcePath,
        title,
        format: extension.slice(1) || 'text',
        contentLength: body.length,
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
