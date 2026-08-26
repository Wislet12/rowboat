import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yazl from 'yazl';
import { afterEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';

import { parseFileLocally } from './parsing.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rowboat-note-formats-'));
    temporaryDirectories.push(directory);
    return directory;
}

function createZip(entries: Record<string, string>): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const zip = new yazl.ZipFile();
        const chunks: Buffer[] = [];
        zip.outputStream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        zip.outputStream.on('error', reject);
        zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
        for (const [name, content] of Object.entries(entries)) zip.addBuffer(Buffer.from(content), name);
        zip.end();
    });
}

function createMinimalPdf(text: string): Buffer {
    const escaped = text.replace(/([\\()])/g, '\\$1');
    const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ];
    let document = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, index) => {
        offsets.push(Buffer.byteLength(document));
        document += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xrefOffset = Buffer.byteLength(document);
    document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    document += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
    document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    return Buffer.from(document);
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('local multi-format note parsing', () => {
    it('extracts real PDF text locally', async () => {
        const directory = await temporaryDirectory();
        const filePath = path.join(directory, 'cardiac-notes.pdf');
        await fs.writeFile(filePath, createMinimalPdf('Cardiac output equals heart rate times stroke volume'));

        const parsed = await parseFileLocally(filePath);
        expect(parsed.success, parsed.error).toBe(true);
        expect(parsed.format).toBe('pdf');
        expect(parsed.content).toContain('Cardiac output equals heart rate times stroke volume');
    });

    it('extracts real DOCX text locally', async () => {
        const directory = await temporaryDirectory();
        const filePath = path.join(directory, 'care-plan.docx');
        const archive = await createZip({
            '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
            '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
            'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Reassess pain after intervention</w:t></w:r></w:p></w:body></w:document>',
        });
        await fs.writeFile(filePath, archive);

        const parsed = await parseFileLocally(filePath);
        expect(parsed.success, parsed.error).toBe(true);
        expect(parsed.format).toBe('docx');
        expect(parsed.content).toContain('Reassess pain after intervention');
    });

    it('extracts real PowerPoint and spreadsheet content locally', async () => {
        const directory = await temporaryDirectory();
        const presentationPath = path.join(directory, 'lecture.pptx');
        await fs.writeFile(presentationPath, await createZip({
            'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Lecture objective: recognize shock</a:t></a:r></a:p></p:sld>',
        }));

        const workbookPath = path.join(directory, 'labs.xlsx');
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Test', 'Value'], ['Potassium', 4.2]]), 'Labs');
        await fs.writeFile(workbookPath, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));

        const presentation = await parseFileLocally(presentationPath);
        const spreadsheet = await parseFileLocally(workbookPath);
        expect(presentation.success, presentation.error).toBe(true);
        expect(presentation.content).toContain('recognize shock');
        expect(spreadsheet.success, spreadsheet.error).toBe(true);
        expect(spreadsheet.content).toContain('Potassium');
        expect(spreadsheet.content).toContain('4.2');
    });
});
