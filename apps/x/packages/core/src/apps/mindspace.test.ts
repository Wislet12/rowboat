import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let workDir = ''

beforeEach(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rowboat-mindspace-'))
  process.env.ROWBOAT_WORKDIR = workDir
  process.env.ROWBOAT_MINDSPACE_ASSETS_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../apps/main/mindspace-assets',
  )
  vi.resetModules()
})

afterEach(async () => {
  delete process.env.ROWBOAT_WORKDIR
  delete process.env.ROWBOAT_MINDSPACE_ASSETS_DIR
  vi.resetModules()
  await fsp.rm(workDir, { recursive: true, force: true })
})

describe('first-class Mindspace', () => {
  it('materializes durable assets without replacing existing data', async () => {
    const existing = {
      updatedAt: '2026-08-26T00:00:00.000Z',
      maps: [],
      brainstorm: [],
      notes: [{
        id: 'kept',
        title: 'Existing journal',
        body: 'Do not replace me',
        createdAt: '2026-08-26T00:00:00.000Z',
      }],
      lastSelection: { kind: 'notes', id: 'kept' },
    }
    const appRoot = path.join(workDir, 'apps', 'mindspace')
    await fsp.mkdir(path.join(appRoot, 'data'), { recursive: true })
    await fsp.mkdir(path.join(appRoot, 'dist'), { recursive: true })
    await fsp.writeFile(path.join(appRoot, 'dist', 'index.html'), 'upstream')
    await fsp.writeFile(path.join(appRoot, 'data', 'state.json'), JSON.stringify(existing))

    const mindspace = await import('./mindspace.js')
    await mindspace.ensureFirstClassMindspaceApp()

    expect(await fsp.readFile(path.join(appRoot, 'dist', 'index.html'), 'utf8')).toContain('Mindspace')
    const bundledApp = await fsp.readFile(path.join(appRoot, 'dist', 'app.js'), 'utf8')
    expect(bundledApp).toContain("window.addEventListener('rowboat:data-change', (event)")
    expect(bundledApp).toContain('event.preventDefault()')
    expect(bundledApp).toContain("interaction.type === 'connect'")
    expect(await fsp.readFile(path.join(appRoot, '.mindspace-upstream-backup', 'index.html'), 'utf8')).toBe('upstream')
    expect(JSON.parse(await fsp.readFile(path.join(appRoot, 'rowboat-app.json'), 'utf8')).name).toBe('mindspace')
    expect((await mindspace.readMindspaceState()).notes[0]?.body).toBe('Do not replace me')
  })

  it('supports bounded agent changes, persistent connections, stars, and safe Brain deletion scopes', async () => {
    const mindspace = await import('./mindspace.js')
    await mindspace.ensureFirstClassMindspaceApp()

    const created = await mindspace.runMindspaceAction({
      action: 'create',
      kind: 'map',
      title: 'Cardiac review',
      text: 'Heart failure',
    })
    const map = created.item as { id: string; nodes: Array<{ id: string }> }
    const rootNodeId = map.nodes[0].id
    const withNode = await mindspace.runMindspaceAction({
      action: 'add-node',
      kind: 'map',
      itemId: map.id,
      sourceNodeId: rootNodeId,
      text: 'Fluid overload',
    })
    const updatedMap = withNode.item as { nodes: Array<{ id: string }>; edges: Array<[string, string]> }
    expect(updatedMap.nodes).toHaveLength(2)
    expect(updatedMap.edges).toHaveLength(1)

    await mindspace.runMindspaceAction({
      action: 'update-item',
      kind: 'map',
      itemId: map.id,
      starred: true,
    })
    const linked = await mindspace.runMindspaceAction({ action: 'add-to-brain', kind: 'map', itemId: map.id })
    const linkedMap = linked.item as { brainPath: string }
    const brainAbsolute = path.join(workDir, ...linkedMap.brainPath.split('/'))
    const brainText = await fsp.readFile(brainAbsolute, 'utf8')
    expect(brainText).toContain('Heart failure')
    expect(brainText).toContain('Fluid overload')
    expect(brainText).toContain('Connections')

    const context = await mindspace.getMindspaceContext()
    expect(context.selectedKind).toBe('map')
    expect(context.content).toContain('Cardiac review')

    const deleted = await mindspace.runMindspaceAction({ action: 'delete-item', kind: 'map', itemId: map.id })
    expect(deleted.brainCopyKept).toBe(true)
    expect(await fsp.readFile(brainAbsolute, 'utf8')).toContain('Heart failure')

    const note = await mindspace.runMindspaceAction({ action: 'create', kind: 'notes', title: 'Temporary', body: 'Remove both' })
    const noteItem = note.item as { id: string }
    const linkedNote = await mindspace.runMindspaceAction({ action: 'add-to-brain', kind: 'notes', itemId: noteItem.id })
    const noteBrainPath = (linkedNote.item as { brainPath: string }).brainPath
    await mindspace.runMindspaceAction({
      action: 'delete-item',
      kind: 'notes',
      itemId: noteItem.id,
      deleteEverywhere: true,
    })
    await expect(fsp.access(path.join(workDir, ...noteBrainPath.split('/')))).rejects.toThrow()
  })
})
