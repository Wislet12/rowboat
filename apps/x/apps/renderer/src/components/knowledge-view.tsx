import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  BookOpen,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  FilePlus,
  FileQuestion,
  FileText,
  FolderOpen,
  FolderPlus,
  GitCompareArrows,
  GraduationCap,
  ListChecks,
  MessageSquareText,
  Network,
  Pencil,
  SearchIcon,
  Sparkles,
  Table2,
  TimerReset,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { VoiceNoteButton } from '@/components/sidebar-content'
import { NoteActions } from '@/components/note-actions'
import { formatRelativeTime } from '@/lib/relative-time'
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
  createdAt: string
  updatedAt: string
  sources: Array<{
    path: string
    title: string
    enabled: boolean
    contextMode: 'off' | 'overview' | 'full'
    addedAt: string
  }>
}

export type KnowledgeViewActions = {
  createNote: (parentPath?: string) => void
  addGoogleDoc: (parentPath?: string) => void
  importNotes: (parentPath?: string) => Promise<string[]>
  createNotebook: (title: string) => Promise<string>
  getNotebook: (path: string) => Promise<NotebookDescriptor>
  setNotebookSourceEnabled: (path: string, sourcePath: string, enabled: boolean) => Promise<NotebookDescriptor>
  setNotebookSourceContextMode: (path: string, sourcePath: string, contextMode: 'off' | 'overview' | 'full') => Promise<NotebookDescriptor>
  askNotebook: (prompt: string) => void
  createFolder: (parentPath?: string) => Promise<string>
  rename: (path: string, newName: string, isDir: boolean) => Promise<void>
  remove: (path: string) => Promise<void>
  copyPath: (path: string) => void
  copyNote: (path: string) => Promise<void>
  revealInFileManager: (path: string, isDir: boolean) => void
  onOpenInNewTab?: (path: string) => void
}

export type KnowledgeViewMode = 'graph' | 'basis' | 'files'

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

const NOTEBOOK_ARTIFACTS = [
  {
    icon: Sparkles,
    label: 'Source summary',
    description: 'Key ideas and evidence with citations.',
    prompt: 'Summarize the selected notebook sources. Organize the key ideas clearly and cite every factual claim with [S#].',
  },
  {
    icon: GraduationCap,
    label: 'Study guide',
    description: 'Concepts, definitions, and review questions.',
    prompt: 'Create a comprehensive study guide from the selected notebook sources with key concepts, definitions, memory cues, and review questions. Cite each section with [S#].',
  },
  {
    icon: FileQuestion,
    label: 'FAQ',
    description: 'Important questions answered from the sources.',
    prompt: 'Create an FAQ from the selected notebook sources. Answer only from the material and cite each answer with [S#].',
  },
  {
    icon: TimerReset,
    label: 'Timeline',
    description: 'Dates, events, and dependencies in order.',
    prompt: 'Build a chronological timeline from the selected notebook sources. Include dates, events, dependencies, uncertainty, and [S#] citations.',
  },
  {
    icon: GitCompareArrows,
    label: 'Compare sources',
    description: 'Agreements, differences, and contradictions.',
    prompt: 'Compare the selected notebook sources. Identify agreements, differences, contradictions, and gaps with precise [S#] citations.',
  },
  {
    icon: ListChecks,
    label: 'Quiz me',
    description: 'An interactive mastery check.',
    prompt: 'Quiz me interactively on the selected notebook sources. Ask one question at a time, wait for my answer, then explain it with [S#] citations.',
  },
] as const

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
                Ask questions in chat or voice. Rowboat retrieves only this notebook’s selected sources and cites them as S1, S2, and so on.
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
                <span className="mt-1 text-xs text-muted-foreground">PDF, Word, PowerPoint, spreadsheets, Markdown, text, images, and more</span>
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
                      <span className="block truncate text-xs text-muted-foreground">S{index + 1} · {source.path.split('/').pop()}</span>
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
    </>
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
