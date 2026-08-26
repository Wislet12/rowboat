import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  BookOpen,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  FilePlus,
  FileText,
  FolderOpen,
  FolderPlus,
  MessageSquareText,
  Network,
  Pencil,
  Save,
  SearchIcon,
  Settings2,
  Table2,
  Trash2,
  Upload,
} from 'lucide-react'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Input } from '@/components/ui/input'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { VoiceNoteButton } from '@/components/sidebar-content'
import { NoteActions } from '@/components/note-actions'
import { StudyView } from '@/components/study-view'
import { formatRelativeTime } from '@/lib/relative-time'
import { NOTEBOOK_ARTIFACTS } from '@/lib/notebook-artifacts'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

interface TreeNode {
  path: string
  name: string
  kind: 'file' | 'dir'
  children?: TreeNode[]
  stat?: { size: number; mtimeMs: number }
}

type NotebookDescriptor = {
  path: string
  version: 1
  title: string
  description: string
  retrievalProfile: 'fast' | 'balanced' | 'precise'
  createdAt: string
  updatedAt: string
  sources: Array<{
    path: string
    title: string
    enabled: boolean
    contextMode: 'off' | 'overview' | 'full'
    addedAt: string
    sourceFilePath?: string
    format?: string
    contentLength?: number
    extraction?: 'plain-text' | 'local-parser' | 'model-vision'
    available: boolean
    modifiedAt: number | null
    size: number | null
  }>
}

export type KnowledgeViewActions = {
  createNote: (parentPath?: string) => void
  addGoogleDoc: (parentPath?: string) => void
  importNotes: (parentPath?: string) => Promise<string[]>
  createNotebook: (title: string) => Promise<string>
  getNotebook: (path: string) => Promise<NotebookDescriptor>
  updateNotebook: (path: string, input: { title: string; description: string; retrievalProfile: 'fast' | 'balanced' | 'precise' }) => Promise<NotebookDescriptor>
  deleteNotebook: (path: string) => Promise<void>
  setNotebookSourceEnabled: (path: string, sourcePath: string, enabled: boolean) => Promise<NotebookDescriptor>
  setNotebookSourceContextMode: (path: string, sourcePath: string, contextMode: 'off' | 'overview' | 'full') => Promise<NotebookDescriptor>
  updateNotebookSource: (path: string, sourcePath: string, title: string) => Promise<NotebookDescriptor>
  removeNotebookSource: (path: string, sourcePath: string) => Promise<NotebookDescriptor>
  askNotebook: (prompt: string) => void
  startStudyChat: (prompt: string) => void
  startStudyVoice: () => void
  createFolder: (parentPath?: string) => Promise<string>
  rename: (path: string, newName: string, isDir: boolean) => Promise<void>
  remove: (path: string) => Promise<void>
  copyPath: (path: string) => void
  copyNote: (path: string) => Promise<void>
  revealInFileManager: (path: string, isDir: boolean) => void
  onOpenInNewTab?: (path: string) => void
}

export type KnowledgeViewMode = 'graph' | 'basis' | 'files' | 'study'

type KnowledgeViewProps = {
  tree: TreeNode[]
  actions: KnowledgeViewActions
  mode: KnowledgeViewMode
  onModeChange: (mode: KnowledgeViewMode) => void
  graphContent: ReactNode
  basisContent: ReactNode
  // Folder currently being browsed (null = root overview). Controlled by the
  // app so drill-down participates in the global back/forward history.
  folderPath: string | null
  onNavigateFolder: (path: string | null) => void
  onOpenNote: (path: string) => void
  onOpenSearch: () => void
  onVoiceNoteCreated?: (path: string) => void
}

// Folders that have their own dedicated destinations elsewhere in the app.
const HIDDEN_PATHS = new Set(['knowledge/Meetings', 'knowledge/Workspace'])

function isNotebookFolderPath(path?: string | null): path is string {
  if (!path) return false
  return /^knowledge\/Brain\/Notebooks\/[^/]+$/.test(path.replace(/\\/g, '/').replace(/\/+$/g, ''))
}

// Theme-aware accent palette for folder avatars — colored letter on a faint
// tint of the same hue. Mirrors the design's six-colour rotation.

function isMarkdown(node: TreeNode): boolean {
  return node.kind === 'file' && node.name.toLowerCase().endsWith('.md')
}

// All markdown notes within a node (recurses into subfolders).
function collectNotes(node: TreeNode): TreeNode[] {
  if (node.kind === 'file') return isMarkdown(node) ? [node] : []
  const out: TreeNode[] = []
  for (const child of node.children ?? []) out.push(...collectNotes(child))
  return out
}

function recentNotes(node: TreeNode, limit: number): TreeNode[] {
  return collectNotes(node)
    .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0))
    .slice(0, limit)
}

function latestMtime(node: TreeNode): number {
  let max = node.stat?.mtimeMs ?? 0
  for (const child of node.children ?? []) max = Math.max(max, latestMtime(child))
  return max
}

function GoogleDriveIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path fill="#1FA463" d="M8.52 3.5h6.96l6.95 12.04h-6.96L8.52 3.5Z" />
      <path fill="#FFD04B" d="M1.57 15.54 8.52 3.5l3.48 6.02-3.48 6.02H1.57Z" />
      <path fill="#4688F1" d="M8.52 15.54h13.91L18.95 21H5.05l3.47-5.46Z" />
    </svg>
  )
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node
    if (node.children) {
      const found = findNode(node.children, path)
      if (found) return found
    }
  }
  return null
}

function formatModified(mtimeMs?: number): string {
  if (!mtimeMs) return ''
  const rel = formatRelativeTime(new Date(mtimeMs).toISOString())
  if (!rel || rel === 'just now') return rel
  return `${rel} ago`
}

function getFileManagerName(): string {
  if (typeof navigator === 'undefined') return 'File Manager'
  const platform = navigator.platform.toLowerCase()
  if (platform.includes('mac')) return 'Finder'
  if (platform.includes('win')) return 'Explorer'
  return 'File Manager'
}

function displayName(node: TreeNode): string {
  if (isMarkdown(node)) return node.name.slice(0, -3)
  return node.name
}

export function KnowledgeView({
  tree,
  actions,
  mode,
  onModeChange,
  graphContent,
  basisContent,
  folderPath,
  onNavigateFolder,
  onOpenNote,
  onOpenSearch,
  onVoiceNoteCreated,
}: KnowledgeViewProps) {
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [createNotebookOpen, setCreateNotebookOpen] = useState(false)

  const topLevel = useMemo(
    () => tree.filter((n) => !HIDDEN_PATHS.has(n.path)),
    [tree],
  )

  const folders = useMemo(
    () => sortNodes(topLevel.filter((n) => n.kind === 'dir')),
    [topLevel],
  )
  const looseNotes = useMemo(
    () => sortNodes(topLevel.filter((n) => isMarkdown(n))),
    [topLevel],
  )

  const totalNotes = useMemo(
    () => topLevel.reduce((sum, n) => sum + collectNotes(n).length, 0),
    [topLevel],
  )

  const openFolder = useCallback((path: string) => onNavigateFolder(path), [onNavigateFolder])

  // When the open folder no longer exists (deleted/renamed externally), fall
  // back to the root overview rather than holding a dangling drill-down.
  const currentFolder = folderPath ? findNode(tree, folderPath) : null
  const currentNotebookPath = isNotebookFolderPath(currentFolder?.path) ? currentFolder.path : null

  if (mode === 'study') {
    return (
      <StudyView
        tree={tree}
        notebookPath={currentNotebookPath}
        actions={actions}
        onOpenNotebook={onNavigateFolder}
        onOpenNotebookStudio={() => onModeChange('files')}
        onOpenNote={onOpenNote}
        onOpenSearch={onOpenSearch}
      />
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#f8f8f9] dark:bg-[#0b0b0d]">
      <div className="mx-auto w-full max-w-[1120px] shrink-0 flex items-start justify-between gap-4 px-[30px] pt-[34px] pb-5">
        <div className="min-w-0">
          <h1 className="text-[24px] font-[650] tracking-[-0.02em] text-[#0d0e11] dark:text-[#f4f5f7]">Brain</h1>
          <p className="mt-1 text-[14px] text-black/50 dark:text-white/[0.52]">
            {totalNotes} {totalNotes === 1 ? 'note' : 'notes'} across {folders.length}{' '}
            {folders.length === 1 ? 'folder' : 'folders'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-lg border border-border bg-background">
            <ViewModeButton
              icon={Network}
              label="Graph"
              active={mode === 'graph'}
              onClick={() => onModeChange('graph')}
            />
            <ViewModeButton
              icon={Table2}
              label="Base"
              active={mode === 'basis'}
              onClick={() => onModeChange('basis')}
            />
            <ViewModeButton
              icon={FileText}
              label="Files"
              active={mode === 'files'}
              onClick={() => onModeChange('files')}
            />
          </div>
          <button
            type="button"
            onClick={() => setCreateNotebookOpen(true)}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-foreground px-3 text-sm font-medium text-background transition-opacity hover:opacity-85"
            aria-label="Create a research notebook"
          >
            <BookOpen className="size-4" />
            New notebook
          </button>
          <button
            type="button"
            onClick={() => { void actions.importNotes(currentFolder?.path) }}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            aria-label={currentNotebookPath ? 'Add sources to notebook' : 'Import notes into Brain'}
          >
            <Upload className="size-4" />
            {currentNotebookPath ? 'Add sources' : 'Import'}
          </button>
          <VoiceNoteButton onNoteCreated={onVoiceNoteCreated} />
        </div>
      </div>

      {mode === 'graph' ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          {graphContent}
        </div>
      ) : mode === 'basis' ? (
        <div className="mx-auto flex w-full max-w-[1120px] flex-1 min-h-0 flex-col overflow-hidden px-[30px] pb-6">
          {basisContent}
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1120px] px-[30px] py-6">
          {currentFolder ? (
            currentNotebookPath ? (
              <NotebookDetail
                folder={currentFolder}
                actions={actions}
                onNavigate={onNavigateFolder}
                onOpenNote={onOpenNote}
              />
            ) : (
              <FolderDetail
                folder={currentFolder}
                actions={actions}
                renameTarget={renameTarget}
                onRequestRename={setRenameTarget}
                onClearRename={() => setRenameTarget(null)}
                onNavigate={onNavigateFolder}
                onOpenFolder={openFolder}
                onOpenNote={onOpenNote}
              />
            )
          ) : (
            <>
              <SectionHeader label={`Folders · ${folders.length}`} />
              {folders.length === 0 ? (
                <EmptyState text="No folders yet." />
              ) : (
                <div className="overflow-hidden rounded-xl border border-black/15 dark:border-border">
                  {folders.map((node, i) => (
                    <div key={node.path} className={cn(i > 0 && 'border-t border-border/60')}>
                      <FolderCard
                        node={node}
                        actions={actions}
                        renameTarget={renameTarget}
                        onRequestRename={setRenameTarget}
                        onClearRename={() => setRenameTarget(null)}
                        onOpenFolder={openFolder}
                        onOpenNote={onOpenNote}
                      />
                    </div>
                  ))}
                </div>
              )}

              {looseNotes.length > 0 && (
                <div className="mt-8">
                  <SectionHeader label={`Loose notes · ${looseNotes.length}`} />
                  <div className="overflow-hidden rounded-xl border border-black/15 dark:border-border">
                    {looseNotes.map((node, i) => (
                      <div key={node.path} className={cn(i > 0 && 'border-t border-border/60')}>
                        <ItemRow
                          node={node}
                          actions={actions}
                          renameTarget={renameTarget}
                          onRequestRename={setRenameTarget}
                          onClearRename={() => setRenameTarget(null)}
                          onOpenFolder={openFolder}
                          onOpenNote={onOpenNote}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {!currentNotebookPath && (
            <QuickActions
              actions={actions}
              currentFolder={currentFolder}
              onOpenSearch={onOpenSearch}
              onFolderCreated={setRenameTarget}
            />
          )}
        </div>
      </div>
      )}
      <CreateNotebookDialog
        open={createNotebookOpen}
        onOpenChange={setCreateNotebookOpen}
        onCreate={async (title) => {
          const path = await actions.createNotebook(title)
          onNavigateFolder(path)
        }}
      />
    </div>
  )
}

function CreateNotebookDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (title: string) => Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!open) setTitle('')
  }, [open])

  const submit = useCallback(async () => {
    const value = title.trim()
    if (!value || creating) return
    setCreating(true)
    try {
      await onCreate(value)
      onOpenChange(false)
      toast('Notebook created', 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not create notebook', 'error')
    } finally {
      setCreating(false)
    }
  }, [creating, onCreate, onOpenChange, title])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Create a research notebook</DialogTitle>
          <DialogDescription>
            Group related notes and files into one isolated source collection for grounded chat and voice.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit()
            }
          }}
          placeholder="e.g. Cardiac orientation"
          maxLength={120}
          aria-label="Notebook name"
        />
        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-9 rounded-lg border border-border px-4 text-sm font-medium text-foreground hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { void submit() }}
            disabled={!title.trim() || creating}
            className="h-9 rounded-lg bg-foreground px-4 text-sm font-medium text-background disabled:cursor-not-allowed disabled:opacity-40"
          >
            {creating ? 'Creating…' : 'Create notebook'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function NotebookDetail({
  folder,
  actions,
  onNavigate,
  onOpenNote,
}: {
  folder: TreeNode
  actions: KnowledgeViewActions
  onNavigate: (path: string | null) => void
  onOpenNote: (path: string) => void
}) {
  const [notebook, setNotebook] = useState<NotebookDescriptor | null>(null)
  const [loading, setLoading] = useState(true)
  const [busySource, setBusySource] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [sourceEditPath, setSourceEditPath] = useState<string | null>(null)
  const [sourceDeletePath, setSourceDeletePath] = useState<string | null>(null)
  const sourceRefreshKey = useMemo(
    () => collectNotes(folder).map((source) => `${source.path}:${source.stat?.mtimeMs ?? 0}`).join('|'),
    [folder],
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setNotebook(await actions.getNotebook(folder.path))
    } catch (error) {
      console.error('Failed to load notebook:', error)
      setNotebook(null)
    } finally {
      setLoading(false)
    }
  }, [actions, folder.path])

  useEffect(() => {
    void refresh()
  }, [refresh, sourceRefreshKey])

  const toggleSource = useCallback(async (sourcePath: string, enabled: boolean) => {
    if (!notebook || busySource) return
    setBusySource(sourcePath)
    try {
      setNotebook(await actions.setNotebookSourceEnabled(notebook.path, sourcePath, enabled))
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not update source selection', 'error')
    } finally {
      setBusySource(null)
    }
  }, [actions, busySource, notebook])

  const setSourceMode = useCallback(async (
    sourcePath: string,
    contextMode: 'off' | 'overview' | 'full',
  ) => {
    if (!notebook || busySource) return
    setBusySource(sourcePath)
    try {
      setNotebook(await actions.setNotebookSourceContextMode(notebook.path, sourcePath, contextMode))
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not update source context mode', 'error')
    } finally {
      setBusySource(null)
    }
  }, [actions, busySource, notebook])

  const editedSource = notebook?.sources.find((source) => source.path === sourceEditPath) ?? null
  const deletingSource = notebook?.sources.find((source) => source.path === sourceDeletePath) ?? null

  const selectedCount = notebook?.sources.filter((source) => source.enabled && source.contextMode !== 'off').length ?? 0

  return (
    <>
      <div className="mb-5 flex min-w-0 items-center gap-1.5 text-sm">
        <button
          type="button"
          onClick={() => onNavigate(null)}
          className="rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          Brain
        </button>
        <ChevronRight className="size-3.5 text-muted-foreground/50" />
        <button
          type="button"
          onClick={() => onNavigate('knowledge/Brain/Notebooks')}
          className="rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          Notebooks
        </button>
        <ChevronRight className="size-3.5 text-muted-foreground/50" />
        <span className="truncate font-medium text-foreground">{notebook?.title ?? folder.name}</span>
      </div>

      <section className="overflow-hidden rounded-2xl border border-black/10 bg-background shadow-sm dark:border-border">
        <div className="border-b border-border/70 bg-gradient-to-br from-violet-500/[0.09] via-blue-500/[0.05] to-transparent px-6 py-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-violet-600 dark:text-violet-300">
                <BookOpen className="size-4" />
                Notebook Studio
              </div>
              <h2 className="mt-2 truncate text-2xl font-semibold tracking-[-0.025em] text-foreground">
                {notebook?.title ?? folder.name}
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                {notebook?.description || 'Ask questions in chat or voice. Rowboat retrieves only this notebook’s selected sources and cites them as S1, S2, and so on.'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                <MessageSquareText className="size-3.5" />
                Chat + voice ready
              </span>
              <button
                type="button"
                onClick={async () => {
                  await actions.importNotes(folder.path)
                  await refresh()
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3 text-xs font-semibold text-background hover:opacity-85"
              >
                <Upload className="size-3.5" />
                Add sources
              </button>
              <button
                type="button"
                disabled={!notebook}
                onClick={() => setSettingsOpen(true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-semibold text-foreground hover:bg-accent disabled:opacity-40"
              >
                <Settings2 className="size-3.5" />
                Edit + save
              </button>
              <button
                type="button"
                disabled={!notebook}
                onClick={() => setDeleteOpen(true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-red-500/25 bg-background px-3 text-xs font-semibold text-red-600 hover:bg-red-500/10 disabled:opacity-40"
              >
                <Trash2 className="size-3.5" />
                Delete
              </button>
            </div>
          </div>
        </div>

        <div className="grid gap-0 lg:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)]">
          <div className="border-b border-border/70 p-5 lg:border-b-0 lg:border-r">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Sources</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {selectedCount} of {notebook?.sources.length ?? 0} selected for the next chat or voice turn
                </p>
              </div>
              <div className="flex items-center gap-2">
                {notebook && (
                  <span className="rounded-full border border-border bg-muted/60 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {notebook.retrievalProfile} retrieval
                  </span>
                )}
                {notebook && notebook.sources.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      const enableAll = selectedCount !== notebook.sources.length
                      void (async () => {
                        try {
                          for (const source of notebook.sources) {
                            await actions.setNotebookSourceEnabled(notebook.path, source.path, enableAll)
                          }
                          await refresh()
                        } catch (error) {
                          toast(error instanceof Error ? error.message : 'Could not update source selection', 'error')
                        }
                      })()
                    }}
                    className="text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    {selectedCount === notebook.sources.length ? 'Clear all' : 'Select all'}
                  </button>
                )}
              </div>
            </div>

            {loading ? (
              <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                Loading notebook…
              </div>
            ) : !notebook || notebook.sources.length === 0 ? (
              <button
                type="button"
                onClick={() => { void actions.importNotes(folder.path).then(refresh) }}
                className="flex w-full flex-col items-center rounded-xl border border-dashed border-border px-4 py-8 text-center transition-colors hover:bg-accent/40"
              >
                <Upload className="mb-2 size-5 text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">Add your first sources</span>
                <span className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">Markdown, PDF/OCR, Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, Jupyter notebooks, HTML, text/data, and images</span>
              </button>
            ) : (
              <div className="max-h-[360px] space-y-1 overflow-y-auto pr-1">
                {notebook.sources.map((source, index) => (
                  <div
                    key={source.path}
                    className="group flex items-center gap-3 rounded-xl border border-transparent px-2.5 py-2 transition-colors hover:border-border hover:bg-accent/35"
                  >
                    <button
                      type="button"
                      disabled={busySource === source.path}
                      onClick={() => { void toggleSource(source.path, !source.enabled) }}
                      className={cn(
                        'flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors',
                        source.enabled
                          ? 'border-violet-600 bg-violet-600 text-white'
                          : 'border-border bg-background text-transparent',
                      )}
                      aria-label={`${source.enabled ? 'Exclude' : 'Include'} ${source.title}`}
                      aria-pressed={source.enabled}
                    >
                      <Check className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenNote(source.path)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="block truncate text-sm font-medium text-foreground">{source.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        S{index + 1} · {source.format?.toUpperCase() || 'NOTE'} · {source.extraction === 'model-vision' ? 'OCR/model' : source.extraction === 'local-parser' ? 'Local extraction' : source.extraction === 'plain-text' ? 'Text' : 'Imported'} · {source.available ? 'Ready' : 'Unavailable'}
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={busySource === source.path}
                      onClick={() => {
                        const nextMode = source.contextMode === 'full'
                          ? 'overview'
                          : source.contextMode === 'overview'
                            ? 'off'
                            : 'full'
                        void setSourceMode(source.path, nextMode)
                      }}
                      className={cn(
                        'hidden shrink-0 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide sm:inline-flex',
                        source.contextMode === 'full'
                          ? 'border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300'
                          : source.contextMode === 'overview'
                            ? 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                            : 'border-border bg-muted text-muted-foreground',
                      )}
                      title="Cycle context privacy: Full, Overview, Off"
                    >
                      {source.contextMode}
                    </button>
                    <button
                      type="button"
                      disabled={busySource === source.path}
                      onClick={() => setSourceEditPath(source.path)}
                      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 focus:opacity-100"
                      aria-label={`Edit and save ${source.title}`}
                      title="Edit source settings"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={busySource === source.path}
                      onClick={() => setSourceDeletePath(source.path)}
                      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-600 group-hover:opacity-100 focus:opacity-100"
                      aria-label={`Delete ${source.title}`}
                      title="Delete source"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="p-5">
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-foreground">Create from your sources</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">Generated in chat so you can refine, copy, or export the result.</p>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {NOTEBOOK_ARTIFACTS.map(({ icon: Icon, label, description, prompt }) => (
                <button
                  key={label}
                  type="button"
                  disabled={selectedCount === 0}
                  onClick={() => actions.askNotebook(prompt)}
                  className="rounded-xl border border-border bg-background p-3 text-left transition-colors hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Icon className="size-4 text-violet-600 dark:text-violet-300" />
                  <span className="mt-2 block text-sm font-semibold text-foreground">{label}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className="mt-4 rounded-xl border border-blue-500/20 bg-blue-500/[0.06] px-4 py-3 text-xs leading-5 text-muted-foreground">
        Context is replaced—not combined—when you open another notebook, note, meeting, or browser tab. Disabled or inaccessible sources are omitted immediately.
      </div>

      {notebook && (
        <NotebookSettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          notebook={notebook}
          onSave={async (input) => {
            const updated = await actions.updateNotebook(notebook.path, input)
            setNotebook(updated)
          }}
        />
      )}
      {notebook && editedSource && (
        <SourceSettingsDialog
          open={Boolean(sourceEditPath)}
          onOpenChange={(open) => { if (!open) setSourceEditPath(null) }}
          source={editedSource}
          onOpenSource={() => onOpenNote(editedSource.path)}
          onSave={async (title) => {
            setBusySource(editedSource.path)
            try {
              const updated = await actions.updateNotebookSource(notebook.path, editedSource.path, title)
              setNotebook(updated)
              setSourceEditPath(null)
            } finally {
              setBusySource(null)
            }
          }}
        />
      )}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{notebook?.title ?? folder.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The notebook, its sources, and saved artifacts will move to Rowboat’s recoverable trash. Chat and voice context will close immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                event.preventDefault()
                if (!notebook) return
                void actions.deleteNotebook(notebook.path).then(() => {
                  setDeleteOpen(false)
                  onNavigate(null)
                  toast('Notebook moved to trash', 'success')
                }).catch((error) => {
                  toast(error instanceof Error ? error.message : 'Could not delete notebook', 'error')
                })
              }}
            >
              Delete notebook
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={Boolean(sourceDeletePath)} onOpenChange={(open) => { if (!open) setSourceDeletePath(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deletingSource?.title ?? 'source'}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The source note and its preserved original file will move to recoverable trash and will be removed from chat and voice immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busySource)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!notebook || !deletingSource || Boolean(busySource)}
              onClick={(event) => {
                event.preventDefault()
                if (!notebook || !deletingSource) return
                setBusySource(deletingSource.path)
                void actions.removeNotebookSource(notebook.path, deletingSource.path).then((updated) => {
                  setNotebook(updated)
                  setSourceDeletePath(null)
                  toast('Source moved to trash', 'success')
                }).catch((error) => {
                  toast(error instanceof Error ? error.message : 'Could not delete source', 'error')
                }).finally(() => setBusySource(null))
              }}
            >
              Delete source
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function NotebookSettingsDialog({
  open,
  onOpenChange,
  notebook,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  notebook: NotebookDescriptor
  onSave: (input: { title: string; description: string; retrievalProfile: 'fast' | 'balanced' | 'precise' }) => Promise<void>
}) {
  const [title, setTitle] = useState(notebook.title)
  const [description, setDescription] = useState(notebook.description)
  const [retrievalProfile, setRetrievalProfile] = useState(notebook.retrievalProfile)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setTitle(notebook.title)
    setDescription(notebook.description)
    setRetrievalProfile(notebook.retrievalProfile)
  }, [notebook, open])

  const save = async () => {
    if (!title.trim() || saving) return
    setSaving(true)
    try {
      await onSave({ title: title.trim(), description, retrievalProfile })
      onOpenChange(false)
      toast('Notebook saved', 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not save notebook', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next) }}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Edit notebook</DialogTitle>
          <DialogDescription>Save its purpose and choose how deeply Rowboat retrieves source context for chat and voice.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block space-y-1.5 text-sm font-medium text-foreground">
            Name
            <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} />
          </label>
          <label className="block space-y-1.5 text-sm font-medium text-foreground">
            Purpose or instructions
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={2_000}
              rows={4}
              className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="What this notebook contains and how you plan to use it"
            />
          </label>
          <div>
            <span className="text-sm font-medium text-foreground">Retrieval profile</span>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {([
                ['fast', 'Fast', 'Smallest relevant excerpts.'],
                ['balanced', 'Balanced', 'Daily speed and grounding.'],
                ['precise', 'Precise', 'Broader excerpts and neighboring context.'],
              ] as const).map(([value, label, detail]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setRetrievalProfile(value)}
                  className={cn(
                    'rounded-lg border p-3 text-left transition-colors',
                    retrievalProfile === value ? 'border-violet-500 bg-violet-500/10' : 'border-border hover:bg-accent/50',
                  )}
                >
                  <span className="block text-sm font-semibold text-foreground">{label}</span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">{detail}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <button type="button" onClick={() => onOpenChange(false)} disabled={saving} className="h-9 rounded-lg border border-border px-4 text-sm font-medium hover:bg-accent">Cancel</button>
          <button type="button" onClick={() => { void save() }} disabled={!title.trim() || saving} className="inline-flex h-9 items-center gap-2 rounded-lg bg-foreground px-4 text-sm font-medium text-background disabled:opacity-40">
            <Save className="size-4" />
            {saving ? 'Saving…' : 'Save notebook'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SourceSettingsDialog({
  open,
  onOpenChange,
  source,
  onOpenSource,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  source: NotebookDescriptor['sources'][number]
  onOpenSource: () => void
  onSave: (title: string) => Promise<void>
}) {
  const [title, setTitle] = useState(source.title)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) setTitle(source.title)
  }, [open, source.title])

  const save = async () => {
    if (!title.trim() || saving) return
    setSaving(true)
    try {
      await onSave(title.trim())
      toast('Source saved', 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not save source', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next) }}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Edit source</DialogTitle>
          <DialogDescription>Rename the citation label or open the source note to edit and autosave its contents.</DialogDescription>
        </DialogHeader>
        <label className="block space-y-1.5 text-sm font-medium text-foreground">
          Citation title
          <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} />
        </label>
        <div className="rounded-lg border border-border bg-muted/35 px-3 py-2 text-xs leading-5 text-muted-foreground">
          {source.format?.toUpperCase() || 'NOTE'} · {source.available ? 'Ready for retrieval' : 'Source unavailable'} · {source.contentLength?.toLocaleString() ?? 'Unknown'} extracted characters
        </div>
        <DialogFooter>
          <button type="button" onClick={onOpenSource} className="h-9 rounded-lg border border-border px-4 text-sm font-medium hover:bg-accent">Open and edit contents</button>
          <button type="button" onClick={() => { void save() }} disabled={!title.trim() || saving} className="inline-flex h-9 items-center gap-2 rounded-lg bg-foreground px-4 text-sm font-medium text-background disabled:opacity-40">
            <Save className="size-4" />
            {saving ? 'Saving…' : 'Save source'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function QuickActions({
  actions,
  currentFolder,
  onOpenSearch,
  onFolderCreated,
}: {
  actions: KnowledgeViewActions
  currentFolder: TreeNode | null
  onOpenSearch: () => void
  onFolderCreated: (path: string) => void
}) {
  // Inside a folder these target that folder; at the root they target knowledge/.
  const parent = currentFolder?.path
  return (
    <div className="mt-8">
      <SectionHeader label="Quick actions" />
      <div className="flex flex-wrap gap-2">
        <QuickAction icon={FilePlus} label="New note" onClick={() => actions.createNote(parent)} />
        <QuickAction icon={Upload} label="Import files" onClick={() => { void actions.importNotes(parent) }} />
        <QuickAction icon={GoogleDriveIcon} label="Add Google Doc" onClick={() => actions.addGoogleDoc(parent)} />
        <QuickAction icon={SearchIcon} label="Search" onClick={onOpenSearch} />
        <QuickAction
          icon={FolderPlus}
          label="New folder"
          onClick={async () => {
            try {
              const path = await actions.createFolder(parent)
              onFolderCreated(path)
            } catch { /* ignore */ }
          }}
        />
        <QuickAction
          icon={FolderOpen}
          label={`Reveal in ${getFileManagerName()}`}
          onClick={() => actions.revealInFileManager(parent ?? 'knowledge', true)}
        />
      </div>
    </div>
  )
}

function ViewModeButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof SearchIcon
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors',
        active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      <Icon className="size-4" />
      <span>{label}</span>
    </button>
  )
}

function QuickAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof FilePlus | typeof GoogleDriveIcon
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Icon className="size-4" />
      <span>{label}</span>
    </button>
  )
}

function SectionHeader({ label, aside }: { label: string; aside?: string }) {
  return (
    <div className="mb-2.5 flex items-center justify-between">
      <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {aside && <span className="text-xs text-muted-foreground">{aside}</span>}
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">
      {text}
    </div>
  )
}

function FolderCard({
  node,
  actions,
  renameTarget,
  onRequestRename,
  onClearRename,
  onOpenFolder,
  onOpenNote,
}: {
  node: TreeNode
  actions: KnowledgeViewActions
  renameTarget: string | null
  onRequestRename: (path: string) => void
  onClearRename: () => void
  onOpenFolder: (path: string) => void
  onOpenNote: (path: string) => void
}) {
  const count = useMemo(() => collectNotes(node).length, [node])
  const peek = useMemo(() => recentNotes(node, 3), [node])
  const modified = formatModified(latestMtime(node))
  const renameActive = renameTarget === node.path

  const card = (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenFolder(node.path)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpenFolder(node.path)
        }
      }}
      className="group flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50"
    >
      <div className="min-w-0 flex-1">
        {renameActive ? (
          <RenameField
            initial={node.name}
            isDir
            path={node.path}
            actions={actions}
            onDone={onClearRename}
          />
        ) : (
          <span className="block truncate text-sm font-semibold text-foreground">
            {node.name}
          </span>
        )}
        <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0">
            {count} {count === 1 ? 'note' : 'notes'}
          </span>
          {peek.length > 0 && (
            <span className="truncate text-muted-foreground/70">
              {peek.map((n) => (
                <span key={n.path}>
                  <span className="text-muted-foreground/40">{' · '}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenNote(n.path)
                    }}
                    className="transition-colors hover:text-foreground hover:underline"
                  >
                    {displayName(n)}
                  </button>
                </span>
              ))}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
          {modified}
        </span>
        <ChevronRight className="size-4 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
    </div>
  )

  return (
    <RowContextMenu node={node} actions={actions} onRequestRename={onRequestRename}>
      {card}
    </RowContextMenu>
  )
}

function FolderDetail({
  folder,
  actions,
  renameTarget,
  onRequestRename,
  onClearRename,
  onNavigate,
  onOpenFolder,
  onOpenNote,
}: {
  folder: TreeNode
  actions: KnowledgeViewActions
  renameTarget: string | null
  onRequestRename: (path: string) => void
  onClearRename: () => void
  onNavigate: (path: string | null) => void
  onOpenFolder: (path: string) => void
  onOpenNote: (path: string) => void
}) {
  const items = useMemo(() => sortNodes(folder.children ?? []), [folder])

  // Breadcrumb segments from "knowledge/A/B" → [{ name: 'A', path }, ...].
  const crumbs = useMemo(() => {
    const rel = folder.path.startsWith('knowledge/')
      ? folder.path.slice('knowledge/'.length)
      : folder.path
    const parts = rel.split('/').filter(Boolean)
    const out: { name: string; path: string }[] = []
    let acc = 'knowledge'
    for (const part of parts) {
      acc = `${acc}/${part}`
      out.push({ name: part, path: acc })
    }
    return out
  }, [folder.path])

  return (
    <>
      <div className="mb-4 flex min-w-0 items-center gap-1.5 text-sm">
        <button
          type="button"
          onClick={() => onNavigate(null)}
          className="rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          Brain
        </button>
        {crumbs.map((c, i) => (
          <span key={c.path} className="flex min-w-0 items-center gap-1.5">
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
            {i === crumbs.length - 1 ? (
              <span className="truncate font-medium text-foreground">{c.name}</span>
            ) : (
              <button
                type="button"
                onClick={() => onNavigate(c.path)}
                className="truncate rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {c.name}
              </button>
            )}
          </span>
        ))}
      </div>

      <SectionHeader label={`${items.length} ${items.length === 1 ? 'item' : 'items'}`} />
      {items.length === 0 ? (
        <EmptyState text="This folder is empty." />
      ) : (
        <div className="overflow-hidden rounded-xl border border-black/15 dark:border-border">
          {items.map((node, i) => (
            <div key={node.path} className={cn(i > 0 && 'border-t border-border/60')}>
              <ItemRow
                node={node}
                actions={actions}
                renameTarget={renameTarget}
                onRequestRename={onRequestRename}
                onClearRename={onClearRename}
                onOpenFolder={onOpenFolder}
                onOpenNote={onOpenNote}
              />
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function ItemRow({
  node,
  actions,
  renameTarget,
  onRequestRename,
  onClearRename,
  onOpenFolder,
  onOpenNote,
}: {
  node: TreeNode
  actions: KnowledgeViewActions
  renameTarget: string | null
  onRequestRename: (path: string) => void
  onClearRename: () => void
  onOpenFolder: (path: string) => void
  onOpenNote: (path: string) => void
}) {
  const isDir = node.kind === 'dir'
  const renameActive = renameTarget === node.path
  const modified = formatModified(isDir ? latestMtime(node) : node.stat?.mtimeMs)
  const count = useMemo(() => (isDir ? collectNotes(node).length : 0), [isDir, node])

  const handleOpen = useCallback(() => {
    if (isDir) onOpenFolder(node.path)
    else onOpenNote(node.path)
  }, [isDir, node.path, onOpenFolder, onOpenNote])

  const row = (
    <div
      role="button"
      tabIndex={0}
      onClick={handleOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleOpen()
        }
      }}
      className="group flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent/50"
    >
      <div className="min-w-0 flex-1">
        {renameActive ? (
          <RenameField
            initial={displayName(node)}
            isDir={isDir}
            path={node.path}
            actions={actions}
            onDone={onClearRename}
          />
        ) : (
          <span className="block truncate text-sm font-semibold text-foreground">
            {displayName(node)}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        {isDir && (
          <>
            <span className="whitespace-nowrap">
              {count} {count === 1 ? 'note' : 'notes'}
            </span>
            <span className="text-muted-foreground/40">·</span>
          </>
        )}
        <span className="tabular-nums whitespace-nowrap">
          {modified}
        </span>
        {!isDir && (
          <NoteActions
            path={node.path}
            name={node.name}
            onEdit={() => onOpenNote(node.path)}
            onCopy={() => actions.copyNote(node.path)}
            onRename={(name) => actions.rename(node.path, name, false)}
            onDelete={() => actions.remove(node.path)}
          />
        )}
        {isDir && (
          <ChevronRight className="size-4 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </div>
    </div>
  )

  return (
    <RowContextMenu node={node} actions={actions} onRequestRename={onRequestRename}>
      {row}
    </RowContextMenu>
  )
}

function RenameField({
  initial,
  isDir,
  path,
  actions,
  onDone,
}: {
  initial: string
  isDir: boolean
  path: string
  actions: KnowledgeViewActions
  onDone: () => void
}) {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const isSubmittingRef = useRef(false)

  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [])

  const submit = useCallback(async () => {
    if (isSubmittingRef.current) return
    isSubmittingRef.current = true
    const trimmed = value.trim()
    if (trimmed && trimmed !== initial) {
      try {
        await actions.rename(path, trimmed, isDir)
        toast('Renamed successfully', 'success')
      } catch {
        toast('Failed to rename', 'error')
      }
    }
    onDone()
  }, [actions, initial, isDir, onDone, path, value])

  const cancel = useCallback(() => {
    isSubmittingRef.current = true
    onDone()
  }, [onDone])

  return (
    <Input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          void submit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancel()
        }
      }}
      onBlur={() => {
        if (!isSubmittingRef.current) void submit()
      }}
      className="h-7 text-sm"
    />
  )
}

function RowContextMenu({
  node,
  actions,
  onRequestRename,
  children,
}: {
  node: TreeNode
  actions: KnowledgeViewActions
  onRequestRename: (path: string) => void
  children: React.ReactNode
}) {
  const isDir = node.kind === 'dir'

  const handleDelete = useCallback(async () => {
    try {
      await actions.remove(node.path)
      toast('Moved to trash', 'success')
    } catch {
      toast('Failed to delete', 'error')
    }
  }, [actions, node.path])

  const handleCopyPath = useCallback(() => {
    actions.copyPath(node.path)
    toast('Path copied', 'success')
  }, [actions, node.path])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48" onCloseAutoFocus={(e) => e.preventDefault()}>
        {isDir && (
          <>
            <ContextMenuItem onClick={() => actions.createNote(node.path)}>
              <FilePlus className="mr-2 size-4" />
              New Note
            </ContextMenuItem>
            <ContextMenuItem onClick={() => actions.addGoogleDoc(node.path)}>
              <GoogleDriveIcon className="mr-2 size-4" />
              Add Google Doc
            </ContextMenuItem>
            <ContextMenuItem onClick={() => { void actions.importNotes(node.path) }}>
              <Upload className="mr-2 size-4" />
              Import Files
            </ContextMenuItem>
            <ContextMenuItem onClick={() => void actions.createFolder(node.path)}>
              <FolderPlus className="mr-2 size-4" />
              New Folder
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {!isDir && actions.onOpenInNewTab && (
          <>
            <ContextMenuItem onClick={() => actions.onOpenInNewTab!(node.path)}>
              <ExternalLink className="mr-2 size-4" />
              Open in new tab
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onClick={handleCopyPath}>
          <Copy className="mr-2 size-4" />
          Copy Path
        </ContextMenuItem>
        <ContextMenuItem onClick={() => actions.revealInFileManager(node.path, isDir)}>
          <FolderOpen className="mr-2 size-4" />
          Open in {getFileManagerName()}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onRequestRename(node.path)}>
          <Pencil className="mr-2 size-4" />
          Rename
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={handleDelete}>
          <Trash2 className="mr-2 size-4" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
