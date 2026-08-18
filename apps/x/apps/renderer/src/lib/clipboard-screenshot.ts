const SUPPORTED_SCREENSHOT_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
])

const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

export function isSupportedClipboardScreenshot(file: Pick<File, 'type'>): boolean {
  return SUPPORTED_SCREENSHOT_MIMES.has(file.type.toLowerCase())
}

type ClipboardImageSource = Pick<DataTransfer, 'files' | 'items'>

export function clipboardScreenshotFiles(clipboard: ClipboardImageSource): File[] {
  // Chromium exposes a bitmap copied by Snipping Tool/Print Screen through
  // DataTransferItemList on Windows. DataTransfer.files is often empty for
  // that native clipboard shape, even though synthetic paste events populate
  // it. Prefer items, then retain files as the drag/file-copy fallback.
  const itemFiles = Array.from(clipboard.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
    .filter(isSupportedClipboardScreenshot)

  if (itemFiles.length > 0) return itemFiles

  return Array.from(clipboard.files ?? [])
    .filter(isSupportedClipboardScreenshot)
}

export function clipboardScreenshotName(
  file: Pick<File, 'name' | 'type'>,
  index: number,
  capturedAt: Date = new Date(),
): string {
  const suppliedName = file.name.trim()
  if (suppliedName && suppliedName !== 'image.png') return suppliedName

  const timestamp = capturedAt.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const suffix = index > 0 ? `-${index + 1}` : ''
  return `screenshot-${timestamp}${suffix}.${MIME_EXTENSION[file.type.toLowerCase()] ?? 'png'}`
}

export async function readClipboardScreenshot(file: File): Promise<{ dataBase64: string; dataUrl: string }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read pasted screenshot.'))
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Pasted screenshot did not produce image data.'))
    }
    reader.readAsDataURL(file)
  })
  const separator = dataUrl.indexOf(',')
  if (separator < 0) throw new Error('Pasted screenshot data was malformed.')
  return { dataBase64: dataUrl.slice(separator + 1), dataUrl }
}
