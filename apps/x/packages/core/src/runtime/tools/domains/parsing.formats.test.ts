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

    it('extracts CSV, RTF, OpenDocument, EPUB, and Jupyter notes locally', async () => {
        const directory = await temporaryDirectory();
        const fixtures: Array<{ name: string; data: Buffer; expected: string }> = [
            {
                name: 'medications.csv',
                data: Buffer.from('Medication,Dose\nAspirin,81 mg\n'),
                expected: 'Aspirin',
            },
            {
                name: 'priorities.rtf',
                data: Buffer.from(String.raw`{\rtf1\ansi Nursing priorities\par Airway first}`),
                expected: 'Airway first',
            },
            {
                name: 'renal-notes.odt',
                data: await createZip({
                    'content.xml': '<office:document><text:h text:outline-level="1">Renal review</text:h><text:p>Monitor intake and output.</text:p></office:document>',
                }),
                expected: 'Monitor intake and output.',
            },
            {
                name: 'assessment.odp',
                data: await createZip({
                    'content.xml': '<office:document><draw:page draw:name="Assessment"><text:p>Airway first</text:p></draw:page></office:document>',
                }),
                expected: 'Airway first',
            },
            {
                name: 'safety.epub',
                data: await createZip({
                    'OEBPS/chapter.xhtml': '<html><body><h1>Safety</h1><p>Verify two identifiers.</p></body></html>',
                }),
                expected: 'Verify two identifiers.',
            },
            {
                name: 'hemodynamics.ipynb',
                data: Buffer.from(JSON.stringify({
                    metadata: { kernelspec: { language: 'python' } },
                    cells: [{ cell_type: 'markdown', source: ['Review mean arterial pressure.'] }],
                })),
                expected: 'mean arterial pressure',
            },
        ];

        for (const fixture of fixtures) {
            const filePath = path.join(directory, fixture.name);
            await fs.writeFile(filePath, fixture.data);
            const parsed = await parseFileLocally(filePath);
            expect(parsed.success, `${fixture.name}: ${parsed.error ?? 'unknown error'}`).toBe(true);
            expect(parsed.content).toContain(fixture.expected);
        }
    });

    it('accepts every modern Office and OpenDocument extension routed to a local parser', async () => {
        const directory = await temporaryDirectory();
        const wordArchive = await createZip({
            '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
            '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
            'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word alias content</w:t></w:r></w:p></w:body></w:document>',
        });
        const presentationArchive = await createZip({
            'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Presentation alias content</a:t></a:r></a:p></p:sld>',
        });
        const textDocumentArchive = await createZip({
            'content.xml': '<office:document><text:p>OpenDocument text alias content</text:p></office:document>',
        });
        const presentationDocumentArchive = await createZip({
            'content.xml': '<office:document><draw:page draw:name="Alias"><text:p>OpenDocument presentation alias content</text:p></draw:page></office:document>',
        });
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Alias'], ['Spreadsheet content']]), 'Sheet1');
        const xlsxBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
        const xlsBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' }) as Buffer;
        const odsBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'ods' }) as Buffer;

        const cases: Array<{ extensions: string[]; data: Buffer; expected: string }> = [
            { extensions: ['docx', 'docm', 'dotx', 'dotm'], data: wordArchive, expected: 'Word alias content' },
            { extensions: ['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm'], data: presentationArchive, expected: 'Presentation alias content' },
            { extensions: ['xlsx', 'xlsm', 'xltx', 'xltm'], data: xlsxBuffer, expected: 'Spreadsheet content' },
            { extensions: ['xls'], data: xlsBuffer, expected: 'Spreadsheet content' },
            { extensions: ['ods', 'ots'], data: odsBuffer, expected: 'Spreadsheet content' },
            { extensions: ['odt', 'ott'], data: textDocumentArchive, expected: 'OpenDocument text alias content' },
            { extensions: ['odp', 'otp'], data: presentationDocumentArchive, expected: 'OpenDocument presentation alias content' },
        ];

        for (const testCase of cases) {
            for (const extension of testCase.extensions) {
                const filePath = path.join(directory, `notes.${extension}`);
                await fs.writeFile(filePath, testCase.data);
                const parsed = await parseFileLocally(filePath);
                expect(parsed.success, `${extension}: ${parsed.error ?? 'unknown error'}`).toBe(true);
                expect(parsed.format).toBe(extension);
                expect(parsed.content).toContain(testCase.expected);
            }
        }
    });

    const operatorPdfPath = process.env.ROWBOAT_VERIFY_PDF;
    if (operatorPdfPath) {
        it('extracts the operator-provided PDF used in packaged-app verification', async () => {
            const parsed = await parseFileLocally(operatorPdfPath);
            expect(parsed.success, parsed.error).toBe(true);
            expect(parsed.format).toBe('pdf');
            expect(parsed.content?.trim().length).toBeGreaterThan(0);
        });
    }
});
