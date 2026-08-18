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
