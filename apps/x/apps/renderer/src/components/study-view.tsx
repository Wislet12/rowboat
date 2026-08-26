import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import {
  ArrowLeft,
  BookOpen,
  BrainCircuit,
  CalendarDays,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileText,
  Flame,
  GraduationCap,
  LibraryBig,
  Loader2,
  MessageSquareText,
  Mic2,
  Pencil,
  Plus,
  RefreshCcw,
  RotateCcw,
  Search,
  Sparkles,
  Star,
  Target,
  Trash2,
  Upload,
} from 'lucide-react'

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
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/toast'
import { NOTEBOOK_ARTIFACTS } from '@/lib/notebook-artifacts'
import { cn } from '@/lib/utils'

type TreeNode = {
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
  starred: boolean
  description: string
  retrievalProfile: 'fast' | 'balanced' | 'precise'
  createdAt: string
  updatedAt: string
  sources: Array<{
    path: string
    title: string
    starred: boolean
    enabled: boolean
    contextMode: 'off' | 'overview' | 'full'
    addedAt: string
    format?: string
    extraction?: 'plain-text' | 'local-parser' | 'model-vision'
    available: boolean
    modifiedAt: number | null
  }>
}

type StudyCardProgress = {
  repetitions: number
  lapses: number
  intervalDays: number
  ease: number
  dueAt: string | null
  lastReviewedAt: string | null
}

type StudySet = {
  id: string
  title: string
  starred: boolean
  description: string
  sourcePaths: string[]
  activityConfig: {
    flashcardCount: number
    quizQuestionCount: number
    quizTypes: Array<'multiple-choice' | 'true-false' | 'short-answer'>
    difficulty: 'adaptive' | 'introductory' | 'intermediate' | 'advanced'
    topics: string[]
    includeExplanations: boolean
  }
  createdAt: string
  updatedAt: string
}

type StudyWorkspace = {
  notebook: NotebookDescriptor
  studySet: StudySet
  settings: {
    examDate: string | null
    dailyGoalMinutes: number
    sessionMinutes: number
  }
  cards: Array<{
    id: string
    front: string
    back: string
    sourceId: string
    sourcePath: string
    sourceTitle: string
  }>
  quiz: Array<{
    id: string
    prompt: string
    options: string[]
    correctIndex: number
    explanation: string
    sourceId: string
    sourcePath: string
    sourceTitle: string
  }>
  progress: {
    totalMinutes: number
    todayMinutes: number
    sessionsCompleted: number
    currentStreak: number
    reviewProgressPercent: number
    dueCount: number
    reviewedCount: number
    lastStudiedAt: string | null
    nextDueAt: string | null
    cardProgress: Record<string, StudyCardProgress>
  }
  unavailableSources: Array<{ path: string; title: string }>
  retrievalEvidence: {
    candidateChunkCount: number
    selectedChunkCount: number
    readableSourceCount: number
  }
  coverageNotice: string
  lastRecoveryPath: string | null
  generatedAt: string
}

type StudyActions = {
  createNotebook: (title: string) => Promise<string>
  getNotebook: (path: string) => Promise<NotebookDescriptor>
  importNotes: (path?: string) => Promise<string[]>
  updateNotebook: (path: string, input: { title?: string; starred?: boolean; description?: string; retrievalProfile?: 'fast' | 'balanced' | 'precise' }) => Promise<NotebookDescriptor>
  deleteNotebook: (path: string) => Promise<void>
  updateNotebookSource: (path: string, sourcePath: string, input: { title?: string; starred?: boolean }) => Promise<NotebookDescriptor>
  removeNotebookSource: (path: string, sourcePath: string) => Promise<NotebookDescriptor>
  startStudyChat: (prompt: string) => void
  startStudyVoice: () => void
}

type StudyViewProps = {
  tree: TreeNode[]
  notebookPath: string | null
  actions: StudyActions
  onOpenNotebook: (path: string | null) => void
  onOpenNotebookStudio: () => void
  onOpenNote: (path: string) => void
  onOpenSearch: () => void
}

type StudyMode = 'overview' | 'flashcards' | 'quiz' | 'plan'
type StudyRating = 'again' | 'hard' | 'good' | 'easy'

const NOTEBOOKS_ROOT = 'knowledge/Brain/Notebooks'

function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node
    const found = node.children ? findNode(node.children, path) : null
    if (found) return found
  }
  return null
}

function collectNotes(node: TreeNode): TreeNode[] {
  if (node.kind === 'file') return node.name.toLowerCase().endsWith('.md') ? [node] : []
  return (node.children ?? []).flatMap(collectNotes)
}

function childFolder(node: TreeNode | null, name: string): TreeNode | null {
  return node?.children?.find((child) => child.kind === 'dir' && child.name.toLowerCase() === name.toLowerCase()) ?? null
}

function collectNotebookSources(node: TreeNode): TreeNode[] {
  const sources = childFolder(node, 'Sources')
  return sources ? collectNotes(sources) : []
}

function collectNotebookArtifacts(node: TreeNode | null): TreeNode[] {
  const artifacts = childFolder(node, 'Artifacts')
  return artifacts ? collectNotes(artifacts).sort((left, right) => (right.stat?.mtimeMs ?? 0) - (left.stat?.mtimeMs ?? 0)) : []
}

function latestMtime(node: TreeNode): number {
  return Math.max(node.stat?.mtimeMs ?? 0, ...(node.children ?? []).map(latestMtime), 0)
}

function relativeDate(value?: number | string | null): string {
  if (!value) return 'Not started'
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  const deltaDays = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000))
  if (deltaDays === 0) return 'Today'
  if (deltaDays === 1) return 'Yesterday'
  if (deltaDays < 7) return `${deltaDays} days ago`
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined })
}

function metricLabel(workspace: StudyWorkspace): string {
  if (workspace.progress.reviewedCount === 0 && workspace.progress.sessionsCompleted === 0) return 'Not started'
  return `${workspace.progress.reviewProgressPercent}% review progress`
}

function mutationKey(): string {
  return globalThis.crypto.randomUUID()
}

export function StudyView({
  tree,
  notebookPath,
  actions,
  onOpenNotebook,
  onOpenNotebookStudio,
  onOpenNote,
  onOpenSearch,
}: StudyViewProps) {
  const [createOpen, setCreateOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [selectedStudySetId, setSelectedStudySetId] = useState<string | null>(null)
  const [notebookByPath, setNotebookByPath] = useState<Record<string, NotebookDescriptor>>({})
  const [editingNotebook, setEditingNotebook] = useState<NotebookDescriptor | null>(null)
  const [deletingNotebook, setDeletingNotebook] = useState<NotebookDescriptor | null>(null)
  const notebooksRoot = useMemo(() => findNode(tree, NOTEBOOKS_ROOT), [tree])
  const notebooks = useMemo(() => [...(notebooksRoot?.children ?? [])]
    .filter((node) => node.kind === 'dir')
    .sort((left, right) => {
      const starDelta = Number(notebookByPath[right.path]?.starred ?? false) - Number(notebookByPath[left.path]?.starred ?? false)
      return starDelta || latestMtime(right) - latestMtime(left)
    }), [notebookByPath, notebooksRoot])

  useEffect(() => {
    let active = true
    void Promise.all(notebooks.map(async (node) => {
      try { return await actions.getNotebook(node.path) }
      catch { return null }
    })).then((items) => {
      if (!active) return
      setNotebookByPath(Object.fromEntries(items.filter((item): item is NotebookDescriptor => Boolean(item)).map((item) => [item.path, item])))
    })
    return () => { active = false }
  }, [actions, notebooksRoot])

  const rememberNotebook = useCallback((notebook: NotebookDescriptor) => {
    setNotebookByPath((current) => ({ ...current, [notebook.path]: notebook }))
  }, [])

  const createNotebook = useCallback(async () => {
    const title = newTitle.trim()
    if (!title || creating) return
    setCreating(true)
    try {
      const path = await actions.createNotebook(title)
      setNewTitle('')
      setCreateOpen(false)
      onOpenNotebook(path)
      toast('Notebook created', 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not create notebook', 'error')
    } finally {
      setCreating(false)
    }
  }, [actions, creating, newTitle, onOpenNotebook])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[#f7f8fa] dark:bg-[#0b0c0f]" data-testid="study-view">
      {notebookPath ? (
        selectedStudySetId ? <StudySetWorkspace
          key={`${notebookPath}:${selectedStudySetId}`}
          tree={tree} notebookPath={notebookPath} studySetId={selectedStudySetId} actions={actions}
          onBack={() => setSelectedStudySetId(null)} onOpenNotebookStudio={onOpenNotebookStudio} onOpenNote={onOpenNote}
        /> : <NotebookStudyHome
          key={notebookPath} tree={tree} notebookPath={notebookPath} actions={actions}
          onBack={() => onOpenNotebook(null)} onOpenStudySet={setSelectedStudySetId}
          onOpenNotebookStudio={onOpenNotebookStudio} onOpenNote={onOpenNote}
        />
      ) : (
        <>
          <header className="shrink-0 border-b border-border/70 bg-background/80 px-5 py-5 backdrop-blur-sm sm:px-8">
            <div className="mx-auto flex w-full max-w-[1180px] flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-600 dark:text-violet-300">
                  <GraduationCap className="size-4" /> Education workspace
                </div>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">Study</h1>
                <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                  Learn from your own notes with grounded tutor chat and voice, active recall, quizzes, plans, and local progress.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={onOpenSearch} className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium hover:bg-accent">
                  <Search className="size-4" /> Search notes
                </button>
                <button type="button" onClick={() => setCreateOpen(true)} className="inline-flex h-10 items-center gap-2 rounded-lg bg-violet-600 px-4 text-sm font-semibold text-white hover:bg-violet-500">
                  <Plus className="size-4" /> New notebook
                </button>
              </div>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto px-5 py-6 sm:px-8">
            <div className="mx-auto w-full max-w-[1180px] space-y-8">
              <section className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(280px,0.8fr)]">
                <div className="rounded-2xl border border-violet-200/70 bg-gradient-to-br from-violet-50 via-background to-sky-50 p-5 dark:border-violet-500/20 dark:from-violet-950/40 dark:via-background dark:to-sky-950/30">
                  <div className="flex size-10 items-center justify-center rounded-xl bg-violet-600 text-white"><BrainCircuit className="size-5" /></div>
                  <h2 className="mt-5 text-lg font-semibold">One source set, every way to learn it</h2>
                  <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                    Add course notes once. Rowboat keeps the original source authority while cards, quizzes, tutor turns, and plans stay linked to citations.
                  </p>
                  <div className="mt-5 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {['Private by default', 'Recoverable deletes', 'No context bleed', 'Portable Markdown sources'].map((label) => (
                      <span key={label} className="rounded-full border border-border bg-background/80 px-2.5 py-1">{label}</span>
                    ))}
                  </div>
                </div>
                <div className="rounded-2xl border border-border bg-background p-5">
                  <div className="flex items-center gap-2"><Target className="size-5 text-emerald-600" /><h2 className="font-semibold">Start cleanly</h2></div>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">Create a notebook, add notes or documents, then make focused study sets from selected sources.</p>
                  <button type="button" onClick={() => setCreateOpen(true)} className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-accent">
                    <Upload className="size-4" /> Create and add materials
                  </button>
                </div>
              </section>

              <section>
                <div className="mb-3 flex items-end justify-between gap-3">
                  <div><h2 className="text-lg font-semibold">Your notebooks</h2><p className="text-sm text-muted-foreground">All notebook sources are stored safely in Brain.</p></div>
                  <span className="text-xs text-muted-foreground">{notebooks.length} {notebooks.length === 1 ? 'notebook' : 'notebooks'}</span>
                </div>
                {notebooks.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-border bg-background p-10 text-center">
                    <LibraryBig className="mx-auto size-9 text-muted-foreground" />
                    <h3 className="mt-3 font-semibold">No notebooks yet</h3>
                    <p className="mt-1 text-sm text-muted-foreground">Create a notebook here, then organize one or more focused study sets inside it.</p>
                    <button type="button" onClick={() => setCreateOpen(true)} className="mt-4 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500">Create notebook</button>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {notebooks.map((node) => {
                      const notes = collectNotebookSources(node)
                      const notebook = notebookByPath[node.path]
                      return (
                        <article key={node.path} className="group min-h-36 rounded-2xl border border-border bg-background p-4 transition hover:-translate-y-0.5 hover:border-violet-300 hover:shadow-sm">
                          <div className="flex items-start justify-between gap-3">
                            <span className="flex size-9 items-center justify-center rounded-xl bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"><BookOpen className="size-4" /></span>
                            <div className="flex items-center gap-1">
                              <button type="button" disabled={!notebook} onClick={() => {
                                if (!notebook) return
                                void actions.updateNotebook(notebook.path, { starred: !notebook.starred }).then((updated) => {
                                  rememberNotebook(updated)
                                  toast(updated.starred ? 'Notebook starred' : 'Notebook unstarred', 'success')
                                })
                              }} aria-label={notebook?.starred ? `Unstar ${notebook.title}` : `Star ${notebook?.title ?? node.name}`} aria-pressed={notebook?.starred ?? false} className={cn('flex size-8 items-center justify-center rounded-lg hover:bg-accent disabled:opacity-30', notebook?.starred ? 'text-amber-600' : 'text-muted-foreground')}><Star className={cn('size-4', notebook?.starred && 'fill-current')} /></button>
                              <button type="button" disabled={!notebook} onClick={() => notebook && setEditingNotebook(notebook)} aria-label={`Edit ${notebook?.title ?? node.name}`} className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"><Pencil className="size-4" /></button>
                              <button type="button" disabled={!notebook} onClick={() => notebook && setDeletingNotebook(notebook)} aria-label={`Delete ${notebook?.title ?? node.name}`} className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-30"><Trash2 className="size-4" /></button>
                            </div>
                          </div>
                          <button type="button" onClick={() => onOpenNotebook(node.path)} className="mt-3 block w-full rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500">
                            <div className="flex items-center gap-2"><h3 className="min-w-0 flex-1 truncate font-semibold">{notebook?.title ?? node.name}</h3><ChevronRight className="size-4 text-muted-foreground transition group-hover:translate-x-0.5" /></div>
                            <div className="mt-1 flex items-center justify-between gap-3 text-xs text-muted-foreground"><span>{notes.length} {notes.length === 1 ? 'source' : 'sources'}</span><span>{relativeDate(notebook?.updatedAt ?? latestMtime(node))}</span></div>
                            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full w-0 rounded-full bg-violet-500" /></div>
                            <span className="mt-1 block text-[11px] text-muted-foreground">Open to begin or continue</span>
                          </button>
                        </article>
                      )
                    })}
                  </div>
                )}
              </section>

              {notebooks.length > 0 && (
                <section>
                  <h2 className="mb-3 text-lg font-semibold">Recent materials</h2>
                  <div className="overflow-hidden rounded-2xl border border-border bg-background">
                    {notebooks.flatMap(collectNotes).sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0)).slice(0, 6).map((note, index) => (
                      <button key={note.path} type="button" onClick={() => onOpenNote(note.path)} className={cn('flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent', index > 0 && 'border-t border-border/70')}>
                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{note.name.replace(/\.md$/i, '')}</span>
                        <span className="text-xs text-muted-foreground">{relativeDate(note.stat?.mtimeMs)}</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </main>
        </>
      )}

      <Dialog open={createOpen} onOpenChange={(open) => { if (!creating) setCreateOpen(open) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create a notebook</DialogTitle><DialogDescription>Start a private knowledge workspace. Its sources also appear in Brain automatically.</DialogDescription></DialogHeader>
          <Input autoFocus value={newTitle} onChange={(event) => setNewTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createNotebook() }} placeholder="Example: Cardiac nursing" aria-label="Notebook name" />
          <DialogFooter>
            <button type="button" onClick={() => setCreateOpen(false)} disabled={creating} className="h-9 rounded-lg border border-border px-4 text-sm font-medium hover:bg-accent">Cancel</button>
            <button type="button" onClick={() => { void createNotebook() }} disabled={!newTitle.trim() || creating} className="inline-flex h-9 items-center gap-2 rounded-lg bg-violet-600 px-4 text-sm font-semibold text-white disabled:opacity-50">
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Create
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {editingNotebook && <NotebookEditDialog open notebook={editingNotebook} onOpenChange={(open) => { if (!open) setEditingNotebook(null) }} onSave={async (input) => {
        const updated = await actions.updateNotebook(editingNotebook.path, input)
        rememberNotebook(updated)
        setEditingNotebook(null)
      }} />}
      <AlertDialog open={Boolean(deletingNotebook)} onOpenChange={(open) => { if (!open) setDeletingNotebook(null) }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete “{deletingNotebook?.title}”?</AlertDialogTitle><AlertDialogDescription>The notebook, its uploaded sources, and saved artifacts move to Rowboat’s recoverable trash. Active chat and voice context closes immediately.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground" onClick={() => { if (!deletingNotebook) return; void actions.deleteNotebook(deletingNotebook.path).then(() => { setDeletingNotebook(null); toast('Notebook moved to recoverable trash', 'success') }) }}>Delete notebook</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function NotebookEditDialog({ open, notebook, onOpenChange, onSave }: {
  open: boolean
  notebook: NotebookDescriptor
  onOpenChange: (open: boolean) => void
  onSave: (input: { title: string; description: string; retrievalProfile: NotebookDescriptor['retrievalProfile'] }) => Promise<void>
}) {
  const [title, setTitle] = useState(notebook.title)
  const [description, setDescription] = useState(notebook.description)
  const [retrievalProfile, setRetrievalProfile] = useState(notebook.retrievalProfile)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (open) { setTitle(notebook.title); setDescription(notebook.description); setRetrievalProfile(notebook.retrievalProfile) } }, [notebook, open])
  const save = async () => {
    if (!title.trim() || saving) return
    setSaving(true)
    try { await onSave({ title: title.trim(), description: description.trim(), retrievalProfile }); toast('Notebook saved', 'success') }
    catch (error) { toast(error instanceof Error ? error.message : 'Could not save notebook', 'error') }
    finally { setSaving(false) }
  }
  return <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next) }}><DialogContent><DialogHeader><DialogTitle>Edit notebook</DialogTitle><DialogDescription>Rename this notebook, update its purpose, or tune retrieval. Uploaded sources and study sets remain linked.</DialogDescription></DialogHeader><div className="space-y-4"><label className="block text-sm font-medium">Name<Input className="mt-1.5" value={title} onChange={(event) => setTitle(event.target.value)} /></label><label className="block text-sm font-medium">Description<textarea className="mt-1.5 min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={description} onChange={(event) => setDescription(event.target.value)} /></label><label className="block text-sm font-medium">Retrieval<select className="mt-1.5 h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={retrievalProfile} onChange={(event) => setRetrievalProfile(event.target.value as NotebookDescriptor['retrievalProfile'])}><option value="fast">Fast</option><option value="balanced">Balanced</option><option value="precise">Precise</option></select></label></div><DialogFooter><button type="button" onClick={() => onOpenChange(false)} disabled={saving} className="h-9 rounded-lg border px-4 text-sm">Cancel</button><button type="button" onClick={() => { void save() }} disabled={!title.trim() || saving} className="inline-flex h-9 items-center gap-2 rounded-lg bg-violet-600 px-4 text-sm font-semibold text-white disabled:opacity-50">{saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Save notebook</button></DialogFooter></DialogContent></Dialog>
}

function NotebookStudyHome({ notebookPath, actions, onBack, onOpenStudySet, onOpenNotebookStudio, onOpenNote }: {
  tree: TreeNode[]
  notebookPath: string
  actions: StudyActions
  onBack: () => void
  onOpenStudySet: (id: string) => void
  onOpenNotebookStudio: () => void
  onOpenNote: (path: string) => void
}) {
  const [notebook, setNotebook] = useState<NotebookDescriptor | null>(null)
  const [sets, setSets] = useState<StudySet[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [flashcardCount, setFlashcardCount] = useState(20)
  const [quizQuestionCount, setQuizQuestionCount] = useState(10)
  const [difficulty, setDifficulty] = useState<StudySet['activityConfig']['difficulty']>('adaptive')
  const [notebookEditOpen, setNotebookEditOpen] = useState(false)
  const [notebookDeleteOpen, setNotebookDeleteOpen] = useState(false)
  const [editingSet, setEditingSet] = useState<StudySet | null>(null)
  const [deletingSet, setDeletingSet] = useState<StudySet | null>(null)
  const [editingSourcePath, setEditingSourcePath] = useState<string | null>(null)
  const [deletingSourcePath, setDeletingSourcePath] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [nextNotebook, nextSets] = await Promise.all([
        actions.getNotebook(notebookPath),
        window.ipc.invoke('knowledge:study:listSets', { path: notebookPath }),
      ])
      setNotebook(nextNotebook)
      setSets([...nextSets].sort((left, right) => Number(right.starred) - Number(left.starred) || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()))
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not load notebook', 'error') }
    finally { setLoading(false) }
  }, [actions, notebookPath])
  useEffect(() => { void load() }, [load])

  const sources = notebook?.sources ?? []
  const openCreate = () => { setSelectedPaths(sources.map((source) => source.path)); setCreateOpen(true) }
  const createSet = async () => {
    if (!title.trim()) return
    try {
      const created = await window.ipc.invoke('knowledge:study:createSet', {
        path: notebookPath, title: title.trim(), description: description.trim(), sourcePaths: selectedPaths,
        activityConfig: { flashcardCount, quizQuestionCount, difficulty },
      })
      setCreateOpen(false); setTitle(''); setDescription(''); await load(); onOpenStudySet(created.id)
      toast('Study set created', 'success')
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not create study set', 'error') }
  }

  if (loading && !notebook) return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" /> Loading notebook…</div>
  if (!notebook) return <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8"><CircleHelp className="size-8 text-destructive" /><p className="text-sm text-muted-foreground">This notebook is unavailable.</p><button type="button" onClick={onBack} className="rounded-lg border px-3 py-2 text-sm">Back to notebooks</button></div>
  const editingSource = notebook.sources.find((source) => source.path === editingSourcePath) ?? null
  const deletingSource = notebook.sources.find((source) => source.path === deletingSourcePath) ?? null

  return <>
    <header className="shrink-0 border-b border-border/70 bg-background/90 px-4 py-4 sm:px-7">
      <div className="mx-auto flex w-full max-w-[1180px] flex-wrap items-start justify-between gap-3">
        <div className="flex gap-3"><button type="button" onClick={onBack} aria-label="Back to notebooks" className="flex size-9 items-center justify-center rounded-lg border border-border"><ArrowLeft className="size-4" /></button><div><div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-violet-600">Notebook</div><h1 className="text-xl font-semibold">{notebook.title}</h1><p className="text-xs text-muted-foreground">{sources.length} sources · stored in Brain</p></div></div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => { void actions.importNotes(notebookPath).then(load) }} className="inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm"><Upload className="size-4" /> Add materials</button>
          <button type="button" onClick={onOpenNotebookStudio} className="inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm"><LibraryBig className="size-4" /> Notebook studio</button>
          <button type="button" onClick={() => { void actions.updateNotebook(notebook.path, { starred: !notebook.starred }).then((updated) => { setNotebook(updated); toast(updated.starred ? 'Notebook starred' : 'Notebook unstarred', 'success') }) }} aria-label={notebook.starred ? 'Unstar notebook' : 'Star notebook'} aria-pressed={notebook.starred} className={cn('flex size-9 items-center justify-center rounded-lg border', notebook.starred ? 'border-amber-400/40 bg-amber-400/10 text-amber-600' : 'text-muted-foreground hover:bg-accent')}><Star className={cn('size-4', notebook.starred && 'fill-current')} /></button>
          <button type="button" onClick={() => setNotebookEditOpen(true)} aria-label="Edit and save notebook" className="flex size-9 items-center justify-center rounded-lg border text-muted-foreground hover:bg-accent hover:text-foreground"><Pencil className="size-4" /></button>
          <button type="button" onClick={() => setNotebookDeleteOpen(true)} aria-label="Delete notebook" className="flex size-9 items-center justify-center rounded-lg border text-destructive hover:bg-destructive/10"><Trash2 className="size-4" /></button>
          <button type="button" onClick={openCreate} className="inline-flex h-9 items-center gap-2 rounded-lg bg-violet-600 px-3 text-sm font-semibold text-white"><Plus className="size-4" /> New study set</button>
        </div>
      </div>
    </header>
    <main className="flex-1 overflow-y-auto px-4 py-5 sm:px-7"><div className="mx-auto w-full max-w-[1180px] space-y-6">
      <section className="rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 to-background p-5 dark:border-violet-500/20 dark:from-violet-950/35"><div className="flex items-center gap-2 text-sm font-semibold text-violet-700"><BrainCircuit className="size-4" /> Notebook intelligence</div><h2 className="mt-2 text-lg font-semibold">Chat, speak, and create from all or selected sources.</h2><p className="mt-1 text-sm text-muted-foreground">Notebook summaries, guides, FAQs, timelines, comparisons, cited chat, and realtime voice remain available in Notebook Studio.</p><div className="mt-4 flex gap-2"><button type="button" onClick={() => actions.startStudyChat(`Use only the active notebook “${notebook.title}” and cite sources as [S#].`)} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white">Chat with notebook</button><button type="button" onClick={actions.startStudyVoice} className="rounded-lg border px-4 py-2 text-sm font-semibold">Voice with notebook</button></div></section>
      <section><div className="mb-3 flex items-end justify-between"><div><h2 className="text-lg font-semibold">Study sets</h2><p className="text-sm text-muted-foreground">Focused activities and progress built from selected notebook sources.</p></div><span className="text-xs text-muted-foreground">{sets.length} sets</span></div>
        {loading ? <Loader2 className="size-5 animate-spin" /> : sets.length === 0 ? <div className="rounded-2xl border border-dashed p-8 text-center"><p className="text-sm text-muted-foreground">Create a focused study set without duplicating your notes.</p><button type="button" onClick={openCreate} className="mt-3 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white">New study set</button></div> : <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{sets.map((set) => <article key={set.id} className="rounded-2xl border bg-background p-4 hover:border-violet-300"><div className="flex items-start justify-between"><Target className="size-5 text-violet-600" /><div className="flex gap-1"><button type="button" onClick={() => { void window.ipc.invoke('knowledge:study:updateSet', { path: notebookPath, studySetId: set.id, starred: !set.starred }).then(load) }} aria-label={set.starred ? `Unstar ${set.title}` : `Star ${set.title}`} aria-pressed={set.starred} className={cn('flex size-7 items-center justify-center rounded-md hover:bg-accent', set.starred ? 'text-amber-600' : 'text-muted-foreground')}><Star className={cn('size-3.5', set.starred && 'fill-current')} /></button><button type="button" onClick={() => setEditingSet(set)} aria-label={`Edit ${set.title}`} className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><Pencil className="size-3.5" /></button><button type="button" onClick={() => setDeletingSet(set)} aria-label={`Delete ${set.title}`} className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 className="size-3.5" /></button></div></div><button type="button" onClick={() => onOpenStudySet(set.id)} className="mt-2 block w-full rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"><div className="flex items-center gap-2"><h3 className="min-w-0 flex-1 truncate font-semibold">{set.title}</h3><ChevronRight className="size-4 text-muted-foreground" /></div><p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{set.description || `${set.sourcePaths.length} selected sources`}</p><div className="mt-3 text-[11px] text-muted-foreground">{set.sourcePaths.length} sources · {set.activityConfig.flashcardCount} cards · {set.activityConfig.quizQuestionCount} quiz questions</div></button></article>)}</div>}
      </section>
      {sources.length > 0 && <section><h2 className="mb-3 text-lg font-semibold">Notebook sources</h2><div className="overflow-hidden rounded-2xl border bg-background">{sources.map((source, index) => <div key={source.path} className={cn('group flex w-full items-center gap-2 px-4 py-3', index > 0 && 'border-t')}><FileText className="size-4 shrink-0" /><button type="button" onClick={() => onOpenNote(source.path)} className="min-w-0 flex-1 truncate text-left text-sm hover:underline">{source.title}</button><button type="button" onClick={() => { void actions.updateNotebookSource(notebook.path, source.path, { starred: !source.starred }).then(setNotebook) }} aria-label={source.starred ? `Unstar ${source.title}` : `Star ${source.title}`} aria-pressed={source.starred} className={cn('flex size-7 items-center justify-center rounded-md hover:bg-accent', source.starred ? 'text-amber-600' : 'text-muted-foreground')}><Star className={cn('size-3.5', source.starred && 'fill-current')} /></button><button type="button" onClick={() => setEditingSourcePath(source.path)} aria-label={`Edit ${source.title}`} className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><Pencil className="size-3.5" /></button><button type="button" onClick={() => setDeletingSourcePath(source.path)} aria-label={`Delete ${source.title}`} className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 className="size-3.5" /></button></div>)}</div></section>}
    </div></main>
    <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>Create study set</DialogTitle><DialogDescription>Select notebook sources and customize the learning activities. Sources remain stored once in Brain.</DialogDescription></DialogHeader><div className="space-y-4"><Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Example: Midterm review" /><Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Goal or description (optional)" /><div><div className="mb-2 text-sm font-medium">Sources</div><div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border p-2">{sources.map((source) => <label key={source.path} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"><input type="checkbox" checked={selectedPaths.includes(source.path)} onChange={() => setSelectedPaths((current) => current.includes(source.path) ? current.filter((path) => path !== source.path) : [...current, source.path])} /> {source.title}</label>)}</div></div><div className="grid grid-cols-2 gap-3"><label className="text-sm">Flashcards<Input type="number" min={5} max={80} value={flashcardCount} onChange={(event) => setFlashcardCount(Number(event.target.value))} /></label><label className="text-sm">Quiz questions<Input type="number" min={5} max={50} value={quizQuestionCount} onChange={(event) => setQuizQuestionCount(Number(event.target.value))} /></label></div><label className="block text-sm">Difficulty<select value={difficulty} onChange={(event) => setDifficulty(event.target.value as typeof difficulty)} className="mt-1 h-9 w-full rounded-md border bg-background px-3"><option value="adaptive">Adaptive</option><option value="introductory">Introductory</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option></select></label></div><DialogFooter><button type="button" onClick={() => setCreateOpen(false)} className="h-9 rounded-lg border px-4 text-sm">Cancel</button><button type="button" disabled={!title.trim()} onClick={() => void createSet()} className="h-9 rounded-lg bg-violet-600 px-4 text-sm font-semibold text-white disabled:opacity-50">Create study set</button></DialogFooter></DialogContent></Dialog>
    {notebookEditOpen && <NotebookEditDialog open notebook={notebook} onOpenChange={setNotebookEditOpen} onSave={async (input) => { setNotebook(await actions.updateNotebook(notebook.path, input)); setNotebookEditOpen(false) }} />}
    <AlertDialog open={notebookDeleteOpen} onOpenChange={setNotebookDeleteOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete “{notebook.title}”?</AlertDialogTitle><AlertDialogDescription>The notebook and all uploaded sources move to recoverable trash. Use this only when you mean to remove the knowledge everywhere.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground" onClick={() => { void actions.deleteNotebook(notebook.path).then(onBack) }}>Delete notebook everywhere</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    {editingSet && <EditStudySetDialog open studySet={editingSet} notebook={notebook} onOpenChange={(open) => { if (!open) setEditingSet(null) }} onSave={async (input) => { await window.ipc.invoke('knowledge:study:updateSet', { path: notebookPath, studySetId: editingSet.id, ...input }); setEditingSet(null); await load() }} />}
    <AlertDialog open={Boolean(deletingSet)} onOpenChange={(open) => { if (!open) setDeletingSet(null) }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete “{deletingSet?.title}”?</AlertDialogTitle><AlertDialogDescription>This removes only the study set and its progress. Its notebook sources remain safely stored in Brain, and a recovery snapshot is preserved.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground" onClick={() => { if (!deletingSet) return; void window.ipc.invoke('knowledge:study:deleteSet', { path: notebookPath, studySetId: deletingSet.id }).then(async () => { setDeletingSet(null); await load() }) }}>Delete study set only</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    {editingSource && <SourceEditDialog open source={editingSource} onOpenChange={(open) => { if (!open) setEditingSourcePath(null) }} onSave={async (titleInput) => { setNotebook(await actions.updateNotebookSource(notebook.path, editingSource.path, { title: titleInput })); setEditingSourcePath(null) }} />}
    <AlertDialog open={Boolean(deletingSource)} onOpenChange={(open) => { if (!open) setDeletingSourcePath(null) }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete “{deletingSource?.title}” everywhere?</AlertDialogTitle><AlertDialogDescription>This removes the uploaded source from this notebook, Brain, and every linked study set. The source file moves to Rowboat’s recoverable trash.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground" onClick={() => { if (!deletingSource) return; void actions.removeNotebookSource(notebook.path, deletingSource.path).then((updated) => { setNotebook(updated); setDeletingSourcePath(null); void load() }) }}>Delete source everywhere</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>
}

function SourceEditDialog({ open, source, onOpenChange, onSave }: { open: boolean; source: NotebookDescriptor['sources'][number]; onOpenChange: (open: boolean) => void; onSave: (title: string) => Promise<void> }) {
  const [title, setTitle] = useState(source.title)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (open) setTitle(source.title) }, [open, source])
  const save = async () => { if (!title.trim() || saving) return; setSaving(true); try { await onSave(title.trim()); toast('Source saved', 'success') } catch (error) { toast(error instanceof Error ? error.message : 'Could not save source', 'error') } finally { setSaving(false) } }
  return <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next) }}><DialogContent><DialogHeader><DialogTitle>Edit uploaded source</DialogTitle><DialogDescription>Change the display name without altering the original extracted content or citations.</DialogDescription></DialogHeader><Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} /><DialogFooter><button type="button" onClick={() => onOpenChange(false)} className="h-9 rounded-lg border px-4 text-sm">Cancel</button><button type="button" disabled={!title.trim() || saving} onClick={() => { void save() }} className="inline-flex h-9 items-center gap-2 rounded-lg bg-violet-600 px-4 text-sm font-semibold text-white disabled:opacity-50">{saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Save source</button></DialogFooter></DialogContent></Dialog>
}

function StudySetWorkspace({
  tree,
  notebookPath,
  studySetId,
  actions,
  onBack,
  onOpenNotebookStudio,
  onOpenNote,
}: {
  tree: TreeNode[]
  notebookPath: string
  studySetId: string
  actions: StudyActions
  onBack: () => void
  onOpenNotebookStudio: () => void
  onOpenNote: (path: string) => void
}) {
  const [workspace, setWorkspace] = useState<StudyWorkspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<StudyMode>('overview')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const requestRef = useRef(0)
  const node = useMemo(() => findNode(tree, notebookPath), [notebookPath, tree])
  const sourceRefreshKey = useMemo(() => node ? collectNotebookSources(node).map((note) => `${note.path}:${note.stat?.mtimeMs ?? 0}`).join('|') : '', [node])
  const savedArtifacts = useMemo(() => collectNotebookArtifacts(node), [node])

  const load = useCallback(async () => {
    const requestId = ++requestRef.current
    setLoading(true)
    setError(null)
    try {
      const next = await window.ipc.invoke('knowledge:study:getWorkspace', { path: notebookPath, studySetId })
      if (requestRef.current === requestId) setWorkspace(next)
    } catch (nextError) {
      if (requestRef.current === requestId) setError(nextError instanceof Error ? nextError.message : 'Could not load this study set')
    } finally {
      if (requestRef.current === requestId) setLoading(false)
    }
  }, [notebookPath, studySetId])

  useEffect(() => {
    void load()
    return () => { requestRef.current += 1 }
  }, [load, sourceRefreshKey])

  const updateFromMutation = useCallback(async (operation: Promise<StudyWorkspace>, success?: string) => {
    try {
      const next = await operation
      setWorkspace(next)
      if (success) toast(next.lastRecoveryPath && success.toLowerCase().includes('reset') ? `${success}: ${next.lastRecoveryPath}` : success, 'success')
    } catch (nextError) {
      toast(nextError instanceof Error ? nextError.message : 'Could not save study progress', 'error')
    }
  }, [])

  if (loading && !workspace) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" /> Building source-grounded study activities…</div>
  }
  if (error || !workspace) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <CircleHelp className="size-9 text-destructive" /><h2 className="font-semibold">Study set unavailable</h2><p className="max-w-md text-sm text-muted-foreground">{error}</p>
        <div className="flex gap-2"><button type="button" onClick={onBack} className="rounded-lg border border-border px-3 py-2 text-sm">Back</button><button type="button" onClick={() => { void load() }} className="rounded-lg bg-violet-600 px-3 py-2 text-sm font-semibold text-white">Retry</button></div>
      </div>
    )
  }

  const selectedSources = workspace.notebook.sources.filter((source) => source.enabled && source.contextMode !== 'off')
  const goalPercent = Math.min(100, Math.round((workspace.progress.todayMinutes / workspace.settings.dailyGoalMinutes) * 100))

  return (
    <>
      <header className="shrink-0 border-b border-border/70 bg-background/90 px-4 py-4 backdrop-blur-sm sm:px-7">
        <div className="mx-auto w-full max-w-[1180px]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <button type="button" onClick={onBack} aria-label="Back to all study sets" className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-border hover:bg-accent"><ArrowLeft className="size-4" /></button>
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-violet-600 dark:text-violet-300">Study set</div>
                <h1 className="truncate text-xl font-semibold">{workspace.studySet.title}</h1>
                <p className="mt-0.5 text-xs text-muted-foreground">Using {selectedSources.length} of {workspace.notebook.sources.length} sources · {metricLabel(workspace)}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => { void actions.importNotes(notebookPath).then(() => load()) }} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium hover:bg-accent"><Upload className="size-4" /> Add materials</button>
              <button type="button" onClick={onOpenNotebookStudio} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium hover:bg-accent"><LibraryBig className="size-4" /> Sources</button>
              <button type="button" onClick={() => { void window.ipc.invoke('knowledge:study:updateSet', { path: notebookPath, studySetId, starred: !workspace.studySet.starred }).then((studySet) => { setWorkspace((current) => current ? { ...current, studySet } : current); toast(studySet.starred ? 'Study set starred' : 'Study set unstarred', 'success') }) }} aria-label={workspace.studySet.starred ? 'Unstar study set' : 'Star study set'} aria-pressed={workspace.studySet.starred} className={cn('flex size-9 items-center justify-center rounded-lg border bg-background', workspace.studySet.starred ? 'border-amber-400/40 bg-amber-400/10 text-amber-600' : 'text-muted-foreground hover:bg-accent')}><Star className={cn('size-4', workspace.studySet.starred && 'fill-current')} /></button>
              <button type="button" onClick={() => setSettingsOpen(true)} aria-label="Edit and save study set" className="flex size-9 items-center justify-center rounded-lg border border-border bg-background hover:bg-accent"><Pencil className="size-4" /></button>
              <button type="button" onClick={() => setDeleteOpen(true)} aria-label="Delete study set" className="flex size-9 items-center justify-center rounded-lg border border-border bg-background text-destructive hover:bg-destructive/10"><Trash2 className="size-4" /></button>
            </div>
          </div>
          <nav className="mt-4 flex gap-1 overflow-x-auto rounded-xl border border-border bg-muted/40 p-1" aria-label="Study modes">
            {([
              ['overview', 'Overview', Sparkles],
              ['flashcards', 'Flashcards', BookOpen],
              ['quiz', 'Quiz', CircleHelp],
              ['plan', 'Plan', CalendarDays],
            ] as const).map(([value, label, Icon]) => (
              <button key={value} type="button" onClick={() => setMode(value)} aria-current={mode === value ? 'page' : undefined} className={cn('inline-flex min-h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium transition', mode === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                <Icon className="size-4" /> {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-5 sm:px-7">
        <div className="mx-auto w-full max-w-[1180px]">
          {workspace.notebook.sources.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-background p-10 text-center"><Upload className="mx-auto size-9 text-muted-foreground" /><h2 className="mt-3 font-semibold">Add materials to begin</h2><p className="mt-1 text-sm text-muted-foreground">Flashcards, quizzes, tutor chat, and voice are generated only from sources you select.</p><button type="button" onClick={() => { void actions.importNotes(notebookPath).then(() => load()) }} className="mt-4 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white">Add materials</button></div>
          ) : mode === 'overview' ? (
            <StudyOverview workspace={workspace} goalPercent={goalPercent} actions={actions} savedArtifacts={savedArtifacts} onMode={setMode} onOpenNote={onOpenNote} />
          ) : mode === 'flashcards' ? (
            <FlashcardPractice workspace={workspace} onOpenNote={onOpenNote} onRate={(cardId, rating) => updateFromMutation(window.ipc.invoke('knowledge:study:reviewCard', { path: notebookPath, studySetId, cardId, rating, idempotencyKey: mutationKey() }))} onComplete={() => updateFromMutation(window.ipc.invoke('knowledge:study:recordSession', { path: notebookPath, studySetId, minutes: workspace.settings.sessionMinutes, mode: 'flashcards', idempotencyKey: mutationKey() }), 'Flashcard session saved')} />
          ) : mode === 'quiz' ? (
            <QuizPractice workspace={workspace} onOpenNote={onOpenNote} onAnswer={(cardId, correct) => updateFromMutation(window.ipc.invoke('knowledge:study:reviewCard', { path: notebookPath, studySetId, cardId, rating: correct ? 'good' : 'again', idempotencyKey: mutationKey() }))} onComplete={() => updateFromMutation(window.ipc.invoke('knowledge:study:recordSession', { path: notebookPath, studySetId, minutes: workspace.settings.sessionMinutes, mode: 'quiz', idempotencyKey: mutationKey() }), 'Quiz session saved')} />
          ) : (
            <StudyPlan workspace={workspace} onSave={(settings) => updateFromMutation(window.ipc.invoke('knowledge:study:updateSettings', { path: notebookPath, studySetId, ...settings }), 'Study plan saved')} onRecord={() => updateFromMutation(window.ipc.invoke('knowledge:study:recordSession', { path: notebookPath, studySetId, minutes: workspace.settings.sessionMinutes, mode: 'review', idempotencyKey: mutationKey() }), 'Study session completed')} onReset={() => updateFromMutation(window.ipc.invoke('knowledge:study:resetProgress', { path: notebookPath, studySetId }), 'Study progress reset; a recovery snapshot was preserved')} />
          )}
        </div>
      </main>

      <EditStudySetDialog open={settingsOpen} onOpenChange={setSettingsOpen} studySet={workspace.studySet} notebook={workspace.notebook} onSave={async (input) => {
        const studySet = await window.ipc.invoke('knowledge:study:updateSet', { path: notebookPath, studySetId, ...input })
        setWorkspace((current) => current ? { ...current, studySet } : current)
      }} />
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete “{workspace.studySet.title}”?</AlertDialogTitle><AlertDialogDescription>This removes only the study set and its progress. Its selected notes remain safely stored in the notebook and Brain, and a recovery snapshot is preserved.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { void window.ipc.invoke('knowledge:study:deleteSet', { path: notebookPath, studySetId }).then(onBack) }}>Delete study set only</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function StudyOverview({ workspace, goalPercent, actions, savedArtifacts, onMode, onOpenNote }: {
  workspace: StudyWorkspace
  goalPercent: number
  actions: StudyActions
  savedArtifacts: TreeNode[]
  onMode: (mode: StudyMode) => void
  onOpenNote: (path: string) => void
}) {
  const quickPrompt = `Tutor me on “${workspace.studySet.title}” using only the active study set. Start by asking what I already know, then teach adaptively with [S#] citations. If the sources do not support an answer, say so.`
  const citedSources = workspace.notebook.sources.filter((source) => source.enabled && source.contextMode !== 'off' && source.available)
  return (
    <div className="space-y-6">
      {workspace.unavailableSources.length > 0 && <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-100">{workspace.unavailableSources.length} source{workspace.unavailableSources.length === 1 ? ' is' : 's are'} unavailable and excluded from study activities.</div>}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Target} label="Review progress" value={workspace.progress.reviewedCount === 0 ? 'Not started' : `${workspace.progress.reviewProgressPercent}%`} detail={`${workspace.progress.reviewedCount} of ${workspace.cards.length} cards reviewed`} />
        <MetricCard icon={Clock3} label="Today" value={`${workspace.progress.todayMinutes} min`} detail={`${goalPercent}% of ${workspace.settings.dailyGoalMinutes}-minute goal`} progress={goalPercent} />
        <MetricCard icon={RefreshCcw} label="Due now" value={String(workspace.progress.dueCount)} detail={`${workspace.cards.length} source-grounded cards`} />
        <MetricCard icon={Flame} label="Streak" value={`${workspace.progress.currentStreak} day${workspace.progress.currentStreak === 1 ? '' : 's'}`} detail={`${workspace.progress.totalMinutes} minutes total`} />
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
        <div className="rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 to-background p-5 dark:border-violet-500/20 dark:from-violet-950/35 dark:to-background">
          <div className="flex items-center gap-2 text-sm font-semibold text-violet-700 dark:text-violet-300"><BrainCircuit className="size-4" /> Grounded tutor</div>
          <h2 className="mt-2 text-xl font-semibold">Talk through the material, not around it.</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">A fresh tutor session prevents another study set’s transcript from bleeding in. Each turn rebuilds the selected source context.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={() => actions.startStudyChat(quickPrompt)} className="inline-flex h-10 items-center gap-2 rounded-lg bg-violet-600 px-4 text-sm font-semibold text-white hover:bg-violet-500"><MessageSquareText className="size-4" /> Tutor in chat</button>
            <button type="button" onClick={actions.startStudyVoice} className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-background px-4 text-sm font-semibold hover:bg-accent"><Mic2 className="size-4" /> Start voice tutor</button>
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-background p-5">
          <div className="flex items-center gap-2"><CalendarDays className="size-5 text-sky-600" /><h2 className="font-semibold">Next checkpoint</h2></div>
          <p className="mt-3 text-sm text-muted-foreground">{workspace.settings.examDate ? `Exam target: ${new Date(`${workspace.settings.examDate}T12:00:00`).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}` : 'Add an exam date to turn your daily goal into a realistic plan.'}</p>
          <button type="button" onClick={() => onMode('plan')} className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-sky-700 hover:underline dark:text-sky-300">Open plan <ChevronRight className="size-4" /></button>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Choose an activity</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <ActivityCard icon={BookOpen} title="Spaced flashcards" description="Missed cards return sooner; remembered cards move out." onClick={() => onMode('flashcards')} />
          <ActivityCard icon={CircleHelp} title="Source-grounded quiz" description="Practice with immediate explanations and citations." onClick={() => onMode('quiz')} />
          <ActivityCard icon={FileText} title="Build a study guide" description="Generate an editable, cited guide in chat and save or export it." onClick={() => actions.startStudyChat('Create an exam-focused study guide from only this active study set. Include concepts, clinical or practical applications, common misconceptions, memory cues, and review questions. Cite every section with [S#].')} />
          <ActivityCard icon={Target} title="Find weak areas" description="Use evidence from the source set to target what to review next." onClick={() => actions.startStudyChat('Diagnose the highest-value concepts in this active study set. Quiz me one question at a time, track my mistakes in this session, and cite each correction with [S#].')} />
          <ActivityCard icon={CalendarDays} title="Plan to exam" description="Set time limits first; Rowboat will not create an impossible workload." onClick={() => onMode('plan')} />
          <ActivityCard icon={Mic2} title="Explain aloud" description="Use the same active study context with realtime voice and interruption." onClick={actions.startStudyVoice} />
        </div>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">Create from your sources</h2>
            <p className="text-sm text-muted-foreground">The original Notebook Studio tools are preserved here and launch in a fresh, isolated study chat.</p>
          </div>
          <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">Notebook Studio connected</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {NOTEBOOK_ARTIFACTS.map(({ icon, label, description, prompt }) => (
            <ActivityCard key={label} icon={icon} title={label} description={description} onClick={() => actions.startStudyChat(prompt)} />
          ))}
        </div>
      </section>

      {savedArtifacts.length > 0 && (
        <section>
          <div className="mb-3 flex items-end justify-between gap-3">
            <div><h2 className="text-lg font-semibold">Saved study materials</h2><p className="text-sm text-muted-foreground">Artifacts saved from chat remain in this notebook and are editable, exportable, and recoverable.</p></div>
            <span className="text-xs text-muted-foreground">{savedArtifacts.length} saved</span>
          </div>
          <div className="overflow-hidden rounded-2xl border border-border bg-background">
            {savedArtifacts.slice(0, 12).map((artifact, index) => (
              <button key={artifact.path} type="button" onClick={() => onOpenNote(artifact.path)} className={cn('flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent', index > 0 && 'border-t border-border/70')}>
                <FileText className="size-4 shrink-0 text-violet-600" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{artifact.name.replace(/\.md$/i, '')}</span>
                <span className="text-xs text-muted-foreground">{relativeDate(artifact.stat?.mtimeMs)}</span>
                <ChevronRight className="size-4 text-muted-foreground" />
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <p className="mb-3 rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground">{workspace.coverageNotice}</p>
        <div className="mb-3 flex items-center justify-between"><div><h2 className="text-lg font-semibold">Sources</h2><p className="text-sm text-muted-foreground">Every card and answer remains traceable.</p></div><span className="text-xs text-muted-foreground">{workspace.retrievalEvidence.readableSourceCount} readable</span></div>
        <div className="overflow-hidden rounded-2xl border border-border bg-background">
          {citedSources.map((source, index) => (
            <button key={source.path} type="button" onClick={() => onOpenNote(source.path)} className={cn('flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent', index > 0 && 'border-t border-border/70')}>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold">S{index + 1}</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{source.title}</span><span className="block text-xs text-muted-foreground">{source.format?.toUpperCase() || 'NOTE'} · {source.extraction === 'model-vision' ? 'OCR/model' : source.extraction === 'local-parser' ? 'Local extraction' : source.extraction === 'plain-text' ? 'Text' : 'Imported'} · {source.available ? source.contextMode : 'Unavailable'}</span></span>
              <ChevronRight className="size-4 text-muted-foreground" />
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

function MetricCard({ icon: Icon, label, value, detail, progress }: { icon: typeof Target; label: string; value: string; detail: string; progress?: number }) {
  return <div className="rounded-2xl border border-border bg-background p-4"><div className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><Icon className="size-4" /> {label}</div><div className="mt-2 text-xl font-semibold">{value}</div><div className="mt-1 text-xs text-muted-foreground">{detail}</div>{progress !== undefined && <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-emerald-500 transition-[width]" style={{ width: `${progress}%` }} /></div>}</div>
}

function ActivityCard({ icon: Icon, title, description, onClick }: { icon: ComponentType<{ className?: string }>; title: string; description: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="group rounded-2xl border border-border bg-background p-4 text-left hover:border-violet-300 hover:shadow-sm"><div className="flex items-start justify-between"><span className="flex size-9 items-center justify-center rounded-xl bg-muted"><Icon className="size-4" /></span><ChevronRight className="size-4 text-muted-foreground transition group-hover:translate-x-0.5" /></div><h3 className="mt-3 font-semibold">{title}</h3><p className="mt-1 text-sm leading-5 text-muted-foreground">{description}</p></button>
}

function FlashcardPractice({ workspace, onOpenNote, onRate, onComplete }: { workspace: StudyWorkspace; onOpenNote: (path: string) => void; onRate: (cardId: string, rating: StudyRating) => void; onComplete: () => void }) {
  const ordered = useMemo(() => [...workspace.cards].sort((left, right) => {
    const leftDue = workspace.progress.cardProgress[left.id]?.dueAt ?? ''
    const rightDue = workspace.progress.cardProgress[right.id]?.dueAt ?? ''
    return leftDue.localeCompare(rightDue)
  }), [workspace.cards, workspace.progress.cardProgress])
  const [index, setIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const card = ordered[index % Math.max(ordered.length, 1)]
  if (!card) return <EmptyActivity title="No flashcards yet" detail="Enable at least one readable source with substantive content." />
  const rate = (rating: StudyRating) => { onRate(card.id, rating); setRevealed(false); setIndex((value) => value + 1) }
  return <div className="mx-auto max-w-3xl"><div className="mb-4 flex items-center justify-between text-sm text-muted-foreground"><span>Card {(index % ordered.length) + 1} of {ordered.length}</span><span>{workspace.progress.dueCount} due</span></div><div className="min-h-[340px] rounded-3xl border border-border bg-background p-6 shadow-sm sm:p-9"><div className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-600 dark:text-violet-300">Prompt</div><h2 className="mt-4 text-2xl font-semibold leading-9">{card.front}</h2>{revealed ? <div className="mt-8 border-t border-border pt-6"><div className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-600">Answer</div><p className="mt-3 whitespace-pre-wrap text-base leading-7 text-foreground">{card.back}</p><button type="button" onClick={() => onOpenNote(card.sourcePath)} className="mt-4 text-sm font-medium text-violet-700 hover:underline dark:text-violet-300">{card.sourceId} · {card.sourceTitle}</button></div> : <button type="button" onClick={() => setRevealed(true)} className="mt-10 rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white">Reveal answer</button>}</div>{revealed && <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">{([['again','Again'],['hard','Hard'],['good','Good'],['easy','Easy']] as const).map(([value,label]) => <button key={value} type="button" onClick={() => rate(value)} className="min-h-11 rounded-xl border border-border bg-background px-3 text-sm font-semibold hover:bg-accent">{label}</button>)}</div>}<button type="button" onClick={onComplete} className="mx-auto mt-5 block text-sm font-medium text-muted-foreground hover:text-foreground">Save {workspace.settings.sessionMinutes}-minute session</button></div>
}

function QuizPractice({ workspace, onOpenNote, onAnswer, onComplete }: { workspace: StudyWorkspace; onOpenNote: (path: string) => void; onAnswer: (cardId: string, correct: boolean) => void; onComplete: () => void }) {
  const [index, setIndex] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  const [score, setScore] = useState(0)
  const question = workspace.quiz[index]
  if (!question) return <EmptyActivity title="No quiz available yet" detail="Add at least two distinct source concepts so Rowboat can build meaningful choices." />
  const answered = selected !== null
  const correct = selected === question.correctIndex
  return <div className="mx-auto max-w-3xl"><div className="mb-4 flex items-center justify-between text-sm text-muted-foreground"><span>Question {index + 1} of {workspace.quiz.length}</span><span>Score {score}/{index + (answered ? 1 : 0)}</span></div><div className="rounded-3xl border border-border bg-background p-6 shadow-sm sm:p-8"><h2 className="text-xl font-semibold leading-8">{question.prompt}</h2><div className="mt-6 grid gap-2">{question.options.map((option, optionIndex) => <button key={`${question.id}-${optionIndex}`} type="button" disabled={answered} onClick={() => { setSelected(optionIndex); const isCorrect = optionIndex === question.correctIndex; if (isCorrect) setScore((value) => value + 1); const card = workspace.cards.find((candidate) => candidate.front === question.prompt); if (card) onAnswer(card.id, isCorrect) }} className={cn('min-h-12 rounded-xl border px-4 py-3 text-left text-sm transition', !answered && 'border-border hover:border-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950/30', answered && optionIndex === question.correctIndex && 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30', answered && optionIndex === selected && optionIndex !== question.correctIndex && 'border-red-400 bg-red-50 dark:bg-red-950/30')}>{option}</button>)}</div>{answered && <div className="mt-6 rounded-xl bg-muted/60 p-4"><div className="flex items-center gap-2 text-sm font-semibold">{correct ? <Check className="size-4 text-emerald-600" /> : <RotateCcw className="size-4 text-red-500" />}{correct ? 'Correct' : 'Review this concept'}</div><p className="mt-2 text-sm leading-6 text-muted-foreground">{question.explanation}</p><button type="button" onClick={() => onOpenNote(question.sourcePath)} className="mt-2 text-sm font-medium text-violet-700 hover:underline dark:text-violet-300">{question.sourceId} · {question.sourceTitle}</button></div>}{answered && <button type="button" onClick={() => { if (index + 1 >= workspace.quiz.length) { onComplete(); setIndex(0); setScore(0) } else setIndex((value) => value + 1); setSelected(null) }} className="mt-5 rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white">{index + 1 >= workspace.quiz.length ? 'Finish and save attempt' : 'Next question'}</button>}</div></div>
}

function StudyPlan({ workspace, onSave, onRecord, onReset }: { workspace: StudyWorkspace; onSave: (settings: StudyWorkspace['settings']) => void; onRecord: () => void; onReset: () => void }) {
  const [examDate, setExamDate] = useState(workspace.settings.examDate ?? '')
  const [dailyGoalMinutes, setDailyGoalMinutes] = useState(workspace.settings.dailyGoalMinutes)
  const [sessionMinutes, setSessionMinutes] = useState(workspace.settings.sessionMinutes)
  const [resetOpen, setResetOpen] = useState(false)
  const daysRemaining = examDate ? Math.max(0, Math.ceil((new Date(`${examDate}T23:59:59`).getTime() - new Date(workspace.generatedAt).getTime()) / 86_400_000)) : null
  const cardsPerDay = daysRemaining && daysRemaining > 0 ? Math.max(1, Math.ceil(workspace.cards.length / daysRemaining)) : workspace.progress.dueCount
  return <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]"><section className="rounded-2xl border border-border bg-background p-5"><h2 className="text-lg font-semibold">Plan around your real time</h2><p className="mt-1 text-sm text-muted-foreground">Rowboat uses your exam date and capacity before recommending workload.</p><div className="mt-5 grid gap-4 sm:grid-cols-3"><label className="text-sm font-medium">Exam date<Input type="date" className="mt-1.5" value={examDate} onChange={(event) => setExamDate(event.target.value)} /></label><label className="text-sm font-medium">Daily goal<Input type="number" min={5} max={480} className="mt-1.5" value={dailyGoalMinutes} onChange={(event) => setDailyGoalMinutes(Number(event.target.value))} /></label><label className="text-sm font-medium">Session minutes<Input type="number" min={5} max={180} className="mt-1.5" value={sessionMinutes} onChange={(event) => setSessionMinutes(Number(event.target.value))} /></label></div><div className="mt-5 flex flex-wrap gap-2"><button type="button" onClick={() => onSave({ examDate: examDate || null, dailyGoalMinutes, sessionMinutes })} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white">Save plan</button><button type="button" onClick={onRecord} className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-accent">Complete one session</button><button type="button" onClick={() => setResetOpen(true)} className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-destructive hover:bg-destructive/10">Reset progress</button></div></section><aside className="rounded-2xl border border-border bg-background p-5"><h2 className="font-semibold">Workload preview</h2><dl className="mt-4 space-y-4"><PlanMetric label="Days remaining" value={daysRemaining === null ? 'Set a date' : String(daysRemaining)} /><PlanMetric label="Cards per day" value={String(cardsPerDay)} /><PlanMetric label="Daily capacity" value={`${dailyGoalMinutes} min`} /><PlanMetric label="Evidence so far" value={`${workspace.progress.reviewedCount} reviewed`} /></dl><p className="mt-5 text-xs leading-5 text-muted-foreground">Review progress changes only when you answer a card or quiz; it is not presented as objective mastery.</p></aside><AlertDialog open={resetOpen} onOpenChange={setResetOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Reset study progress?</AlertDialogTitle><AlertDialogDescription>This clears review scheduling and session history after saving a recoverable snapshot inside the study set. Sources, notebook settings, and saved artifacts stay intact.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground" onClick={onReset}>Reset and preserve backup</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></div>
}

function PlanMetric({ label, value }: { label: string; value: string }) { return <div className="flex items-center justify-between gap-3"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="text-sm font-semibold">{value}</dd></div> }
function EmptyActivity({ title, detail }: { title: string; detail: string }) { return <div className="rounded-2xl border border-dashed border-border bg-background p-10 text-center"><BookOpen className="mx-auto size-9 text-muted-foreground" /><h2 className="mt-3 font-semibold">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{detail}</p></div> }

function EditStudySetDialog({ open, onOpenChange, studySet, notebook, onSave }: { open: boolean; onOpenChange: (open: boolean) => void; studySet: StudySet; notebook: NotebookDescriptor; onSave: (input: { title: string; description: string; sourcePaths: string[]; activityConfig: StudySet['activityConfig'] }) => Promise<void> }) {
  const [title, setTitle] = useState(studySet.title)
  const [description, setDescription] = useState(studySet.description)
  const [flashcardCount, setFlashcardCount] = useState(studySet.activityConfig.flashcardCount)
  const [quizQuestionCount, setQuizQuestionCount] = useState(studySet.activityConfig.quizQuestionCount)
  const [difficulty, setDifficulty] = useState(studySet.activityConfig.difficulty)
  const [sourcePaths, setSourcePaths] = useState(studySet.sourcePaths)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (open) { setTitle(studySet.title); setDescription(studySet.description); setFlashcardCount(studySet.activityConfig.flashcardCount); setQuizQuestionCount(studySet.activityConfig.quizQuestionCount); setDifficulty(studySet.activityConfig.difficulty); setSourcePaths(studySet.sourcePaths) } }, [studySet, open])
  const save = async () => { if (!title.trim() || saving) return; setSaving(true); try { await onSave({ title: title.trim(), description: description.trim(), sourcePaths, activityConfig: { ...studySet.activityConfig, flashcardCount, quizQuestionCount, difficulty } }); onOpenChange(false); toast('Study set saved', 'success') } catch (error) { toast(error instanceof Error ? error.message : 'Could not save study set', 'error') } finally { setSaving(false) } }
  return <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next) }}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>Edit study set</DialogTitle><DialogDescription>Change selected sources or activity settings. Unchecking a source removes it only from this set; the source stays in the notebook and Brain.</DialogDescription></DialogHeader><div className="space-y-4"><label className="block text-sm font-medium">Name<Input className="mt-1.5" value={title} onChange={(event) => setTitle(event.target.value)} /></label><label className="block text-sm font-medium">Purpose<textarea className="mt-1.5 min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Exam, course, goals, or preferred teaching approach" /></label><div><div className="mb-2 text-sm font-medium">Sources in this set</div><div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border p-2">{notebook.sources.map((source) => <label key={source.path} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"><input type="checkbox" checked={sourcePaths.includes(source.path)} onChange={() => setSourcePaths((current) => current.includes(source.path) ? current.filter((path) => path !== source.path) : [...current, source.path])} /> {source.title}</label>)}</div><p className="mt-1 text-xs text-muted-foreground">To delete a source everywhere, use Notebook Studio’s recoverable source delete.</p></div><div className="grid grid-cols-2 gap-3"><label className="text-sm">Flashcards<Input type="number" min={5} max={80} value={flashcardCount} onChange={(event) => setFlashcardCount(Number(event.target.value))} /></label><label className="text-sm">Quiz questions<Input type="number" min={5} max={50} value={quizQuestionCount} onChange={(event) => setQuizQuestionCount(Number(event.target.value))} /></label></div><label className="block text-sm font-medium">Difficulty<select className="mt-1.5 h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={difficulty} onChange={(event) => setDifficulty(event.target.value as typeof difficulty)}><option value="adaptive">Adaptive</option><option value="introductory">Introductory</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option></select></label></div><DialogFooter><button type="button" onClick={() => onOpenChange(false)} className="h-9 rounded-lg border border-border px-4 text-sm font-medium">Cancel</button><button type="button" onClick={() => { void save() }} disabled={!title.trim() || saving} className="inline-flex h-9 items-center gap-2 rounded-lg bg-violet-600 px-4 text-sm font-semibold text-white disabled:opacity-50">{saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Save</button></DialogFooter></DialogContent></Dialog>
}
