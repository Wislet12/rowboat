import { describe, expect, it } from 'vitest'

import { convertFromMessages } from './message-encoding.js'

describe('clipboard screenshot message encoding', () => {
  it('sends pasted screenshots as real multimodal file parts with a truthful label', () => {
    const [encoded] = convertFromMessages([{
      role: 'user',
      content: [
        { type: 'text', text: 'What does this error mean?' },
        {
          type: 'image',
          data: 'c2NyZWVuc2hvdA==',
          mediaType: 'image/png',
          source: 'clipboard',
          capturedAt: '2026-08-17T12:00:00.000Z',
        },
      ],
    }])

    expect(encoded.role).toBe('user')
    expect(Array.isArray(encoded.content)).toBe(true)
    expect(JSON.stringify(encoded.content)).toContain('Pasted screenshots:')
    expect(JSON.stringify(encoded.content)).toContain('screenshot pasted from the clipboard')
    expect(encoded.content).toContainEqual({
      type: 'file',
      data: 'c2NyZWVuc2hvdA==',
      mediaType: 'image/png',
    })
  })
})
