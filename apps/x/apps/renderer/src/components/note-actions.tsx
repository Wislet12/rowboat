import { useEffect, useRef, useState } from 'react'
import { Copy, Pencil, TextCursorInput, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

type NoteActionsProps = {
  path: string
  name: string
  onEdit: () => void
  onCopy: () => Promise<void>
  onRename: (name: string) => Promise<void>
  onDelete: () => Promise<void>
  className?: string
}

function editableName(name: string) {
  return name.replace(/\.md$/i, '')
}

export function NoteActions({
  path,
  name,
  onEdit,
  onCopy,
  onRename,
  onDelete,
  className,
}: NoteActionsProps) {
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [renameValue, setRenameValue] = useState(() => editableName(name))
  const [busy, setBusy] = useState<'copy' | 'rename' | 'delete' | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!renameOpen) return
    setRenameValue(editableName(name))
    requestAnimationFrame(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    })
  }, [name, renameOpen])

  const copy = async () => {
    if (busy) return
    setBusy('copy')
    try {
      await onCopy()
      toast.success('Note copied')
    } catch (err) {
      console.error(`Failed to copy note ${path}:`, err)
      toast.error('Failed to copy note')
    } finally {
      setBusy(null)
    }
  }

  const rename = async () => {
    const nextName = renameValue.trim()
    if (!nextName || busy) return
    setBusy('rename')
    try {
      await onRename(nextName)
      setRenameOpen(false)
      toast.success('Note renamed')
    } catch (err) {
      console.error(`Failed to rename note ${path}:`, err)
      toast.error('Failed to rename note')
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (busy) return
    setBusy('delete')
    try {
      await onDelete()
      setDeleteOpen(false)
      toast.success('Note moved to trash')
    } catch (err) {
      console.error(`Failed to delete note ${path}:`, err)
      toast.error('Failed to delete note')
    } finally {
      setBusy(null)
    }
  }

  const stopPropagation = (event: React.SyntheticEvent) => event.stopPropagation()

  return (
    <>
      <div className={cn('flex shrink-0 items-center gap-0.5', className)} onClick={stopPropagation} onKeyDown={stopPropagation}>
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => void copy()} disabled={Boolean(busy)} aria-label={`Copy ${name}`} title="Copy note">
          <Copy className="size-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onEdit} disabled={Boolean(busy)} aria-label={`Edit ${name}`} title="Edit note">
          <Pencil className="size-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => setRenameOpen(true)} disabled={Boolean(busy)} aria-label={`Rename ${name}`} title="Rename note">
          <TextCursorInput className="size-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => setDeleteOpen(true)} disabled={Boolean(busy)} aria-label={`Delete ${name}`} title="Delete note" className="hover:text-destructive">
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      <Dialog open={renameOpen} onOpenChange={(open) => { if (!busy) setRenameOpen(open) }}>
        <DialogContent onClick={stopPropagation}>
          <DialogHeader>
            <DialogTitle>Rename note</DialogTitle>
            <DialogDescription>Change the note name. Links and open tabs will follow the renamed file.</DialogDescription>
          </DialogHeader>
          <Input
            ref={renameInputRef}
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void rename()
              }
            }}
            aria-label="Note name"
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRenameOpen(false)} disabled={Boolean(busy)}>Cancel</Button>
            <Button type="button" onClick={() => void rename()} disabled={!renameValue.trim() || Boolean(busy)}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={(open) => { if (!busy) setDeleteOpen(open) }}>
        <AlertDialogContent onClick={stopPropagation}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{editableName(name)}”?</AlertDialogTitle>
            <AlertDialogDescription>The note will be moved to the system trash so it can be recovered if needed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busy)}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={(event) => { event.preventDefault(); void remove() }} disabled={Boolean(busy)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
