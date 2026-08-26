import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppsView } from './apps-view'

vi.mock('@/components/apps/app-frame', () => ({
  AppFrame: ({ app, onBack }: { app: { folder: string }; onBack: () => void }) => (
    <div>
      <p>Open app: {app.folder}</p>
      <button type="button" onClick={onBack}>Back to apps</button>
    </div>
  ),
}))

vi.mock('@/components/apps/catalog', () => ({
  CatalogTab: () => <div>Catalog</div>,
}))

const mindspace = {
  folder: 'mindspace',
  kind: 'installed' as const,
  status: 'valid' as const,
  manifest: {
    name: 'Mindspace',
    description: 'Mindmaps, brainstorming, and notes',
    version: '0.1.0',
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { ipc: unknown }).ipc = {
    invoke: vi.fn(async (channel: string) => {
      if (channel === 'apps:list') return { apps: [mindspace], serverRunning: true }
      throw new Error(`Unexpected channel ${channel}`)
    }),
  }
})

afterEach(cleanup)

describe('AppsView navigation', () => {
  it('opens Mindspace directly and returns to the catalog when requested externally', async () => {
    const onSelectedAppChange = vi.fn()
    const { rerender } = render(
      <AppsView
        initialAppFolder="mindspace"
        initialVersion={1}
        onSelectedAppChange={onSelectedAppChange}
      />,
    )

    expect(await screen.findByText('Open app: mindspace')).toBeInTheDocument()
    await waitFor(() => expect(onSelectedAppChange).toHaveBeenLastCalledWith('mindspace'))

    rerender(
      <AppsView
        initialAppFolder={null}
        initialVersion={2}
        onSelectedAppChange={onSelectedAppChange}
      />,
    )

    expect(await screen.findByRole('heading', { name: 'Apps' })).toBeInTheDocument()
    await waitFor(() => expect(onSelectedAppChange).toHaveBeenLastCalledWith(null))
  })

  it('reports returning from Mindspace through the existing app-frame back action', async () => {
    const onSelectedAppChange = vi.fn()
    render(
      <AppsView
        initialAppFolder="mindspace"
        initialVersion={1}
        onSelectedAppChange={onSelectedAppChange}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Back to apps' }))

    expect(await screen.findByRole('heading', { name: 'Apps' })).toBeInTheDocument()
    await waitFor(() => expect(onSelectedAppChange).toHaveBeenLastCalledWith(null))
  })
})
