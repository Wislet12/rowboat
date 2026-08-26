import yazl from 'yazl';
import { describe, expect, it } from 'vitest';

import {
    extractEpubArchive,
    extractJupyterNotebook,
    extractOpenDocumentArchive,
    extractPowerPointArchive,
    extractRtfText,
} from './document_extractors.js';

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

describe('local note document extractors', () => {
    it('extracts ordered PowerPoint slides and speaker notes', async () => {
        const archive = await createZip({
            'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Cardiac output</a:t></a:r></a:p><a:p><a:r><a:t>CO = HR × SV</a:t></a:r></a:p></p:sld>',
            'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Preload &amp; afterload</a:t></a:r></a:p></p:sld>',
            'ppt/notesSlides/notesSlide1.xml': '<p:notes><a:p><a:r><a:t>Explain stroke volume first.</a:t></a:r></a:p></p:notes>',
        });

        const parsed = await extractPowerPointArchive(archive);
        expect(parsed.content).toContain('## Slide 1');
        expect(parsed.content).toContain('Cardiac output');
        expect(parsed.content).toContain('CO = HR × SV');
        expect(parsed.content).toContain('### Speaker notes');
        expect(parsed.content).toContain('## Slide 2');
        expect(parsed.content).toContain('Preload & afterload');
        expect(parsed.metadata).toMatchObject({ slideCount: 2, notesSlideCount: 1 });
    });

    it('extracts OpenDocument text and presentation pages', async () => {
        const textArchive = await createZip({
            'content.xml': '<office:document><text:h text:outline-level="1">Renal review</text:h><text:p>Monitor intake and output.</text:p><text:list-item><text:p>Check creatinine</text:p></text:list-item></office:document>',
        });
        const presentationArchive = await createZip({
            'content.xml': '<office:document><draw:page draw:name="Assessment"><text:p>Airway first</text:p></draw:page><draw:page draw:name="Plan"><text:p>Reassess after intervention</text:p></draw:page></office:document>',
        });

        const text = await extractOpenDocumentArchive(textArchive, 'odt');
        const slides = await extractOpenDocumentArchive(presentationArchive, 'odp');
        expect(text.content).toContain('# Renal review');
        expect(text.content).toContain('Monitor intake and output.');
        expect(slides.content).toContain('## Slide 1 — Assessment');
        expect(slides.content).toContain('## Slide 2 — Plan');
        expect(slides.metadata).toMatchObject({ slideCount: 2 });
    });

    it('extracts EPUB chapters without retaining HTML markup', async () => {
        const archive = await createZip({
            'OEBPS/chapter-1.xhtml': '<html><body><h1>Safety</h1><p>Verify two identifiers.</p></body></html>',
            'OEBPS/chapter-2.xhtml': '<html><body><h1>Medication</h1><ul><li>Check allergies</li></ul></body></html>',
        });

        const parsed = await extractEpubArchive(archive);
        expect(parsed.content).toContain('Verify two identifiers.');
        expect(parsed.content).toContain('Check allergies');
        expect(parsed.content).not.toContain('<html>');
        expect(parsed.metadata).toMatchObject({ chapterCount: 2 });
    });

    it('extracts Markdown and code cells from Jupyter notebooks', () => {
        const parsed = extractJupyterNotebook(Buffer.from(JSON.stringify({
            metadata: { kernelspec: { language: 'python' } },
            cells: [
                { cell_type: 'markdown', source: ['# Hemodynamics\n', 'Review MAP.'] },
                { cell_type: 'code', source: ['map_value = (sbp + 2 * dbp) / 3'] },
            ],
        })));

        expect(parsed.content).toContain('# Hemodynamics');
        expect(parsed.content).toContain('```python');
        expect(parsed.content).toContain('map_value');
        expect(parsed.metadata).toMatchObject({ markdownCells: 1, codeCells: 1, language: 'python' });
    });

    it('extracts readable RTF paragraphs, Unicode, and bullets', () => {
        const parsed = extractRtfText(Buffer.from(
            String.raw`{\rtf1\ansi{\fonttbl{\f0 Arial;}}\f0 Nursing priorities\par \bullet\tab Airway\par Unicode: \u8804? 5}`,
            'latin1',
        ));

        expect(parsed.content).toContain('Nursing priorities');
        expect(parsed.content).toContain('•');
        expect(parsed.content).toContain('Airway');
        expect(parsed.content).toContain('≤ 5');
        expect(parsed.content).not.toContain('Arial');
    });
});
