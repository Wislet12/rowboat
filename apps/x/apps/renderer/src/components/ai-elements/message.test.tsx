import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Message, MessageContent, MessageDownloadButton } from './message'

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
})
