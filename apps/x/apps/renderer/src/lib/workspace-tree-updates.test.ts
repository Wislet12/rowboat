import { describe, expect, it } from 'vitest'

import { touchWorkspaceTree } from './workspace-tree-updates'

describe('workspace tree content updates', () => {
  it('patches only the changed note instead of rebuilding unrelated branches', () => {
    const meeting = { path: 'knowledge/Meetings/live.md', stat: { size: 12, mtimeMs: 1 } }
    const brain = { path: 'knowledge/Brain/other.md', stat: { size: 8, mtimeMs: 2 } }
    const tree = [
      { path: 'knowledge/Meetings', children: [meeting] },
      { path: 'knowledge/Brain', children: [brain] },
    ]

    const next = touchWorkspaceTree(tree, new Set([meeting.path]), 99)
    expect(next).not.toBe(tree)
    expect(next[0].children?.[0].stat?.mtimeMs).toBe(99)
    expect(next[1]).toBe(tree[1])
    expect(next[1].children?.[0]).toBe(brain)
  })

  it('preserves references when the changed path is outside the visible tree', () => {
    const tree = [{ path: 'knowledge/Brain/note.md' }]
    expect(touchWorkspaceTree(tree, new Set(['config/settings.json']), 99)).toBe(tree)
  })
})
