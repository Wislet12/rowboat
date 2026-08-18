import { describe, expect, it, vi } from 'vitest'

import { canAccessKnowledgeResult } from './search.js'

describe('knowledge search permissions', () => {
  it('re-checks the caller policy so revoked notes stop being searchable', async () => {
    let allowed = true
    const policy = vi.fn(() => allowed)
    const readable = vi.fn(() => true)
    const path = 'knowledge/Meetings/authorized-note.md'

    await expect(canAccessKnowledgeResult(path, {
      canAccessKnowledgePath: policy,
      canReadKnowledgeFile: readable,
    })).resolves.toBe(true)

    allowed = false
    await expect(canAccessKnowledgeResult(path, {
      canAccessKnowledgePath: policy,
      canReadKnowledgeFile: readable,
    })).resolves.toBe(false)
    expect(policy).toHaveBeenCalledWith(path)
    expect(readable).toHaveBeenCalledTimes(1)
  })

  it('rejects traversal and keeps meeting scope inside the Meetings tree', async () => {
    const allow = () => true
    await expect(canAccessKnowledgeResult('knowledge/../secrets.md', { canAccessKnowledgePath: allow })).resolves.toBe(false)
    await expect(canAccessKnowledgeResult('knowledge/Brain/private.md', {
      knowledgeScope: 'meetings',
      canAccessKnowledgePath: allow,
    })).resolves.toBe(false)
  })
})
