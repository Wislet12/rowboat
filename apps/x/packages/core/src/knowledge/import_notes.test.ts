import { describe, expect, it } from 'vitest';

import {
    buildImportedNoteMarkdown,
    getImportStrategy,
    normalizeBrainImportFolder,
} from './import_notes.js';

describe('Brain note imports', () => {
    it('routes common note formats to local or model-backed extraction', () => {
        expect(getImportStrategy('notes.md')).toBe('text');
        expect(getImportStrategy('notes.html')).toBe('html');
        expect(getImportStrategy('notes.pdf')).toBe('local-document');
        expect(getImportStrategy('slides.pptx')).toBe('model-document');
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
        });

        expect(markdown).toContain('type: brain');
        expect(markdown).toContain('source: file-import');
        expect(markdown).toContain('source_file: "knowledge/Brain/Imports/_sources/care-plan.docx"');
        expect(markdown).toContain('# Care Plan');
        expect(markdown).toContain('- Follow up Friday');
    });
});
