// Builtin tools: parsing domain. Entries moved VERBATIM from the historical
// monolith — the merge order in ../builtin-tools.ts preserves the original
// catalog key order (provider-payload bytes; see the key-order test there).

import { z } from "zod";
import * as path from "path";
import * as files from "../../../filesystem/files.js";
import { generateText } from "ai";
import { createLanguageModel } from "../../../models/models.js";
import { getDefaultModelAndProvider, resolveProviderConfig } from "../../../models/defaults.js";
import { captureLlmUsage } from "../../../analytics/usage.js";
import { getCurrentUseCase, withUseCase } from "../../../analytics/use_case.js";
import {
    extractEpubArchive,
    extractJupyterNotebook,
    extractOpenDocumentArchive,
    extractPowerPointArchive,
    extractRtfText,
} from "../../../knowledge/document_extractors.js";
import { BuiltinToolsSchema } from "../types.js";



// Keep heavyweight parsers lazy so pdfjs does not run during app startup, but
// keep every specifier literal so esbuild can include the parser in Rowboat's
// self-contained main-process bundle. A variable `import(moduleName)` works in
// source/tests but leaves a bare runtime package lookup in the packaged app.
const loadPdfParser = () => import('pdf-parse');
const loadPdfWorker = () => import('pdfjs-dist/legacy/build/pdf.worker.mjs');
const loadDomMatrix = () => import('@thednp/dommatrix');
const loadSpreadsheetParser = () => import('xlsx');
const loadCsvParser = () => import('papaparse');
const loadWordParser = () => import('mammoth');

export const LLMPARSE_MIME_TYPES: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.docm': 'application/vnd.ms-word.document.macroenabled.12',
    '.dotx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
    '.dotm': 'application/vnd.ms-word.template.macroenabled.12',
    '.doc': 'application/msword',
    '.rtf': 'application/rtf',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.pptm': 'application/vnd.ms-powerpoint.presentation.macroenabled.12',
    '.ppsx': 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
    '.ppsm': 'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
    '.potx': 'application/vnd.openxmlformats-officedocument.presentationml.template',
    '.potm': 'application/vnd.ms-powerpoint.template.macroenabled.12',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xlsm': 'application/vnd.ms-excel.sheet.macroenabled.12',
    '.xltx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
    '.xltm': 'application/vnd.ms-excel.template.macroenabled.12',
    '.xls': 'application/vnd.ms-excel',
    '.odt': 'application/vnd.oasis.opendocument.text',
    '.ott': 'application/vnd.oasis.opendocument.text-template',
    '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
    '.ots': 'application/vnd.oasis.opendocument.spreadsheet-template',
    '.odp': 'application/vnd.oasis.opendocument.presentation',
    '.otp': 'application/vnd.oasis.opendocument.presentation-template',
    '.epub': 'application/epub+zip',
    '.ipynb': 'application/json',
    '.csv': 'text/csv',
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
};

const LOCAL_WORD_EXTENSIONS = new Set(['.docx', '.docm', '.dotx', '.dotm']);
const LOCAL_PRESENTATION_EXTENSIONS = new Set(['.pptx', '.pptm', '.ppsx', '.ppsm', '.potx', '.potm']);
const LOCAL_SPREADSHEET_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.xltx', '.xltm', '.xls', '.ods', '.ots']);
const LOCAL_OPEN_TEXT_EXTENSIONS = new Set(['.odt', '.ott']);
const LOCAL_OPEN_PRESENTATION_EXTENSIONS = new Set(['.odp', '.otp']);

export const LOCAL_PARSE_EXTENSIONS = new Set([
    '.pdf', '.csv', '.rtf', '.epub', '.ipynb',
    ...LOCAL_WORD_EXTENSIONS,
    ...LOCAL_PRESENTATION_EXTENSIONS,
    ...LOCAL_SPREADSHEET_EXTENSIONS,
    ...LOCAL_OPEN_TEXT_EXTENSIONS,
    ...LOCAL_OPEN_PRESENTATION_EXTENSIONS,
]);

export type ParsedFileResult = {
    success: boolean;
    error?: string;
    fileName?: string;
    format?: string;
    mimeType?: string;
    content?: string;
    metadata?: Record<string, unknown>;
    sheets?: Record<string, string>;
    data?: unknown;
    usage?: unknown;
};

export async function parseFileLocally(filePath: string): Promise<ParsedFileResult> {
    try {
        const fileName = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();

        if (!LOCAL_PARSE_EXTENSIONS.has(ext)) {
            return {
                success: false,
                error: `Unsupported file format '${ext}'. Supported formats: ${Array.from(LOCAL_PARSE_EXTENSIONS).join(', ')}`,
            };
        }

        const { buffer, resolvedPath } = await files.readBuffer(filePath);

        if (ext === '.pdf') {
            // @napi-rs/canvas does not publish a Windows ARM64 binary. PDF.js
            // only needs DOMMatrix during text-only imports, so provide the
            // maintained zero-dependency DOMMatrix shim before PDF.js loads.
            const { default: DomMatrix } = await loadDomMatrix();
            const runtimeGlobals = globalThis as unknown as Record<string, unknown>;
            runtimeGlobals.DOMMatrix ||= DomMatrix;

            // pdfjs uses a fake worker in Electron's main process. Initialize the
            // worker handler from a literal import so esbuild embeds it in the
            // self-contained main.cjs instead of looking for ./pdf.worker.mjs
            // beside the packaged application at runtime.
            const [{ PDFParse }] = await Promise.all([
                loadPdfParser(),
                loadPdfWorker(),
            ]);
            const parser = new PDFParse({ data: new Uint8Array(buffer) });
            try {
                const textResult = await parser.getText();
                const infoResult = await parser.getInfo();
                return {
                    success: true,
                    fileName,
                    format: 'pdf',
                    content: textResult.text,
                    metadata: {
                        pages: textResult.total,
                        title: infoResult.info?.Title || undefined,
                        author: infoResult.info?.Author || undefined,
                        resolvedPath,
                    },
                };
            } finally {
                await parser.destroy();
            }
        }

        if (LOCAL_SPREADSHEET_EXTENSIONS.has(ext)) {
            const XLSX = await loadSpreadsheetParser();
            const workbook = XLSX.read(buffer, { type: 'buffer' });
            const sheets: Record<string, string> = {};
            for (const sheetName of workbook.SheetNames) {
                const sheet = workbook.Sheets[sheetName];
                sheets[sheetName] = XLSX.utils.sheet_to_csv(sheet);
            }
            return {
                success: true,
                fileName,
                format: ext.slice(1),
                content: Object.entries(sheets)
                    .map(([sheetName, csv]) => `## ${sheetName}\n\n${csv}`)
                    .join('\n\n'),
                metadata: {
                    sheetNames: workbook.SheetNames,
                    sheetCount: workbook.SheetNames.length,
                },
                sheets,
            };
        }

        if (ext === '.csv') {
            const Papa = (await loadCsvParser()).default;
            const text = buffer.toString('utf8');
            const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
            return {
                success: true,
                fileName,
                format: 'csv',
                content: text,
                metadata: {
                    rowCount: parsed.data.length,
                    headers: parsed.meta.fields || [],
                },
                data: parsed.data,
            };
        }

        if (LOCAL_WORD_EXTENSIONS.has(ext)) {
            const mammoth = (await loadWordParser()).default;
            const docResult = await mammoth.extractRawText({ buffer });
            return {
                success: true,
                fileName,
                format: ext.slice(1),
                content: docResult.value,
                metadata: { warnings: docResult.messages.map((message: { message: string }) => message.message) },
            };
        }

        if (LOCAL_PRESENTATION_EXTENSIONS.has(ext)) {
            const parsed = await extractPowerPointArchive(buffer);
            return { success: true, fileName, format: ext.slice(1), ...parsed };
        }

        if (LOCAL_OPEN_TEXT_EXTENSIONS.has(ext) || LOCAL_OPEN_PRESENTATION_EXTENSIONS.has(ext)) {
            const parsed = await extractOpenDocumentArchive(
                buffer,
                ext.slice(1) as 'odt' | 'ott' | 'odp' | 'otp',
            );
            return { success: true, fileName, format: ext.slice(1), ...parsed };
        }

        if (ext === '.rtf') {
            const parsed = extractRtfText(buffer);
            return { success: true, fileName, format: 'rtf', ...parsed };
        }

        if (ext === '.epub') {
            const parsed = await extractEpubArchive(buffer);
            return { success: true, fileName, format: 'epub', ...parsed };
        }

        if (ext === '.ipynb') {
            const parsed = extractJupyterNotebook(buffer);
            return { success: true, fileName, format: 'ipynb', ...parsed };
        }

        return { success: false, error: 'Unexpected error' };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

export async function parseFileWithLlm(filePath: string, prompt?: string): Promise<ParsedFileResult> {
    try {
        const fileName = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = LLMPARSE_MIME_TYPES[ext];

        if (!mimeType) {
            return {
                success: false,
                error: `Unsupported file format '${ext}'. Supported formats: ${Object.keys(LLMPARSE_MIME_TYPES).join(', ')}`,
            };
        }

        const { buffer } = await files.readBuffer(filePath);
        const base64 = buffer.toString('base64');
        const { model: modelId, provider: providerName } = await getDefaultModelAndProvider();
        const providerConfig = await resolveProviderConfig(providerName);
        const model = createLanguageModel(providerConfig, modelId);
        const userPrompt = prompt || 'Convert this file to well-structured markdown.';

        const ctx = getCurrentUseCase();
        const response = await withUseCase({
            useCase: ctx?.useCase ?? 'copilot_chat',
            subUseCase: 'file_parse',
            ...(ctx?.agentName ? { agentName: ctx.agentName } : {}),
        }, () => generateText({
            model,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: userPrompt },
                        { type: 'file', data: base64, mediaType: mimeType },
                    ],
                },
            ],
        }));

        captureLlmUsage({
            useCase: ctx?.useCase ?? 'copilot_chat',
            subUseCase: 'file_parse',
            ...(ctx?.agentName ? { agentName: ctx.agentName } : {}),
            model: modelId,
            provider: providerName,
            usage: response.usage,
        });

        return {
            success: true,
            fileName,
            format: ext.slice(1),
            mimeType,
            content: response.text,
            usage: response.usage,
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}



export const parsingTools: z.infer<typeof BuiltinToolsSchema> = {
    'parseFile': {
        permission: "file-boundary",
        description: 'Parse and extract text content locally from PDF, modern Word, PowerPoint, Excel/OpenDocument, RTF, EPUB, Jupyter Notebook, and CSV files. Auto-detects format from file extension.',
        inputSchema: z.object({
            path: z.string().min(1).describe('File path to parse. Can be absolute, ~/..., or relative to the default root.'),
        }),
        execute: async ({ path: filePath }: { path: string }) => {
            return parseFileLocally(filePath);
        },
    },

    'LLMParse': {
        permission: "file-boundary",
        description: 'Send a file to the configured LLM as a multimodal attachment and ask it to extract content as markdown. Best for scanned PDFs, legacy Office files, images with text, complex layouts, or any format where local parsing falls short. Supports documents (PDF, Word, Excel, PowerPoint, OpenDocument, EPUB, CSV, TXT, HTML) and images (PNG, JPG, GIF, WebP, SVG, BMP, TIFF).',
        inputSchema: z.object({
            path: z.string().min(1).describe('File path to parse. Can be absolute, ~/..., or relative to the default root.'),
            prompt: z.string().optional().describe('Custom instruction for the LLM (defaults to "Convert this file to well-structured markdown.")'),
        }),
        execute: async ({ path: filePath, prompt }: { path: string; prompt?: string }) => {
            return parseFileWithLlm(filePath, prompt);
        },
    },
};
