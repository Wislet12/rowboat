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

  it('routes an insufficient imported-document extraction through LLMParse', () => {
    const [encoded] = convertFromMessages([{
      role: 'user',
      content: 'What should I do next?',
      userMessageContext: {
        middlePane: {
          kind: 'note',
          path: 'knowledge/Brain/Imports/_sources/scan.pdf',
          content: '-- 1 of 1 --',
          metadata: {
            context_extraction_status: 'needs-ocr',
            original_source_path: 'knowledge/Brain/Imports/_sources/scan.pdf',
          },
        },
      },
    }])

    expect(String(encoded.content)).toContain("call Rowboat's LLMParse tool")
    expect(String(encoded.content)).toContain('original_source_path')
    expect(String(encoded.content)).toContain('Do not say the document is unreadable')
  })
})

describe('active notebook context encoding', () => {
  it('grounds answers with stable citations and drops the previous notebook', () => {
    const encoded = convertFromMessages([
      {
        role: 'user',
        content: 'Summarize alpha',
        userMessageContext: {
          middlePane: {
            kind: 'notebook',
            path: 'knowledge/Brain/Notebooks/alpha',
            contextId: 'alpha@1',
            title: 'Alpha',
            sources: [{
              id: 'S1',
              path: 'knowledge/Brain/Notebooks/alpha/Sources/a.md',
              title: 'Alpha source',
              content: 'ALPHA_PRIVATE_FACT',
              truncated: false,
              contextMode: 'full',
            }],
            selectedSourceCount: 1,
            unavailableSources: [],
          },
        },
      },
      { role: 'assistant', content: 'Alpha summary.' },
      {
        role: 'user',
        content: 'Now answer from beta',
        userMessageContext: {
          middlePane: {
            kind: 'notebook',
            path: 'knowledge/Brain/Notebooks/beta',
            contextId: 'beta@2',
            title: 'Beta',
            query: 'answer from beta',
            sources: [{
              id: 'S2',
              path: 'knowledge/Brain/Notebooks/beta/Sources/b.md',
              title: 'Beta source',
              content: 'BETA_GROUNDED_FACT',
              truncated: true,
              contextMode: 'overview',
            }],
            selectedSourceCount: 1,
            unavailableSources: [],
          },
        },
      },
    ])

    const wire = JSON.stringify(encoded)
    expect(wire).not.toContain('ALPHA_PRIVATE_FACT')
    expect(wire).not.toContain('Alpha source')
    expect(wire).toContain('BETA_GROUNDED_FACT')
    expect(wire).toContain('[S2]')
    expect(wire).toContain('Never invent a citation')
    expect(wire).toContain('Discard every earlier note, notebook')
  })
})

describe('active Mindspace context encoding', () => {
  it('replaces the previous Mindspace selection without content bleed', () => {
    const encoded = convertFromMessages([
      {
        role: 'user',
        content: 'Discuss this map',
        userMessageContext: {
          middlePane: {
            kind: 'mindspace',
            contextId: 'mindspace@1',
            title: 'Alpha map',
            selectedKind: 'map',
            selectedId: 'alpha',
            content: 'ALPHA_MINDSPACE_PRIVATE',
            capturedAt: '2026-08-26T12:00:00.000Z',
          },
        },
      },
      { role: 'assistant', content: 'Done.' },
      {
        role: 'user',
        content: 'Now discuss this one',
        userMessageContext: {
          middlePane: {
            kind: 'mindspace',
            contextId: 'mindspace@2',
            title: 'Beta note',
            selectedKind: 'notes',
            selectedId: 'beta',
            content: 'BETA_MINDSPACE_CURRENT',
            capturedAt: '2026-08-26T12:01:00.000Z',
          },
        },
      },
    ])

    const wire = JSON.stringify(encoded)
    expect(wire).not.toContain('ALPHA_MINDSPACE_PRIVATE')
    expect(wire).toContain('BETA_MINDSPACE_CURRENT')
    expect(wire).toContain('only active Mindspace snapshot')
    expect(wire).toContain('Mindspace tool')
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


describe('deck context encoding', () => {
  it('renders the selected slide without displacing active-note isolation', () => {
    const [encoded] = convertFromMessages([{
      role: 'user',
      content: 'Update this slide',
      userMessageContext: {
        middlePane: {
          kind: 'deck',
          path: 'presentations/Q3 review.pptx',
          slideNumber: 2,
          slideCount: 9,
        },
      },
    }] as Parameters<typeof convertFromMessages>[0])
    const content = typeof encoded.content === 'string' ? encoded.content : JSON.stringify(encoded.content)
    expect(content).toContain('State: deck')
    expect(content).toContain('Path: presentations/Q3 review.pptx')
    expect(content).toContain('Slide: 2 of 9')
    expect(content).toContain('# User Message')
  })

  it('reports that sharing ended before any active pane snapshot', () => {
    const [encoded] = convertFromMessages([{
      role: 'user',
      content: 'What is on my screen?',
      userMessageContext: {
        screenShareEnded: true,
        middlePane: { kind: 'empty' },
      },
    }] as Parameters<typeof convertFromMessages>[0])
    const content = typeof encoded.content === 'string' ? encoded.content : JSON.stringify(encoded.content)
    expect(content).toContain('Screen sharing has ENDED')
    expect(content).toContain('State: empty')
  })
})
