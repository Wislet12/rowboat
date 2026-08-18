import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NoteActions } from './note-actions'

afterEach(cleanup)

function renderActions() {
  const onEdit = vi.fn()
  const onCopy = vi.fn(async () => undefined)
  const onRename = vi.fn(async () => undefined)
  const onDelete = vi.fn(async () => undefined)
  render(
    <NoteActions
      path="knowledge/Meetings/2026-08-17/Standup.md"
      name="Standup.md"
      onEdit={onEdit}
      onCopy={onCopy}
      onRename={onRename}
      onDelete={onDelete}
    />,
  )
  return { onEdit, onCopy, onRename, onDelete }
}

describe('NoteActions', () => {
  it('exposes direct copy and edit controls', async () => {
    const { onCopy, onEdit } = renderActions()

    fireEvent.click(screen.getByRole('button', { name: 'Copy Standup.md' }))
    await waitFor(() => expect(onCopy).toHaveBeenCalledOnce())

    fireEvent.click(screen.getByRole('button', { name: 'Edit Standup.md' }))
    expect(onEdit).toHaveBeenCalledOnce()
  })

  it('renames through an editable confirmation dialog', async () => {
    const { onRename } = renderActions()
    fireEvent.click(screen.getByRole('button', { name: 'Rename Standup.md' }))
    const input = await screen.findByRole('textbox', { name: 'Note name' })
    fireEvent.change(input, { target: { value: 'Daily standup' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('Daily standup'))
  })

  it('requires confirmation before moving a note to trash', async () => {
    const { onDelete } = renderActions()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Standup.md' }))
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledOnce())
  })
})
