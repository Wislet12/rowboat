import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StudyView } from './study-view'

const NOTEBOOK_A = 'knowledge/Brain/Notebooks/Cardiac Review'
const NOTEBOOK_B = 'knowledge/Brain/Notebooks/Community Health'

const tree = [{
  path: 'knowledge/Brain/Notebooks',
  name: 'Notebooks',
  kind: 'dir' as const,
  children: [
    { path: NOTEBOOK_A, name: 'Cardiac Review', kind: 'dir' as const, children: [
      { path: `${NOTEBOOK_A}/Sources`, name: 'Sources', kind: 'dir' as const, children: [{ path: `${NOTEBOOK_A}/Sources/rhythm.md`, name: 'rhythm.md', kind: 'file' as const, stat: { size: 100, mtimeMs: 10 } }] },
      { path: `${NOTEBOOK_A}/Artifacts`, name: 'Artifacts', kind: 'dir' as const, children: [{ path: `${NOTEBOOK_A}/Artifacts/source-summary.md`, name: 'source-summary.md', kind: 'file' as const, stat: { size: 80, mtimeMs: 11 } }] },
    ] },
    { path: NOTEBOOK_B, name: 'Community Health', kind: 'dir' as const, children: [
      { path: `${NOTEBOOK_B}/Sources`, name: 'Sources', kind: 'dir' as const, children: [{ path: `${NOTEBOOK_B}/Sources/public-health.md`, name: 'public-health.md', kind: 'file' as const, stat: { size: 120, mtimeMs: 20 } }] },
    ] },
  ],
}]

function workspace(path: string, title: string, fact: string) {
  const sourcePath = `${path}/Sources/source.md`
  return {
    notebook: {
      path,
      version: 1 as const,
      title,
      description: '',
      retrievalProfile: 'balanced' as const,
      createdAt: '2026-08-26T12:00:00.000Z',
      updatedAt: '2026-08-26T12:00:00.000Z',
      sources: [{ path: sourcePath, title: `${title} source`, enabled: true, contextMode: 'full' as const, addedAt: '2026-08-26T12:00:00.000Z', available: true, modifiedAt: 1 }],
    },
    studySet: { id: 'default', title: `${title} study set`, description: '', sourcePaths: [sourcePath], activityConfig: { flashcardCount: 20, quizQuestionCount: 10, quizTypes: ['multiple-choice' as const], difficulty: 'adaptive' as const, topics: [], includeExplanations: true }, createdAt: '2026-08-26T12:00:00.000Z', updatedAt: '2026-08-26T12:00:00.000Z' },
    settings: { examDate: null, dailyGoalMinutes: 25, sessionMinutes: 25 },
    cards: [{ id: `${title}-card`, front: `Recall ${title}`, back: fact, sourceId: 'S1', sourcePath, sourceTitle: `${title} source` }],
    quiz: [],
    progress: { totalMinutes: 0, todayMinutes: 0, sessionsCompleted: 0, currentStreak: 0, reviewProgressPercent: 0, dueCount: 1, reviewedCount: 0, lastStudiedAt: null, nextDueAt: null, cardProgress: {} },
    unavailableSources: [],
    retrievalEvidence: { candidateChunkCount: 1, selectedChunkCount: 1, readableSourceCount: 1 },
    coverageNotice: 'Selected passages only.',
    lastRecoveryPath: null,
    generatedAt: '2026-08-26T12:00:00.000Z',
  }
}

const actions = {
  createNotebook: vi.fn(async (title: string) => `knowledge/Brain/Notebooks/${title}`),
  importNotes: vi.fn(async () => [] as string[]),
  updateNotebook: vi.fn(),
  deleteNotebook: vi.fn(async () => undefined),
  startStudyChat: vi.fn(),
  startStudyVoice: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(cleanup)

describe('StudyView', () => {
  it('makes existing Brain notebooks directly discoverable as study sets', () => {
    const onOpenNotebook = vi.fn()
    render(<StudyView tree={tree} notebookPath={null} actions={actions} onOpenNotebook={onOpenNotebook} onOpenNotebookStudio={vi.fn()} onOpenNote={vi.fn()} onOpenSearch={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'Study' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Cardiac Review/ }))
    expect(onOpenNotebook).toHaveBeenCalledWith(NOTEBOOK_A)
  })

  it('starts grounded chat and voice from the active study set', async () => {
    ;(window as unknown as { ipc: unknown }).ipc = {
      invoke: vi.fn(async (channel: string, args: { path: string }) => {
        if (channel === 'knowledge:study:listSets') return [workspace(args.path, 'Cardiac Review', '').studySet]
        if (channel === 'knowledge:study:getWorkspace') return workspace(args.path, 'Cardiac Review', 'CARDIAC_ONLY_FACT')
        throw new Error(`Unexpected channel ${channel}`)
      }),
    }
    render(<StudyView tree={tree} notebookPath={NOTEBOOK_A} actions={actions} onOpenNotebook={vi.fn()} onOpenNotebookStudio={vi.fn()} onOpenNote={vi.fn()} onOpenSearch={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: /Cardiac Review study set/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Tutor in chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start voice tutor' }))

    expect(actions.startStudyChat).toHaveBeenCalledOnce()
    expect(actions.startStudyChat.mock.calls[0][0]).toContain('active study set')
    expect(actions.startStudyVoice).toHaveBeenCalledOnce()
  })

  it('preserves Notebook Studio tools and organizes saved artifacts in Study', async () => {
    ;(window as unknown as { ipc: unknown }).ipc = {
      invoke: vi.fn(async (channel: string, args: { path: string }) => channel === 'knowledge:study:listSets' ? [workspace(args.path, 'Cardiac Review', '').studySet] : workspace(args.path, 'Cardiac Review', 'CARDIAC_ONLY_FACT')),
    }
    const onOpenNote = vi.fn()
    render(<StudyView tree={tree} notebookPath={NOTEBOOK_A} actions={actions} onOpenNotebook={vi.fn()} onOpenNotebookStudio={vi.fn()} onOpenNote={onOpenNote} onOpenSearch={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: /Cardiac Review study set/ }))
    expect(await screen.findByText('Notebook Studio connected')).toBeInTheDocument()
    for (const tool of ['Source summary', 'Study guide', 'FAQ', 'Timeline', 'Compare sources', 'Quiz me']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${tool}\\b`, 'i') })).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('button', { name: /Source summary/i }))
    expect(actions.startStudyChat).toHaveBeenCalledWith(expect.stringContaining('cite every factual claim'))

    fireEvent.click(screen.getByRole('button', { name: /source-summary/i }))
    expect(onOpenNote).toHaveBeenCalledWith(`${NOTEBOOK_A}/Artifacts/source-summary.md`)
  })

  it('switches notebook context without showing the prior notebook', async () => {
    let resolveFirst: ((value: ReturnType<typeof workspace>) => void) | undefined
    const first = new Promise<ReturnType<typeof workspace>>((resolve) => { resolveFirst = resolve })
    ;(window as unknown as { ipc: unknown }).ipc = {
      invoke: vi.fn(async (channel: string, args: { path: string }) => {
        if (channel === 'knowledge:study:listSets') return [workspace(args.path, args.path === NOTEBOOK_A ? 'Cardiac Review' : 'Community Health', '').studySet]
        if (args.path === NOTEBOOK_A) return first
        return workspace(NOTEBOOK_B, 'Community Health', 'COMMUNITY_ONLY_FACT')
      }),
    }
    const props = { tree, actions, onOpenNotebook: vi.fn(), onOpenNotebookStudio: vi.fn(), onOpenNote: vi.fn(), onOpenSearch: vi.fn() }
    const { rerender } = render(<StudyView {...props} notebookPath={NOTEBOOK_A} />)
    rerender(<StudyView {...props} notebookPath={NOTEBOOK_B} />)

    expect(await screen.findByRole('heading', { name: 'Community Health' })).toBeInTheDocument()
    resolveFirst?.(workspace(NOTEBOOK_A, 'Cardiac Review', 'CARDIAC_ONLY_FACT'))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Cardiac Review' })).not.toBeInTheDocument())
  })
})
