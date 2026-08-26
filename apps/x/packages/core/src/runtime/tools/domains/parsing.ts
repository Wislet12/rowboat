// Builtin tools: parsing domain. Entries moved VERBATIM from the historical
// monolith — the merge order in ../builtin-tools.ts preserves the original
// catalog key order (provider-payload bytes; see the key-order test there).

import { z } from "zod";
import * as path from "path";
import * as files from "../../../filesystem/files.js";
import { streamText } from "ai";
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
const loadPdfRenderer = () => import('pdfjs-dist/legacy/build/pdf.mjs');
const loadPdfWorker = () => import('pdfjs-dist/legacy/build/pdf.worker.mjs');
const loadDomMatrix = () => import('@thednp/dommatrix');
const loadCanvas = () => import('@napi-rs/canvas');
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

export type RenderedPdfPages = {
    pages: Array<{ pageNumber: number; base64: string }>;
    totalPages: number;
    truncated: boolean;
};

const MAX_LLM_PDF_PAGES = 12;

/**
 * Render scanned/image-only PDF pages to PNG without a browser window. This is
 * the local half of LLMParse's OCR fallback: the configured model receives
 * page images only after the normal PDF attachment path produces no content.
 */
export async function renderPdfPagesForLlm(
    buffer: Buffer,
    requestedPages?: number[],
): Promise<RenderedPdfPages> {
    const { createCanvas, DOMMatrix, ImageData, Path2D } = await loadCanvas();
    const runtimeGlobals = globalThis as unknown as Record<string, unknown>;
    runtimeGlobals.DOMMatrix = DOMMatrix;
    runtimeGlobals.ImageData ||= ImageData;
    runtimeGlobals.Path2D ||= Path2D;
    const [pdfjs] = await Promise.all([
        loadPdfRenderer(),
        loadPdfWorker(),
    ]);

    const document = await pdfjs.getDocument({
        data: new Uint8Array(buffer),
        disableWorker: true,
    } as Parameters<typeof pdfjs.getDocument>[0]).promise;
    try {
        const normalizedRequestedPages = requestedPages
            ? Array.from(new Set(requestedPages.filter((page) => Number.isInteger(page) && page >= 1 && page <= document.numPages)))
            : [];
        const selectedPages = (normalizedRequestedPages.length > 0
            ? normalizedRequestedPages
            : Array.from({ length: Math.min(document.numPages, MAX_LLM_PDF_PAGES) }, (_, index) => index + 1))
            .slice(0, MAX_LLM_PDF_PAGES);
        const pages: RenderedPdfPages['pages'] = [];

        for (const pageNumber of selectedPages) {
            const page = await document.getPage(pageNumber);
            const naturalViewport = page.getViewport({ scale: 1 });
            const scale = Math.max(0.75, Math.min(2, 1600 / naturalViewport.width));
            const viewport = page.getViewport({ scale });
            const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
            const canvasContext = canvas.getContext('2d');
            await page.render({
                canvasContext: canvasContext as unknown as CanvasRenderingContext2D,
                viewport,
            } as unknown as Parameters<typeof page.render>[0]).promise;
            pages.push({ pageNumber, base64: canvas.toBuffer('image/png').toString('base64') });
            page.cleanup();
        }

        return {
            pages,
            totalPages: document.numPages,
            truncated: selectedPages.length < document.numPages,
        };
    } finally {
        await document.destroy();
    }
}

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

export async function parseFileWithLlm(
    filePath: string,
    prompt?: string,
    requestedPages?: number[],
): Promise<ParsedFileResult> {
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
        const generate = async (
            content: Array<{ type: 'text'; text: string } | { type: 'file'; data: string; mediaType: string }>,
            subUseCase: 'file_parse' | 'file_parse_rendered_pdf',
        ) => {
            const response = await withUseCase({
                useCase: ctx?.useCase ?? 'copilot_chat',
                subUseCase,
                ...(ctx?.agentName ? { agentName: ctx.agentName } : {}),
            }, async () => {
                // Codex OAuth's Responses endpoint requires a real stream.
                // streamText keeps that native path intact; generateText has
                // to force and then re-aggregate SSE, which can yield a valid
                // reasoning item but lose the final multimodal text output.
                const streamed = streamText({ model, messages: [{ role: 'user', content }] });
                let text = '';
                for await (const delta of streamed.textStream) text += delta;
                return { text, usage: await streamed.usage };
            });
            captureLlmUsage({
                useCase: ctx?.useCase ?? 'copilot_chat',
                subUseCase,
                ...(ctx?.agentName ? { agentName: ctx.agentName } : {}),
                model: modelId,
                provider: providerName,
                usage: response.usage,
            });
            return response;
        };

        const response = await generate([
            { type: 'text', text: userPrompt },
            { type: 'file', data: base64, mediaType: mimeType },
        ], 'file_parse');

        if (response.text.trim()) {
            return {
                success: true,
                fileName,
                format: ext.slice(1),
                mimeType,
                content: response.text,
                usage: response.usage,
            };
        }

        // Some multimodal providers accept a PDF attachment but return a
        // reasoning-only, empty final response for image-only pages. Treating
        // that as success makes chat and voice incorrectly declare the note
        // unreadable. Render those pages locally and retry them as PNGs, the
        // same image input contract used by pasted screenshots.
        if (ext === '.pdf') {
            const rendered = await renderPdfPagesForLlm(buffer, requestedPages);
            if (rendered.pages.length === 0) {
                return { success: false, error: 'The PDF contains no renderable pages.' };
            }
            const renderedContent: Array<{ type: 'text'; text: string } | { type: 'file'; data: string; mediaType: string }> = [{
                type: 'text',
                text: [
                    userPrompt,
                    '',
                    'The PDF attachment returned no readable text. Analyze the rendered page images below with OCR/vision.',
                    'Preserve exact facts and page numbers. Do not claim the source is unreadable while visible text is present.',
                ].join('\n'),
            }];
            for (const page of rendered.pages) {
                renderedContent.push({ type: 'text', text: `PDF page ${page.pageNumber} of ${rendered.totalPages}:` });
                renderedContent.push({ type: 'file', data: page.base64, mediaType: 'image/png' });
            }
            const visualResponse = await generate(renderedContent, 'file_parse_rendered_pdf');
            if (!visualResponse.text.trim()) {
                return {
                    success: false,
                    error: 'The configured model returned no text for either the PDF attachment or its rendered page images.',
                    metadata: {
                        extractionMethod: 'rendered-pages',
                        renderedPages: rendered.pages.map((page) => page.pageNumber),
                        totalPages: rendered.totalPages,
                    },
                };
            }
            return {
                success: true,
                fileName,
                format: 'pdf',
                mimeType,
                content: visualResponse.text,
                usage: visualResponse.usage,
                metadata: {
                    extractionMethod: 'rendered-pages',
                    renderedPages: rendered.pages.map((page) => page.pageNumber),
                    totalPages: rendered.totalPages,
                    truncated: rendered.truncated,
                    ...(rendered.truncated
                        ? { nextStep: `Call LLMParse again with the remaining page numbers (maximum ${MAX_LLM_PDF_PAGES} per call).` }
                        : {}),
                },
            };
        }

        return {
            success: false,
            error: 'The configured model returned an empty response for this file.',
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
            pages: z.array(z.number().int().min(1)).max(MAX_LLM_PDF_PAGES).optional().describe(`Optional 1-indexed PDF pages to render with OCR/vision when the direct PDF response is empty (maximum ${MAX_LLM_PDF_PAGES}).`),
        }),
        execute: async ({ path: filePath, prompt, pages }: { path: string; prompt?: string; pages?: number[] }) => {
            return parseFileWithLlm(filePath, prompt, pages);
        },
    },
};
