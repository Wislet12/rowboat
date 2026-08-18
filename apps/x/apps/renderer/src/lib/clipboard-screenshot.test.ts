import { describe, expect, it } from 'vitest'

import {
  clipboardScreenshotFiles,
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

  it('reads a native Windows screenshot from clipboard items when files is empty', () => {
    const screenshot = new File(['pixels'], 'image.png', { type: 'image/png' })
    const clipboard = {
      files: [] as unknown as FileList,
      items: [{
        kind: 'file',
        type: 'image/png',
        getAsFile: () => screenshot,
      }] as unknown as DataTransferItemList,
    }

    expect(clipboardScreenshotFiles(clipboard)).toEqual([screenshot])
  })

  it('falls back to clipboard files and ignores non-vision formats', () => {
    const screenshot = new File(['pixels'], 'capture.jpg', { type: 'image/jpeg' })
    const unsupported = new File(['pixels'], 'animation.gif', { type: 'image/gif' })
    const clipboard = {
      files: [screenshot, unsupported] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
    }

    expect(clipboardScreenshotFiles(clipboard)).toEqual([screenshot])
  })

  it('produces inline base64 and a preview URL from the pasted file', async () => {
    const file = new File(['hello'], 'image.png', { type: 'image/png' })
    await expect(readClipboardScreenshot(file)).resolves.toEqual({
      dataBase64: 'aGVsbG8=',
      dataUrl: 'data:image/png;base64,aGVsbG8=',
    })
  })
})
