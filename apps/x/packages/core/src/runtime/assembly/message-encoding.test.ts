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

describe('active note context encoding', () => {
  it('replaces the previous note snapshot when the user switches notes', () => {
    const encoded = convertFromMessages([
      {
        role: 'user',
        content: 'Summarize this note',
        userMessageContext: {
          middlePane: {
            kind: 'note',
            path: 'knowledge/Meetings/note-a.md',
            content: 'PRIVATE NOTE A CONTENT',
            contextId: 'knowledge/Meetings/note-a.md',
            title: 'Note A',
            noteType: 'meeting',
          },
        },
      },
      { role: 'assistant', content: 'Here is the first summary.' },
      {
        role: 'user',
        content: 'What are the action items now?',
        userMessageContext: {
          middlePane: {
            kind: 'note',
            path: 'knowledge/Meetings/note-b.md',
            content: 'NOTE B ACTION: ship Friday',
            contextId: 'knowledge/Meetings/note-b.md',
            title: 'Note B',
            noteType: 'meeting',
          },
        },
      },
    ])

    const wire = JSON.stringify(encoded)
    expect(wire).not.toContain('PRIVATE NOTE A CONTENT')
    expect(wire).not.toContain('knowledge/Meetings/note-a.md')
    expect(wire).toContain('NOTE B ACTION: ship Friday')
    expect(wire).toContain('replacement snapshot')
  })

  it('clears an earlier note when the newest turn reports an empty pane', () => {
    const encoded = convertFromMessages([
      {
        role: 'user',
        content: 'Read this',
        userMessageContext: {
          middlePane: {
            kind: 'note',
            path: 'knowledge/Meetings/old.md',
            content: 'OLD NOTE SECRET',
          },
        },
      },
      { role: 'assistant', content: 'Done.' },
      {
        role: 'user',
        content: 'What can you do?',
        userMessageContext: { middlePane: { kind: 'empty' } },
      },
    ])

    const wire = JSON.stringify(encoded)
    expect(wire).not.toContain('OLD NOTE SECRET')
    expect(wire).toContain('There is no active note')
  })

  it('includes metadata for the current note only', () => {
    const [encoded] = convertFromMessages([{
      role: 'user',
      content: 'Who attended?',
      userMessageContext: {
        middlePane: {
          kind: 'note',
          path: 'knowledge/Meetings/standup.md',
          content: '# Transcript\nHello',
          title: 'Standup',
          noteType: 'meeting',
          metadata: { attendees: ['Ada', 'Lin'], status: 'recorded' },
        },
      },
    }])

    expect(String(encoded.content)).toContain('"attendees"')
    expect(String(encoded.content)).toContain('recorded')
  })
})

describe('active browser context encoding', () => {
  it('keeps only the newest tab snapshot and marks page content untrusted', () => {
    const encoded = convertFromMessages([
      {
        role: 'user',
        content: 'Read this page',
        userMessageContext: {
          middlePane: {
            kind: 'browser',
            url: 'https://old.example',
            title: 'Old tab',
            tabId: 'old-tab',
            text: 'OLD PAGE CONTENT',
          },
        },
      },
      { role: 'assistant', content: 'Okay.' },
      {
        role: 'user',
        content: 'What does this selection mean?',
        userMessageContext: {
          middlePane: {
            kind: 'browser',
            url: 'https://new.example',
            title: 'New tab',
            tabId: 'new-tab',
            snapshotId: 'snapshot-new',
            selectedText: 'NEW SELECTED TEXT',
            text: 'NEW PAGE CONTENT',
            untrusted: true,
          },
        },
      },
    ])

    const wire = JSON.stringify(encoded)
    expect(wire).not.toContain('OLD PAGE CONTENT')
    expect(wire).not.toContain('old.example')
    expect(wire).toContain('NEW SELECTED TEXT')
    expect(wire).toContain('untrusted data')
    expect(wire).toContain('new-tab')
  })
})
