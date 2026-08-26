import { describe, expect, it } from 'vitest';

import type { NotebookContextSnapshot } from './notebooks.js';
import { applyStudyRating, buildStudyCards, buildStudyQuiz } from './study.js';

function context(content: string): NotebookContextSnapshot {
    return {
        kind: 'notebook',
        path: 'knowledge/Brain/Notebooks/cardiac',
        contextId: 'cardiac@1',
        title: 'Cardiac Review',
        description: '',
        retrievalProfile: 'balanced',
        sources: [{
            id: 'S1',
            path: 'knowledge/Brain/Notebooks/cardiac/Sources/rhythm.md',
            title: 'Rhythm Notes',
            content,
            truncated: false,
            contextMode: 'full',
        }],
        selectedSourceCount: 1,
        unavailableSources: [],
        retrievalEvidence: {
            queryTermCount: 0,
            candidateChunkCount: 1,
            selectedChunkCount: 1,
            readableSourceCount: 1,
        },
        capturedAt: '2026-08-26T12:00:00.000Z',
    };
}

describe('Study workspace learning engine', () => {
    it('builds source-grounded cards with stable citations and no cross-source content', () => {
        const cards = buildStudyCards(context([
            '# Atrial fibrillation',
            'Atrial fibrillation is an irregularly irregular rhythm without consistent P waves.',
            '',
            '# Rate control',
            'Beta blockers may reduce ventricular response when clinically appropriate.',
        ].join('\n')));

        expect(cards.length).toBeGreaterThanOrEqual(2);
        expect(cards[0]).toMatchObject({ sourceId: 'S1', sourceTitle: 'Rhythm Notes' });
        expect(cards.map((card) => card.back).join(' ')).not.toContain('OTHER_NOTEBOOK_FACT');
        const stableSource = '# Atrial fibrillation\nA stable, source-grounded explanation with enough detail for active recall.';
        expect(buildStudyCards(context(stableSource))[0]?.id)
            .toBe(buildStudyCards(context(stableSource))[0]?.id);
    });

    it('creates deterministic quizzes whose correct answer remains traceable to the card source', () => {
        const cards = buildStudyCards(context([
            '# Atrial fibrillation',
            'An irregularly irregular rhythm without consistent P waves is characteristic.',
            '# Sinus rhythm',
            'A regular rhythm with a P wave before each QRS complex is characteristic.',
            '# Ventricular fibrillation',
            'Chaotic ventricular electrical activity produces no effective cardiac output.',
        ].join('\n')));
        const first = buildStudyQuiz(cards);
        const second = buildStudyQuiz(cards);

        expect(first.length).toBeGreaterThan(0);
        expect(first).toEqual(second);
        expect(first[0].options[first[0].correctIndex]).toBeTruthy();
        expect(first[0].sourceId).toBe('S1');
    });

    it('schedules missed cards sooner and advances remembered cards', () => {
        const now = new Date('2026-08-26T12:00:00.000Z');
        const missed = applyStudyRating(undefined, 'again', now);
        const good = applyStudyRating(undefined, 'good', now);
        const easy = applyStudyRating(undefined, 'easy', now);

        expect(missed.lapses).toBe(1);
        expect(missed.intervalDays).toBe(0);
        expect(new Date(good.dueAt ?? 0).getTime()).toBeGreaterThan(now.getTime());
        expect(new Date(easy.dueAt ?? 0).getTime()).toBeGreaterThan(new Date(good.dueAt ?? 0).getTime());
    });
});
