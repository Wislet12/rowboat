# Active note context lifecycle

Rowboat treats note awareness as replaceable UI state, not cumulative chat
history. This contract is shared by typed chat and realtime voice delegation.

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

`search-notes` searches either all accessible Brain/knowledge notes or only
`knowledge/Meetings`. Search results are re-authorized on each query. Selecting
a result opens it, which starts the lifecycle above and makes it the new active
context.

## Browser-context pattern

The same replacement rule applies to the embedded browser. At submit time,
Rowboat captures the active tab ID, URL, title, visible text, headings,
description, language, and any selected text. A tab or navigation change during
capture invalidates the snapshot. Only the newest browser snapshot is encoded,
and webpage text is explicitly labeled untrusted so page instructions cannot
be mistaken for user instructions. Context is request-scoped; Rowboat does not
silently upload browser history or unrelated tabs.
