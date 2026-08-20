import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Message, MessageContent, MessageDownloadButton, MessageResponse, MessageSaveButton } from './message'

afterEach(cleanup)

describe('assistant response actions', () => {
  it('keeps assistant output cursor-selectable', () => {
    render(
      <Message from="assistant">
        <MessageContent>Selectable answer</MessageContent>
      </Message>,
    )

    expect(screen.getByText('Selectable answer')).toHaveClass('group-[.is-assistant]:select-text')
    expect(screen.getByText('Selectable answer')).toHaveClass('group-[.is-assistant]:cursor-text')
  })

  it('keeps rendered markdown and realtime transcript text cursor-selectable', () => {
    render(<MessageResponse>Realtime selectable answer</MessageResponse>)

    const renderedText = screen.getByText('Realtime selectable answer')
    expect(renderedText.closest('.select-text')).not.toBeNull()
    expect(renderedText.closest('.cursor-text')).not.toBeNull()
  })

  it('exports a single response in Word format', async () => {
    const invoke = vi.fn(async () => ({ success: true }))
    Object.defineProperty(window, 'ipc', {
      configurable: true,
      value: { invoke },
    })

    render(<MessageDownloadButton text={'# Result\nDone'} title="Result" />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Download response' }), {
      button: 0,
      ctrlKey: false,
    })
    fireEvent.click(await screen.findByText('Word (.docx)'))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('export:note', {
      markdown: '# Result\nDone',
      format: 'docx',
      title: 'Result',
    }))
  })

  it('saves a response into the active Rowboat notebook artifact collection', async () => {
    const invoke = vi.fn(async () => ({
      path: 'knowledge/Brain/Notebooks/review/Artifacts/result.md',
      title: 'Result',
    }))
    Object.defineProperty(window, 'ipc', {
      configurable: true,
      value: { invoke },
    })

    render(
      <MessageSaveButton
        text={'# Result\nGrounded answer [S1].'}
        title="Result"
        notebookPath="knowledge/Brain/Notebooks/review"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save response to notebook' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('knowledge:saveChatOutput', {
      markdown: '# Result\nGrounded answer [S1].',
      title: 'Result',
      notebookPath: 'knowledge/Brain/Notebooks/review',
    }))
  })
})
