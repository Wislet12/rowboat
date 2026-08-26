import { describe, expect, it } from 'vitest';

import {
    buildImportedNoteMarkdown,
    getImportStrategy,
    hasMeaningfulImportedContent,
    normalizeBrainImportFolder,
    parseImportedSourceNote,
} from './import_notes.js';

describe('Brain note imports', () => {
    it('routes common note formats to local or model-backed extraction', () => {
        expect(getImportStrategy('notes.md')).toBe('text');
        expect(getImportStrategy('notes.html')).toBe('html');
        expect(getImportStrategy('notes.pdf')).toBe('local-document');
        expect(getImportStrategy('slides.pptx')).toBe('local-document');
        expect(getImportStrategy('lecture.pptm')).toBe('local-document');
        expect(getImportStrategy('handout.rtf')).toBe('local-document');
        expect(getImportStrategy('textbook.epub')).toBe('local-document');
        expect(getImportStrategy('lab.ipynb')).toBe('local-document');
        expect(getImportStrategy('notes.odt')).toBe('local-document');
        expect(getImportStrategy('legacy.doc')).toBe('model-document');
        expect(getImportStrategy('legacy.ppt')).toBe('model-document');
        expect(getImportStrategy('scan.png')).toBe('model-document');
        expect(getImportStrategy('legacy.unknown')).toBe('unknown');
    });

    it('keeps imports in Brain and rejects meeting/workspace destinations', () => {
        expect(normalizeBrainImportFolder()).toBe('knowledge/Brain/Imports');
        expect(normalizeBrainImportFolder('knowledge')).toBe('knowledge/Brain/Imports');
        expect(normalizeBrainImportFolder('knowledge/Projects')).toBe('knowledge/Projects');
        expect(() => normalizeBrainImportFolder('knowledge/Meetings/rowboat')).toThrow(/Meetings section/);
        expect(() => normalizeBrainImportFolder('knowledge/Workspace')).toThrow(/not Brain notes/);
        expect(() => normalizeBrainImportFolder('../outside')).toThrow(/knowledge folder/);
    });

    it('stores source provenance with extracted content for chat and voice context', () => {
        const markdown = buildImportedNoteMarkdown({
            title: 'Care Plan',
            body: '## Priorities\n\n- Follow up Friday',
            importedAt: '2026-08-19T12:00:00.000Z',
            sourceName: 'care-plan.docx',
            sourcePath: 'knowledge/Brain/Imports/_sources/care-plan.docx',
            sourceFormat: 'docx',
            sourceHash: 'abc123',
            extraction: 'local-parser',
        });

        expect(markdown).toContain('type: brain');
        expect(markdown).toContain('source: file-import');
        expect(markdown).toContain('source_file: "knowledge/Brain/Imports/_sources/care-plan.docx"');
        expect(markdown).toContain('extraction: "local-parser"');
        expect(markdown).toContain('# Care Plan');
        expect(markdown).toContain('- Follow up Friday');
    });

    it('resolves an imported source to its editable extracted-note context', () => {
        const markdown = buildImportedNoteMarkdown({
            title: 'Lecture 7',
            body: '## Renal review\n\n- Know the nephron flow',
            importedAt: '2026-08-26T12:00:00.000Z',
            sourceName: 'lecture-7.pdf',
            sourcePath: 'knowledge/Brain/Imports/_sources/lecture-7.pdf',
            sourceFormat: 'pdf',
            sourceHash: 'def456',
            extraction: 'local-parser',
        });

        const context = parseImportedSourceNote('knowledge/Brain/Imports/Lecture 7.md', markdown);
        expect(context).toMatchObject({
            sourcePath: 'knowledge/Brain/Imports/_sources/lecture-7.pdf',
            notePath: 'knowledge/Brain/Imports/Lecture 7.md',
            title: 'Lecture 7',
            contentReadable: true,
        });
        expect(context?.content).toContain('Know the nephron flow');
        expect(context?.metadata.source_format).toBe('"pdf"');
    });

    it('does not treat ordinary Markdown as imported-source context', () => {
        expect(parseImportedSourceNote('knowledge/Brain/freeform.md', '# Freeform')).toBeNull();
    });

    it('rejects page markers and placeholders as readable imported content', () => {
        expect(hasMeaningfulImportedContent('-- 1 of 1 --')).toBe(false);
        expect(hasMeaningfulImportedContent('_No extractable text was found in this file._')).toBe(false);
        expect(hasMeaningfulImportedContent('## Dose\n\n5 mg daily')).toBe(true);
    });
});
