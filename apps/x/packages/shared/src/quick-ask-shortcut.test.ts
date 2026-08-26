import { describe, expect, it } from 'vitest'

import {
  DEFAULT_QUICK_ASK_SHORTCUT,
  eventCodeToShortcutKey,
  formatShortcut,
  isSystemReservedShortcut,
  normalizeShortcut,
  parseShortcut,
  shortcutChordCodes,
  shortcutModifierStates,
} from './quick-ask-shortcut.js'

describe('quick ask global shortcut', () => {
  it('keeps the Windows-safe default canonical and displayable', () => {
    expect(DEFAULT_QUICK_ASK_SHORTCUT).toBe('Alt+Shift+Space')
    expect(normalizeShortcut('shift+alt+space')).toBe(DEFAULT_QUICK_ASK_SHORTCUT)
    expect(formatShortcut(DEFAULT_QUICK_ASK_SHORTCUT, false)).toBe('Alt+Shift+Space')
  })

  it('requires a strong modifier and exactly one non-modifier key', () => {
    expect(parseShortcut('Shift+A')).toBeNull()
    expect(parseShortcut('Alt+Shift')).toBeNull()
    expect(parseShortcut('Alt+A+B')).toBeNull()
    expect(parseShortcut('Control+K')).toEqual({ modifiers: ['Control'], key: 'K' })
  })

  it('rejects system-reserved macOS chords without blocking Windows equivalents', () => {
    expect(isSystemReservedShortcut('Command+Space', 'darwin')).toBe(true)
    expect(isSystemReservedShortcut('Command+Space', 'win32')).toBe(false)
  })

  it('derives recorder and release-detection keys from the same accelerator', () => {
    expect(eventCodeToShortcutKey('Space')).toBe('Space')
    expect(shortcutChordCodes(DEFAULT_QUICK_ASK_SHORTCUT)).toEqual(
      expect.arrayContaining(['AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'Space']),
    )
    expect(shortcutModifierStates(DEFAULT_QUICK_ASK_SHORTCUT)).toEqual(['Alt', 'Shift'])
  })
})
