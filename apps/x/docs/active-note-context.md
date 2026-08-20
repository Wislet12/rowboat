# Active note context lifecycle

Rowboat treats note awareness as replaceable UI state, not cumulative chat
history. This contract is shared by typed chat, direct GPT Realtime voice, and
voice delegation into Rowboat's Codex/tool runtime.

1. Opening a Markdown note emits `rowboat:note-context-open` with
   `{ path, replacedPath }`.
2. Switching notes first emits `rowboat:note-context-close` for the old path,
   then `rowboat:note-context-open` for the new path. The new snapshot replaces
   the old one; snapshots never stack.
3. Closing the note or navigating to a non-note view emits
   `rowboat:note-context-close`.
4. Immediately before each chat or voice turn, Rowboat re-reads the selected
   file through `workspace:readFile`. This re-checks the workspace permission
   boundary. If access was removed, no note content is attached.
5. The request encoder includes middle-pane context only on the newest user
   turn. Historical note snapshots are stripped, preventing note-to-note
   bleed while keeping ordinary conversation history compatible.

The active snapshot contains the normalized path/context ID, title, note type
(`meeting` or `brain`), readable frontmatter metadata, and the current editor
body. Meeting transcripts and existing notes are therefore available when
they are part of the open note. If no note is open, chat and voice retain their
existing behavior without a note snapshot.

## Direct Realtime voice

GPT Realtime uses server VAD to commit microphone audio, but automatic provider
response creation is disabled. When transcription completes, Rowboat:

1. re-runs the same permission-gated current-note/browser capture used by chat;
2. sends a complete `session.update` containing the immutable voice/tool policy
   plus exactly one replacement context snapshot; and
3. sends `response.create` only after that replacement update.

Opening, closing, editing, or switching the visible note also refreshes an
active voice session immediately. A monotonically increasing context revision
prevents a slow old-note read from overwriting a newer selection. An empty or
permission-denied capture explicitly clears the prior snapshot. Browser text
remains untrusted data. Requests to search or open other meeting/Brain notes
use `rowboat_delegate`, after which the selected result enters this same
lifecycle.

`search-notes` searches either all accessible Brain/knowledge notes or only
`knowledge/Meetings`. Search results are re-authorized on each query. Selecting
a result opens it, which starts the lifecycle above and makes it the new active
context.

## Notebook Studio lifecycle

Notebook Studio is owned and stored entirely by Rowboat under
`knowledge/Brain/Notebooks`; it does not call or depend on another JARVIS
studio. Opening a notebook emits `rowboat:notebook-context-open`, and switching
or closing emits `rowboat:notebook-context-close` before the replacement opens.
Only one note, notebook, meeting, or browser snapshot can be active for a turn.

Each turn re-reads the notebook manifest and every selected source. The manifest
is the authority boundary: sources set to Off, deleted sources, missing files,
and newly inaccessible files are omitted immediately. Every snapshot includes
a content-derived context ID, stable `[S#]` citations, retrieval profile, and
retrieval evidence counts. Fast, Balanced, and Precise profiles adjust the
source budget; Precise also recalls neighboring chunks around strong matches.

Lifecycle mutations are explicit and recoverable:

- notebook name, purpose, and retrieval profile have an explicit Save action;
- source citation titles have an explicit Save action, while source contents use
  the standard note editor autosave or Ctrl/Cmd+S action;
- source deletion removes manifest authority first, then moves the preserved
  source files to Rowboat trash;
- notebook deletion closes active chat/voice context immediately and moves the
  notebook, sources, and saved artifacts to Rowboat trash; and
- assistant responses can be copied, selected with the cursor, downloaded, or
  saved into the active notebook's `Artifacts` folder (or Brain Chat Outputs
  when no notebook is active).

## Browser-context pattern

The same replacement rule applies to the embedded browser. At submit time,
Rowboat captures the active tab ID, URL, title, visible text, headings,
description, language, and any selected text. A tab or navigation change during
capture invalidates the snapshot. Only the newest browser snapshot is encoded,
and webpage text is explicitly labeled untrusted so page instructions cannot
be mistaken for user instructions. Context is request-scoped; Rowboat does not
silently upload browser history or unrelated tabs.
