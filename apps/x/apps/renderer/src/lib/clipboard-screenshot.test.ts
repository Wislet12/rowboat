import { describe, expect, it } from 'vitest'

import {
  clipboardScreenshotName,
  isSupportedClipboardScreenshot,
  readClipboardScreenshot,
} from './clipboard-screenshot'

describe('clipboard screenshots', () => {
  it('accepts only the image formats supported by Rowboat chat vision', () => {
    expect(isSupportedClipboardScreenshot({ type: 'image/png' })).toBe(true)
    expect(isSupportedClipboardScreenshot({ type: 'image/jpeg' })).toBe(true)
    expect(isSupportedClipboardScreenshot({ type: 'image/webp' })).toBe(true)
    expect(isSupportedClipboardScreenshot({ type: 'image/gif' })).toBe(false)
    expect(isSupportedClipboardScreenshot({ type: 'text/plain' })).toBe(false)
  })

  it('gives anonymous clipboard images a stable screenshot name', () => {
    expect(clipboardScreenshotName(
      { name: 'image.png', type: 'image/png' },
      0,
      new Date('2026-08-17T12:34:56.789Z'),
    )).toBe('screenshot-2026-08-17_12-34-56-789.png')
  })

  it('produces inline base64 and a preview URL from the pasted file', async () => {
    const file = new File(['hello'], 'image.png', { type: 'image/png' })
    await expect(readClipboardScreenshot(file)).resolves.toEqual({
      dataBase64: 'aGVsbG8=',
      dataUrl: 'data:image/png;base64,aGVsbG8=',
    })
  })
})
