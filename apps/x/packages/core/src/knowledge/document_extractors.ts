import path from 'node:path';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import yauzl from 'yauzl';

const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_SELECTED_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_SELECTED_ARCHIVE_BYTES = 64 * 1024 * 1024;

export type ArchiveDocumentExtraction = {
    content: string;
    metadata: Record<string, unknown>;
};

type ZipEntrySelector = (entryName: string) => boolean;

function naturalPathSort(left: string, right: string): number {
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function decodeXmlEntities(value: string): string {
    return value
        .replace(/&#x([0-9a-f]+);/gi, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
        .replace(/&#([0-9]+);/g, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)))
        .replace(/&nbsp;/gi, ' ')
        .replace(/&quot;/gi, '"')
        .replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&');
}

function normalizeExtractedText(value: string): string {
    return value
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => line.replace(/[\t ]+/g, ' ').trim())
        .filter((line, index, lines) => line || (index > 0 && lines[index - 1]))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function safeZipClose(zip: yauzl.ZipFile): void {
    try {
        zip.close();
    } catch {
        // yauzl may already have auto-closed after the final entry.
    }
}

async function readSelectedZipEntries(buffer: Buffer, select: ZipEntrySelector): Promise<Map<string, Buffer>> {
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: true }, (openError, zip) => {
            if (openError || !zip) {
                reject(openError ?? new Error('The document archive could not be opened.'));
                return;
            }

            const entries = new Map<string, Buffer>();
            let entryCount = 0;
            let selectedBytes = 0;
            let settled = false;

            const fail = (error: unknown) => {
                if (settled) return;
                settled = true;
                safeZipClose(zip);
                reject(error instanceof Error ? error : new Error(String(error)));
            };

            zip.on('error', fail);
            zip.on('end', () => {
                if (settled) return;
                settled = true;
                resolve(entries);
            });
            zip.on('entry', (entry: yauzl.Entry) => {
                entryCount += 1;
                if (entryCount > MAX_ARCHIVE_ENTRIES) {
                    fail(new Error(`The document archive contains more than ${MAX_ARCHIVE_ENTRIES} entries.`));
                    return;
                }

                const entryName = entry.fileName.replace(/\\/g, '/');
                if (entryName.endsWith('/') || !select(entryName)) {
                    zip.readEntry();
                    return;
                }
                if (entry.uncompressedSize > MAX_SELECTED_ENTRY_BYTES) {
                    fail(new Error(`Document section ${path.basename(entryName)} is too large to process safely.`));
                    return;
                }
                selectedBytes += entry.uncompressedSize;
                if (selectedBytes > MAX_SELECTED_ARCHIVE_BYTES) {
                    fail(new Error('The document expands beyond the 64 MB text-processing limit.'));
                    return;
                }

                zip.openReadStream(entry, (streamError, stream) => {
                    if (streamError || !stream) {
                        fail(streamError ?? new Error(`Could not read ${entryName}.`));
                        return;
                    }
                    const chunks: Buffer[] = [];
                    let received = 0;
                    stream.on('data', (chunk: Buffer) => {
                        received += chunk.length;
                        if (received > MAX_SELECTED_ENTRY_BYTES) {
                            stream.destroy(new Error(`Document section ${path.basename(entryName)} exceeded its declared size.`));
                            return;
                        }
                        chunks.push(Buffer.from(chunk));
                    });
                    stream.on('error', fail);
                    stream.on('end', () => {
                        if (settled) return;
                        entries.set(entryName, Buffer.concat(chunks));
                        zip.readEntry();
                    });
                });
            });
            zip.readEntry();
        });
    });
}

function extractPowerPointParagraphs(xml: string): string {
    const paragraphs: string[] = [];
    for (const paragraph of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gi)) {
        const text = [...paragraph[1].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi)]
            .map((match) => decodeXmlEntities(match[1]))
            .join('')
            .trim();
        if (text) paragraphs.push(text);
    }
    if (paragraphs.length > 0) return paragraphs.join('\n');
    return [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi)]
        .map((match) => decodeXmlEntities(match[1]).trim())
        .filter(Boolean)
        .join('\n');
}

export async function extractPowerPointArchive(buffer: Buffer): Promise<ArchiveDocumentExtraction> {
    const entries = await readSelectedZipEntries(
        buffer,
        (entryName) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/i.test(entryName),
    );
    const slideEntries = [...entries.keys()]
        .filter((entryName) => /^ppt\/slides\/slide\d+\.xml$/i.test(entryName))
        .sort(naturalPathSort);
    const noteEntries = [...entries.keys()]
        .filter((entryName) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(entryName))
        .sort(naturalPathSort);

    if (slideEntries.length === 0) throw new Error('No readable slides were found in this PowerPoint file.');
    const sections = slideEntries.map((entryName, index) => {
        const slideText = extractPowerPointParagraphs(entries.get(entryName)?.toString('utf8') ?? '');
        const notesText = extractPowerPointParagraphs(entries.get(noteEntries[index] ?? '')?.toString('utf8') ?? '');
        return [
            `## Slide ${index + 1}`,
            '',
            slideText || '_No extractable slide text._',
            ...(notesText ? ['', '### Speaker notes', '', notesText] : []),
        ].join('\n');
    });
    return {
        content: normalizeExtractedText(sections.join('\n\n')),
        metadata: { slideCount: slideEntries.length, notesSlideCount: noteEntries.length },
    };
}

function openDocumentXmlToMarkdown(xml: string): string {
    const converted = xml
        .replace(/<text:line-break\b[^>]*\/?\s*>/gi, '\n')
        .replace(/<text:tab\b[^>]*\/?\s*>/gi, '\t')
        .replace(/<text:h\b([^>]*)>/gi, (_match, attributes: string) => {
            const level = Math.max(1, Math.min(6, Number(attributes.match(/text:outline-level=["'](\d+)["']/i)?.[1] ?? 2)));
            return `\n${'#'.repeat(level)} `;
        })
        .replace(/<\/text:h>/gi, '\n')
        .replace(/<text:list-item\b[^>]*>/gi, '\n- ')
        .replace(/<\/text:list-item>/gi, '\n')
        .replace(/<text:p\b[^>]*>/gi, '\n')
        .replace(/<\/text:p>/gi, '\n')
        .replace(/<table:table-cell\b[^>]*>/gi, ' ')
        .replace(/<\/table:table-cell>/gi, ' | ')
        .replace(/<\/table:table-row>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
    return normalizeExtractedText(decodeXmlEntities(converted));
}

export async function extractOpenDocumentArchive(
    buffer: Buffer,
    format: 'odt' | 'ott' | 'odp' | 'otp',
): Promise<ArchiveDocumentExtraction> {
    const entries = await readSelectedZipEntries(buffer, (entryName) => entryName === 'content.xml');
    const xml = entries.get('content.xml')?.toString('utf8');
    if (!xml) throw new Error('The OpenDocument file does not contain readable content.xml data.');

    if (format === 'odp' || format === 'otp') {
        const pages = [...xml.matchAll(/<draw:page\b([^>]*)>([\s\S]*?)<\/draw:page>/gi)];
        if (pages.length === 0) throw new Error('No readable slides were found in this OpenDocument presentation.');
        const content = pages.map((page, index) => {
            const name = decodeXmlEntities(page[1].match(/draw:name=["']([^"']+)["']/i)?.[1] ?? '').trim();
            const body = openDocumentXmlToMarkdown(page[2]);
            return [`## Slide ${index + 1}${name ? ` — ${name}` : ''}`, '', body || '_No extractable slide text._'].join('\n');
        }).join('\n\n');
        return { content: normalizeExtractedText(content), metadata: { slideCount: pages.length } };
    }

    const content = openDocumentXmlToMarkdown(xml);
    if (!content) throw new Error('No readable text was found in this OpenDocument text file.');
    return { content, metadata: {} };
}

export async function extractEpubArchive(buffer: Buffer): Promise<ArchiveDocumentExtraction> {
    const entries = await readSelectedZipEntries(buffer, (entryName) => /\.(?:xhtml|html|htm)$/i.test(entryName));
    const chapterEntries = [...entries.keys()].sort(naturalPathSort).slice(0, 500);
    if (chapterEntries.length === 0) throw new Error('No readable HTML chapters were found in this EPUB file.');

    const chapters = chapterEntries.map((entryName) => {
        const html = entries.get(entryName)?.toString('utf8') ?? '';
        const markdown = NodeHtmlMarkdown.translate(html).trim();
        if (!markdown) return '';
        const chapterName = path.basename(entryName).replace(/\.(?:xhtml|html|htm)$/i, '').replace(/[-_]+/g, ' ').trim();
        return [`## ${chapterName || 'Chapter'}`, '', markdown].join('\n');
    }).filter(Boolean);
    if (chapters.length === 0) throw new Error('No readable chapter text was found in this EPUB file.');
    return {
        content: normalizeExtractedText(chapters.join('\n\n')),
        metadata: { chapterCount: chapters.length },
    };
}

function sourceText(source: unknown): string {
    if (Array.isArray(source)) return source.map((part) => String(part)).join('');
    return typeof source === 'string' ? source : '';
}

export function extractJupyterNotebook(buffer: Buffer): ArchiveDocumentExtraction {
    const parsed = JSON.parse(buffer.toString('utf8')) as {
        metadata?: { kernelspec?: { language?: string }; language_info?: { name?: string } };
        cells?: Array<{ cell_type?: string; source?: unknown; outputs?: Array<Record<string, unknown>> }>;
    };
    const language = parsed.metadata?.kernelspec?.language ?? parsed.metadata?.language_info?.name ?? 'text';
    const sections: string[] = [];
    let markdownCells = 0;
    let codeCells = 0;

    for (const [index, cell] of (parsed.cells ?? []).entries()) {
        const content = sourceText(cell.source).trim();
        if (!content) continue;
        if (cell.cell_type === 'markdown') {
            markdownCells += 1;
            sections.push(content);
            continue;
        }
        if (cell.cell_type === 'code') {
            codeCells += 1;
            sections.push([`### Code cell ${index + 1}`, '', '```' + language, content, '```'].join('\n'));
        }
    }
    const content = normalizeExtractedText(sections.join('\n\n'));
    if (!content) throw new Error('No readable Markdown or code cells were found in this notebook.');
    return { content, metadata: { markdownCells, codeCells, language } };
}

const RTF_DESTINATIONS = new Set([
    'colortbl', 'datastore', 'filetbl', 'fonttbl', 'footer', 'footerf', 'footerl', 'footerr',
    'header', 'headerf', 'headerl', 'headerr', 'info', 'listoverridetable', 'listtable',
    'object', 'pict', 'revtbl', 'stylesheet', 'themedata', 'xmlnstbl',
]);

function controlWordCharacter(word: string): string {
    if (word === 'par' || word === 'line') return '\n';
    if (word === 'tab') return '\t';
    if (word === 'emdash') return '—';
    if (word === 'endash') return '–';
    if (word === 'bullet') return '•';
    if (word === 'lquote' || word === 'rquote') return "'";
    if (word === 'ldblquote' || word === 'rdblquote') return '"';
    return '';
}

export function extractRtfText(buffer: Buffer): ArchiveDocumentExtraction {
    const source = buffer.toString('latin1');
    const stack: Array<{ skip: boolean; unicodeFallback: number }> = [{ skip: false, unicodeFallback: 1 }];
    let output = '';
    let index = 0;

    while (index < source.length) {
        const character = source[index];
        if (character === '{') {
            const parent = stack[stack.length - 1];
            stack.push({ ...parent });
            index += 1;
            continue;
        }
        if (character === '}') {
            if (stack.length > 1) stack.pop();
            index += 1;
            continue;
        }
        const state = stack[stack.length - 1];
        if (character !== '\\') {
            if (!state.skip) output += character;
            index += 1;
            continue;
        }

        index += 1;
        const escaped = source[index];
        if (escaped === '\\' || escaped === '{' || escaped === '}') {
            if (!state.skip) output += escaped;
            index += 1;
            continue;
        }
        if (escaped === '*') {
            state.skip = true;
            index += 1;
            continue;
        }
        if (escaped === "'") {
            const hex = source.slice(index + 1, index + 3);
            if (!state.skip && /^[0-9a-f]{2}$/i.test(hex)) output += Buffer.from([Number.parseInt(hex, 16)]).toString('latin1');
            index += 3;
            continue;
        }
        if (!/[a-z]/i.test(escaped ?? '')) {
            index += 1;
            continue;
        }

        const wordStart = index;
        while (/[a-z]/i.test(source[index] ?? '')) index += 1;
        const word = source.slice(wordStart, index).toLowerCase();
        let sign = 1;
        if (source[index] === '-') {
            sign = -1;
            index += 1;
        }
        const numberStart = index;
        while (/\d/.test(source[index] ?? '')) index += 1;
        const hasNumber = index > numberStart;
        const number = hasNumber ? sign * Number(source.slice(numberStart, index)) : null;
        if (source[index] === ' ') index += 1;

        if (RTF_DESTINATIONS.has(word)) state.skip = true;
        if (state.skip) continue;
        if (word === 'uc' && number !== null) {
            state.unicodeFallback = Math.max(0, Math.min(8, number));
            continue;
        }
        if (word === 'u' && number !== null) {
            output += String.fromCodePoint(number < 0 ? number + 65_536 : number);
            let skipped = 0;
            while (skipped < state.unicodeFallback && index < source.length && !'{}\\'.includes(source[index])) {
                skipped += 1;
                index += 1;
            }
            continue;
        }
        output += controlWordCharacter(word);
    }

    const content = normalizeExtractedText(output);
    if (!content) throw new Error('No readable text was found in this RTF document.');
    return { content, metadata: {} };
}
