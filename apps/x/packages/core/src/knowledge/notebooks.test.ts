import { describe, expect, it } from 'vitest';

import {
    buildNotebookContextFromManifest,
    findNotebookPath,
    isNotebookPath,
    type NotebookDescriptor,
} from './notebooks.js';

function notebook(
    path: string,
    title: string,
    sources: Array<{
        path: string;
        title: string;
        enabled?: boolean;
        contextMode?: 'off' | 'overview' | 'full';
    }>,
): NotebookDescriptor {
    return {
        path,
        version: 1,
        title,
        createdAt: '2026-08-19T12:00:00.000Z',
        updatedAt: '2026-08-19T12:00:00.000Z',
        sources: sources.map((source) => ({
            ...source,
            enabled: source.enabled ?? true,
            contextMode: source.contextMode ?? (source.enabled === false ? 'off' : 'full'),
            addedAt: '2026-08-19T12:00:00.000Z',
        })),
    };
}

describe('Brain notebooks', () => {
    it('recognizes only isolated notebook roots and resolves child source paths', () => {
        expect(isNotebookPath('knowledge/Brain/Notebooks/clinical-review')).toBe(true);
        expect(isNotebookPath('knowledge/Brain/Notebooks')).toBe(false);
        expect(isNotebookPath('knowledge/Brain/Notebooks/clinical-review/Sources')).toBe(false);
        expect(findNotebookPath('knowledge/Brain/Notebooks/clinical-review/Sources/labs.md'))
            .toBe('knowledge/Brain/Notebooks/clinical-review');
        expect(findNotebookPath('knowledge/Meetings/meeting.md')).toBeNull();
    });

    it('retrieves query-relevant chunks with stable source citation IDs', async () => {
        const manifest = notebook('knowledge/Brain/Notebooks/cardiac', 'Cardiac Review', [
            { path: 'knowledge/Brain/Notebooks/cardiac/Sources/rhythm.md', title: 'Rhythm Notes' },
            { path: 'knowledge/Brain/Notebooks/cardiac/Sources/meds.md', title: 'Medication Notes' },
        ]);
        const content = new Map([
            [manifest.sources[0].path, 'Atrial fibrillation produces an irregularly irregular rhythm.'],
            [manifest.sources[1].path, 'Metoprolol can reduce ventricular rate in selected patients.'],
        ]);

        const context = await buildNotebookContextFromManifest(
            manifest,
            'What does metoprolol do?',
            async (sourcePath) => content.get(sourcePath) ?? '',
        );

        expect(context.contextId).toContain('knowledge/Brain/Notebooks/cardiac@');
        expect(context.sources.map((source) => source.id)).toEqual(['S1', 'S2']);
        expect(context.sources[1]).toMatchObject({ id: 'S2', title: 'Medication Notes' });
        expect(context.sources[1].content).toMatch(/reduce ventricular rate/i);
    });

    it('replaces notebook context without source bleed-over', async () => {
        const alpha = notebook('knowledge/Brain/Notebooks/alpha', 'Alpha', [
            { path: 'knowledge/Brain/Notebooks/alpha/Sources/alpha.md', title: 'Alpha Source' },
        ]);
        const beta = notebook('knowledge/Brain/Notebooks/beta', 'Beta', [
            { path: 'knowledge/Brain/Notebooks/beta/Sources/beta.md', title: 'Beta Source' },
        ]);
        const read = async (sourcePath: string) => sourcePath.includes('/alpha/')
            ? 'ALPHA_ONLY_FACT'
            : 'BETA_ONLY_FACT';

        const first = await buildNotebookContextFromManifest(alpha, '', read);
        const second = await buildNotebookContextFromManifest(beta, '', read);

        expect(first.sources[0].content).toContain('ALPHA_ONLY_FACT');
        expect(second.sources[0].content).toContain('BETA_ONLY_FACT');
        expect(JSON.stringify(second)).not.toContain('ALPHA_ONLY_FACT');
        expect(second.path).toBe(beta.path);
    });

    it('omits disabled or newly inaccessible sources immediately', async () => {
        const manifest = notebook('knowledge/Brain/Notebooks/private', 'Private Review', [
            { path: 'knowledge/Brain/Notebooks/private/Sources/allowed.md', title: 'Allowed' },
            { path: 'knowledge/Brain/Notebooks/private/Sources/revoked.md', title: 'Revoked' },
            { path: 'knowledge/Brain/Notebooks/private/Sources/off.md', title: 'Disabled', enabled: false },
        ]);

        const context = await buildNotebookContextFromManifest(manifest, '', async (sourcePath) => {
            if (sourcePath.endsWith('/revoked.md')) throw new Error('permission revoked');
            return sourcePath.endsWith('/off.md') ? 'DISABLED_SECRET' : 'AUTHORIZED_FACT';
        });

        expect(context.selectedSourceCount).toBe(2);
        expect(context.sources).toHaveLength(1);
        expect(context.sources[0].content).toContain('AUTHORIZED_FACT');
        expect(JSON.stringify(context)).not.toContain('DISABLED_SECRET');
        expect(context.unavailableSources).toEqual([
            { path: manifest.sources[1].path, title: 'Revoked' },
        ]);
    });

    it('supports off, overview, and full source privacy levels', async () => {
        const manifest = notebook('knowledge/Brain/Notebooks/modes', 'Context Modes', [
            { path: 'knowledge/Brain/Notebooks/modes/Sources/full.md', title: 'Full', contextMode: 'full' },
            { path: 'knowledge/Brain/Notebooks/modes/Sources/overview.md', title: 'Overview', contextMode: 'overview' },
            { path: 'knowledge/Brain/Notebooks/modes/Sources/off.md', title: 'Off', enabled: false, contextMode: 'off' },
        ]);
        const longContent = `START_MARKER\n${'detail '.repeat(1_000)}\nEND_MARKER`;
        const context = await buildNotebookContextFromManifest(manifest, '', async (sourcePath) => (
            sourcePath.endsWith('/off.md') ? 'OFF_SECRET' : longContent
        ));

        expect(context.sources.find((source) => source.id === 'S1')?.content).toContain('END_MARKER');
        expect(context.sources.find((source) => source.id === 'S2')?.content).toContain('START_MARKER');
        expect(context.sources.find((source) => source.id === 'S2')?.content).not.toContain('END_MARKER');
        expect(context.sources.find((source) => source.id === 'S2')?.truncated).toBe(true);
        expect(JSON.stringify(context)).not.toContain('OFF_SECRET');
    });
});
