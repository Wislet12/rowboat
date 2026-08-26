/* Rowboat first-class Mindspace enhancement.
 * Upstream: Gagancreates/mindspace (MIT). Data remains local in state.json.
 */

const API = {
  async app() {
    const response = await fetch('/_rowboat/app', { cache: 'no-store' });
    if (!response.ok) throw new Error('Mindspace app information is unavailable.');
    return response.json();
  },
  async load() {
    const response = await fetch('/_rowboat/data/state.json', { cache: 'no-store' });
    if (response.status === 404) return freshState();
    if (!response.ok) throw new Error(`Could not load Mindspace (${response.status}).`);
    return response.json();
  },
  async save(snapshot, keepalive = false) {
    const response = await fetch('/_rowboat/data/state.json', {
      method: 'PUT',
      headers: { 'X-Rowboat-App': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
      keepalive,
    });
    if (!response.ok) throw new Error(`Could not save Mindspace (${response.status}).`);
    return response.json().catch(() => ({ ok: true }));
  },
  async setBrainLink(kind, itemId, linked) {
    const response = await fetch('/_rowboat/mindspace/brain', {
      method: 'POST',
      headers: { 'X-Rowboat-App': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, itemId, linked }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      throw new Error(result?.error?.message || `Could not update Brain link (${response.status}).`);
    }
    return response.json();
  },
};

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const now = () => new Date().toISOString();
const freshState = () => ({ updatedAt: now(), maps: [], brainstorm: [], notes: [], lastSelection: null });

let state = freshState();
let mode = 'map';
let selection = { map: null, brainstorm: null, notes: null };
let selectedEdge = null;
let interaction = null;
let dirty = false;
let saveTimer = null;
let saveChain = Promise.resolve();
let toastTimer = null;
let editSerial = 0;

function ensureShape(input) {
  const next = input && typeof input === 'object' ? input : freshState();
  next.maps = Array.isArray(next.maps) ? next.maps : [];
  next.brainstorm = Array.isArray(next.brainstorm) ? next.brainstorm : [];
  next.notes = Array.isArray(next.notes) ? next.notes : [];
  next.lastSelection = next.lastSelection || null;
  for (const item of [...next.maps, ...next.brainstorm, ...next.notes]) {
    item.starred = Boolean(item.starred);
  }
  for (const map of next.maps) {
    map.nodes = Array.isArray(map.nodes) ? map.nodes : [];
    map.edges = Array.isArray(map.edges) ? map.edges : [];
  }
  for (const session of next.brainstorm) session.thoughts = Array.isArray(session.thoughts) ? session.thoughts : [];
  return next;
}

function cloneState() {
  return JSON.parse(JSON.stringify(state));
}

function setSaveStatus(status, message) {
  document.querySelectorAll('.save-status').forEach((element) => {
    element.textContent = message;
    element.classList.toggle('saving', status === 'saving');
    element.classList.toggle('error', status === 'error');
    element.title = status === 'error' ? 'Click to retry saving' : '';
  });
}

async function flushSave({ keepalive = false } = {}) {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!dirty && !keepalive) return saveChain;
  const snapshot = cloneState();
  snapshot._baseUpdatedAt = state.updatedAt;
  const capturedEditSerial = editSerial;
  dirty = false;
  setSaveStatus('saving', 'Saving…');
  if (keepalive) {
    return API.save(snapshot, true).catch(() => {});
  }
  saveChain = saveChain.then(async () => {
    const result = await API.save(snapshot);
    const savedState = result?.state ? ensureShape(result.state) : null;
    if (savedState) {
      if (capturedEditSerial === editSerial && !dirty) {
        state = savedState;
        if (state.lastSelection) selection[state.lastSelection.kind] = state.lastSelection.id;
        renderAll();
      } else {
        // New local edits happened while the request was in flight. Preserve
        // them, but adopt the server revision and any concurrently created
        // items so a chat/voice agent and the canvas cannot clobber each other.
        for (const kind of ['map', 'brainstorm', 'notes']) {
          const localIds = new Set(itemsFor(kind).map((item) => item.id));
          for (const item of kind === 'map' ? savedState.maps : kind === 'brainstorm' ? savedState.brainstorm : savedState.notes) {
            if (!localIds.has(item.id)) itemsFor(kind).push(item);
          }
        }
        state.updatedAt = savedState.updatedAt;
      }
    }
    setSaveStatus('saved', 'Saved');
    if (dirty) scheduleSave();
  }).catch((error) => {
    dirty = true;
    setSaveStatus('error', 'Save failed');
    showToast(error.message || 'Mindspace could not save. Click Save failed to retry.');
  });
  return saveChain;
}

function scheduleSave(immediate = false) {
  editSerial += 1;
  dirty = true;
  setSaveStatus('saving', 'Saving…');
  clearTimeout(saveTimer);
  if (immediate) void flushSave();
  else saveTimer = setTimeout(() => void flushSave(), 220);
}

document.querySelectorAll('.save-status').forEach((element) => element.addEventListener('click', () => {
  if (element.classList.contains('error')) void flushSave();
}));

window.addEventListener('pagehide', () => { if (dirty) void flushSave({ keepalive: true }); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && dirty) void flushSave({ keepalive: true });
});

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
}

function itemsFor(kind = mode) {
  if (kind === 'map') return state.maps;
  if (kind === 'brainstorm') return state.brainstorm;
  return state.notes;
}

function current(kind = mode) {
  return itemsFor(kind).find((item) => item.id === selection[kind]) || null;
}

function labelFor(kind, item) {
  if (item.title?.trim()) return item.title.trim();
  if (kind === 'map' && item.nodes?.[0]?.text) return item.nodes[0].text.slice(0, 55);
  if (kind === 'brainstorm' && item.thoughts?.[0]?.text) return item.thoughts[0].text.slice(0, 55);
  if (kind === 'notes' && item.body?.trim()) return item.body.trim().split(/\r?\n/)[0].slice(0, 55);
  return kind === 'map' ? 'Untitled map' : kind === 'brainstorm' ? 'Untitled brainstorm' : 'Untitled note';
}

function sortedItems(kind) {
  return [...itemsFor(kind)].sort((a, b) => Number(Boolean(b.starred)) - Number(Boolean(a.starred)));
}

function renderList() {
  document.getElementById('list-title').textContent = mode === 'map' ? 'Maps' : mode === 'brainstorm' ? 'Sessions' : 'Notes';
  const list = document.getElementById('item-list');
  list.innerHTML = '';
  for (const item of sortedItems(mode)) {
    const row = document.createElement('div');
    row.className = `item-row${item.id === selection[mode] ? ' active' : ''}`;
    row.dataset.itemId = item.id;

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = labelFor(mode, item);

    const star = document.createElement('button');
    star.type = 'button';
    star.className = `row-action${item.starred ? ' starred' : ''}`;
    star.textContent = item.starred ? '★' : '☆';
    star.title = item.starred ? 'Unstar' : 'Star';
    star.onclick = (event) => { event.stopPropagation(); toggleStar(item); };

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'row-action delete';
    del.textContent = '×';
    del.title = 'Delete';
    del.onclick = (event) => { event.stopPropagation(); openDeleteDialog(item.id); };

    row.append(label, star, del);
    row.onclick = () => selectItem(item.id);
    list.appendChild(row);
  }
}

function selectItem(id) {
  selection[mode] = id;
  state.lastSelection = { kind: mode, id };
  selectedEdge = null;
  scheduleSave(true);
  renderAll();
}

function createItem(kind = mode) {
  const createdAt = now();
  let item;
  if (kind === 'map') item = { id: uid(), title: '', createdAt, updatedAt: createdAt, starred: false, nodes: [], edges: [] };
  else if (kind === 'brainstorm') item = { id: uid(), title: '', createdAt, updatedAt: createdAt, starred: false, thoughts: [] };
  else item = { id: uid(), title: '', createdAt, updatedAt: createdAt, starred: false, body: '' };
  itemsFor(kind).unshift(item);
  selection[kind] = item.id;
  state.lastSelection = { kind, id: item.id };
  scheduleSave(true);
  renderAll();
  const titleId = kind === 'map' ? 'map-title' : kind === 'brainstorm' ? 'bs-title' : 'note-title';
  setTimeout(() => document.getElementById(titleId)?.focus(), 30);
  return item;
}

function toggleStar(item = current()) {
  if (!item) return;
  item.starred = !item.starred;
  item.updatedAt = now();
  scheduleSave();
  renderAll();
}

function setMode(nextMode) {
  mode = nextMode;
  document.querySelectorAll('.mode-btn').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${mode}`));
  if (!selection[mode]) selection[mode] = itemsFor(mode)[0]?.id || null;
  if (selection[mode]) {
    state.lastSelection = { kind: mode, id: selection[mode] };
    scheduleSave(true);
  }
  selectedEdge = null;
  renderAll();
}

function updateHeaderActions(kind, item) {
  const view = document.getElementById(`view-${kind}`);
  const star = view.querySelector('.star-item');
  const brain = view.querySelector('.brain-btn');
  const remove = view.querySelector('.delete-current');
  for (const button of [star, brain, remove]) button.disabled = !item;
  star.textContent = item?.starred ? '★' : '☆';
  star.classList.toggle('starred', Boolean(item?.starred));
  brain.textContent = item?.brainPath ? 'In Brain' : 'Add to Brain';
  brain.classList.toggle('linked', Boolean(item?.brainPath));
  brain.title = item?.brainPath ? 'Remove the linked Brain copy' : 'Create a linked Markdown copy in Brain';
}

async function toggleBrainLink() {
  const kind = mode;
  const item = current();
  if (!item) return;
  const linked = !item.brainPath;
  if (!linked && !window.confirm('Remove the linked Brain copy? The Mindspace item will stay here.')) return;
  try {
    await flushSave();
    const result = await API.setBrainLink(kind, item.id, linked);
    state = ensureShape(result.state);
    selection[kind] = item.id;
    renderAll();
    showToast(linked ? 'Added to Brain and kept in sync.' : 'Brain copy moved to recoverable trash.');
  } catch (error) {
    showToast(error.message || 'Could not update the Brain link.');
  }
}

function openDeleteDialog(itemId) {
  const item = itemsFor().find((candidate) => candidate.id === itemId);
  if (!item) return;
  const dialog = document.getElementById('delete-dialog');
  dialog.dataset.itemId = itemId;
  document.getElementById('delete-message').textContent = item.brainPath
    ? 'This item has a linked Brain copy. Delete only from Mindspace, or delete both copies.'
    : 'This item will be removed from Mindspace. This cannot be undone.';
  document.getElementById('delete-everywhere').hidden = !item.brainPath;
  document.getElementById('delete-mindspace').textContent = item.brainPath ? 'Delete from Mindspace only' : 'Delete item';
  dialog.hidden = false;
  document.getElementById('delete-cancel').focus();
}

function closeDeleteDialog() {
  const dialog = document.getElementById('delete-dialog');
  dialog.hidden = true;
  delete dialog.dataset.itemId;
}

async function deleteItem(deleteEverywhere) {
  const dialog = document.getElementById('delete-dialog');
  const itemId = dialog.dataset.itemId;
  const collection = itemsFor();
  const index = collection.findIndex((item) => item.id === itemId);
  if (index < 0) return closeDeleteDialog();
  const item = collection[index];
  if (deleteEverywhere && item.brainPath) {
    try {
      await flushSave();
      const result = await API.setBrainLink(mode, item.id, false);
      state = ensureShape(result.state);
    } catch (error) {
      showToast(error.message || 'Could not remove the Brain copy.');
      return;
    }
  }
  const refreshed = itemsFor();
  const refreshedIndex = refreshed.findIndex((candidate) => candidate.id === itemId);
  if (refreshedIndex >= 0) refreshed.splice(refreshedIndex, 1);
  if (selection[mode] === itemId) selection[mode] = refreshed[0]?.id || null;
  state.lastSelection = selection[mode] ? { kind: mode, id: selection[mode] } : null;
  closeDeleteDialog();
  scheduleSave(true);
  renderAll();
  showToast(deleteEverywhere ? 'Deleted from Mindspace and Brain.' : item.brainPath ? 'Deleted from Mindspace; Brain copy kept.' : 'Deleted.');
}

// ---------- Mind maps ----------
const canvasWrap = document.getElementById('canvas-wrap');
const svg = document.getElementById('canvas');

function edgeKey(a, b) { return [a, b].sort().join('|'); }
function edgePath(a, b) {
  const distance = Math.max(50, Math.abs(b.x - a.x) * .48);
  const direction = b.x >= a.x ? 1 : -1;
  return `M ${a.x} ${a.y} C ${a.x + distance * direction} ${a.y}, ${b.x - distance * direction} ${b.y}, ${b.x} ${b.y}`;
}

function renderEdges(map, preview) {
  svg.innerHTML = '';
  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  for (const [aId, bId] of map.edges) {
    const a = byId.get(aId), b = byId.get(bId);
    if (!a || !b) continue;
    const key = edgeKey(aId, bId);
    const visible = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    visible.setAttribute('d', edgePath(a, b));
    visible.setAttribute('class', `edge${selectedEdge === key ? ' selected' : ''}`);
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('d', edgePath(a, b));
    hit.setAttribute('class', 'edge-hit');
    hit.dataset.edgeKey = key;
    hit.addEventListener('click', (event) => { event.stopPropagation(); selectedEdge = key; renderMap(); });
    svg.append(visible, hit);
  }
  if (preview) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', edgePath(preview.from, preview.to));
    path.setAttribute('class', 'edge-preview');
    svg.appendChild(path);
  }
}

function renderMap() {
  const map = current('map');
  canvasWrap.querySelectorAll('.node').forEach((node) => node.remove());
  svg.innerHTML = '';
  const title = document.getElementById('map-title');
  const empty = document.getElementById('empty-map');
  title.value = map?.title || '';
  empty.style.display = map?.nodes?.length ? 'none' : 'flex';
  updateHeaderActions('map', map);
  document.getElementById('delete-edge').hidden = !selectedEdge;
  if (!map) return;
  renderEdges(map);
  for (const node of map.nodes) canvasWrap.appendChild(createNodeElement(map, node));
}

function createNodeElement(map, node) {
  const element = document.createElement('div');
  element.className = `node${node.root ? ' root' : ''}`;
  element.dataset.nodeId = node.id;
  element.style.left = `${node.x}px`;
  element.style.top = `${node.y}px`;

  const left = document.createElement('button');
  left.type = 'button'; left.className = 'connector left'; left.dataset.connector = 'left'; left.title = 'Drag to connect'; left.setAttribute('aria-label', 'Drag to connect this idea');
  const right = document.createElement('button');
  right.type = 'button'; right.className = 'connector right'; right.dataset.connector = 'right'; right.title = 'Drag to connect'; right.setAttribute('aria-label', 'Drag to connect this idea');

  const text = document.createElement('div');
  text.className = 'node-text'; text.contentEditable = 'true'; text.spellcheck = true; text.textContent = node.text;
  text.addEventListener('input', () => { node.text = text.textContent || ''; map.updatedAt = now(); scheduleSave(); renderList(); });
  text.addEventListener('pointerdown', (event) => event.stopPropagation());

  const tools = document.createElement('div'); tools.className = 'node-tools';
  const child = document.createElement('button');
  child.type = 'button'; child.className = 'node-tool'; child.textContent = '+'; child.title = 'Add connected idea';
  child.onclick = (event) => { event.stopPropagation(); addChildNode(map, node); };
  const remove = document.createElement('button');
  remove.type = 'button'; remove.className = 'node-tool delete'; remove.textContent = '×'; remove.title = 'Delete idea';
  remove.onclick = (event) => { event.stopPropagation(); deleteNode(map, node.id); };
  tools.append(child, remove);
  element.append(left, text, tools, right);
  return element;
}

function addNode(x, y, sourceId = null) {
  let map = current('map') || itemsFor('map')[0];
  if (!map) { createItem('map'); map = current('map'); }
  if (selection.map !== map.id) {
    selection.map = map.id;
    state.lastSelection = { kind: 'map', id: map.id };
  }
  const node = { id: uid(), x, y, text: map.nodes.length ? 'New idea' : 'Central idea', root: map.nodes.length === 0 };
  map.nodes.push(node);
  if (sourceId) map.edges.push([sourceId, node.id]);
  map.updatedAt = now();
  scheduleSave(); renderAll();
  setTimeout(() => canvasWrap.querySelector(`.node[data-node-id="${CSS.escape(node.id)}"] .node-text`)?.focus(), 20);
}

function addChildNode(map, source) {
  const siblings = map.edges.filter(([a]) => a === source.id).length;
  addNode(source.x + 220, source.y + siblings * 86 - 20, source.id);
}

function deleteNode(map, nodeId) {
  map.nodes = map.nodes.filter((node) => node.id !== nodeId);
  map.edges = map.edges.filter(([a, b]) => a !== nodeId && b !== nodeId);
  selectedEdge = null;
  scheduleSave(); renderAll();
}

function connectNodes(map, sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return;
  const exists = map.edges.some(([a, b]) => edgeKey(a, b) === edgeKey(sourceId, targetId));
  if (!exists) {
    map.edges.push([sourceId, targetId]);
    map.updatedAt = now();
    scheduleSave();
    showToast('Ideas connected.');
  } else showToast('Those ideas are already connected.');
}

function deleteSelectedEdge() {
  const map = current('map');
  if (!map || !selectedEdge) return;
  map.edges = map.edges.filter(([a, b]) => edgeKey(a, b) !== selectedEdge);
  selectedEdge = null;
  scheduleSave(); renderMap();
}

function autoArrange() {
  const map = current('map');
  if (!map?.nodes.length) return;
  const root = map.nodes.find((node) => node.root) || map.nodes[0];
  const adjacency = new Map(map.nodes.map((node) => [node.id, []]));
  for (const [a, b] of map.edges) { adjacency.get(a)?.push(b); adjacency.get(b)?.push(a); }
  const levels = [[root.id]], visited = new Set([root.id]);
  for (let depth = 0; depth < levels.length; depth++) {
    const next = [];
    for (const id of levels[depth]) for (const neighbor of adjacency.get(id) || []) if (!visited.has(neighbor)) { visited.add(neighbor); next.push(neighbor); }
    if (next.length) levels.push(next);
  }
  const unlinked = map.nodes.filter((node) => !visited.has(node.id)).map((node) => node.id);
  if (unlinked.length) levels.push(unlinked);
  const width = canvasWrap.clientWidth || 900, height = canvasWrap.clientHeight || 600;
  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  levels.forEach((ids, depth) => ids.forEach((id, index) => {
    const node = byId.get(id); if (!node) return;
    node.x = Math.max(110, Math.min(width - 110, 150 + depth * Math.max(190, (width - 300) / Math.max(1, levels.length - 1))));
    node.y = height * (index + 1) / (ids.length + 1);
  }));
  scheduleSave(); renderMap(); showToast('Mind map arranged.');
}

canvasWrap.addEventListener('dblclick', (event) => {
  if (event.target.closest('.node')) return;
  const rect = canvasWrap.getBoundingClientRect();
  addNode(event.clientX - rect.left, event.clientY - rect.top);
});

canvasWrap.addEventListener('pointerdown', (event) => {
  const connector = event.target.closest('.connector');
  const nodeElement = event.target.closest('.node');
  if (connector && nodeElement) {
    const map = current('map');
    const source = map?.nodes.find((node) => node.id === nodeElement.dataset.nodeId);
    if (!map || !source) return;
    interaction = { type: 'connect', sourceId: source.id, x: source.x, y: source.y, targetId: null };
    nodeElement.classList.add('connecting');
    event.preventDefault();
    return;
  }
  if (!nodeElement || event.target.closest('.node-text') || event.target.closest('.node-tool')) {
    if (!nodeElement) { selectedEdge = null; renderMap(); }
    return;
  }
  const map = current('map');
  const node = map?.nodes.find((candidate) => candidate.id === nodeElement.dataset.nodeId);
  if (!map || !node) return;
  const rect = canvasWrap.getBoundingClientRect();
  interaction = { type: 'move', nodeId: node.id, offsetX: event.clientX - rect.left - node.x, offsetY: event.clientY - rect.top - node.y, moved: false };
  nodeElement.classList.add('dragging');
  nodeElement.setPointerCapture?.(event.pointerId);
  event.preventDefault();
});

window.addEventListener('pointermove', (event) => {
  if (!interaction) return;
  const map = current('map');
  if (!map) return;
  const rect = canvasWrap.getBoundingClientRect();
  const x = event.clientX - rect.left, y = event.clientY - rect.top;
  if (interaction.type === 'move') {
    const node = map.nodes.find((candidate) => candidate.id === interaction.nodeId);
    if (!node) return;
    node.x = Math.max(35, Math.min(rect.width - 35, x - interaction.offsetX));
    node.y = Math.max(35, Math.min(rect.height - 35, y - interaction.offsetY));
    interaction.moved = true;
    const element = canvasWrap.querySelector(`.node[data-node-id="${CSS.escape(node.id)}"]`);
    if (element) { element.style.left = `${node.x}px`; element.style.top = `${node.y}px`; }
    renderEdges(map);
    return;
  }
  document.querySelectorAll('.node.connect-target').forEach((node) => node.classList.remove('connect-target'));
  const targetElement = document.elementFromPoint(event.clientX, event.clientY)?.closest('.node');
  const targetId = targetElement?.dataset.nodeId;
  interaction.targetId = targetId && targetId !== interaction.sourceId ? targetId : null;
  if (interaction.targetId) targetElement.classList.add('connect-target');
  renderEdges(map, { from: { x: interaction.x, y: interaction.y }, to: { x, y } });
});

window.addEventListener('pointerup', () => {
  if (!interaction) return;
  const map = current('map');
  document.querySelectorAll('.node.dragging,.node.connecting,.node.connect-target').forEach((node) => node.classList.remove('dragging', 'connecting', 'connect-target'));
  if (map && interaction.type === 'connect') connectNodes(map, interaction.sourceId, interaction.targetId);
  if (map && interaction.type === 'move' && interaction.moved) scheduleSave();
  interaction = null;
  if (map) renderMap();
});

canvasWrap.addEventListener('keydown', (event) => {
  if ((event.key === 'Delete' || event.key === 'Backspace') && selectedEdge) { event.preventDefault(); deleteSelectedEdge(); }
  if (event.key === 'Escape') { interaction = null; selectedEdge = null; renderMap(); }
});

// ---------- Brainstorm ----------
function renderBrainstorm() {
  const session = current('brainstorm');
  document.getElementById('bs-title').value = session?.title || '';
  updateHeaderActions('brainstorm', session);
  const cards = document.getElementById('bs-cards');
  cards.innerHTML = '';
  if (!session) return;
  for (const thought of session.thoughts) {
    const card = document.createElement('div'); card.className = 'bs-card';
    const text = document.createElement('div'); text.className = 'bs-text'; text.contentEditable = 'true'; text.spellcheck = true; text.textContent = thought.text;
    text.addEventListener('input', () => { thought.text = text.textContent || ''; session.updatedAt = now(); scheduleSave(); renderList(); });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'bs-del'; remove.textContent = '×'; remove.title = 'Delete idea';
    remove.onclick = () => { session.thoughts = session.thoughts.filter((candidate) => candidate.id !== thought.id); scheduleSave(); renderBrainstorm(); renderList(); };
    card.append(text, remove); cards.appendChild(card);
  }
}

// ---------- Notes ----------
function renderNotes() {
  const note = current('notes');
  document.getElementById('note-title').value = note?.title || '';
  document.getElementById('note-body').value = note?.body || '';
  updateHeaderActions('notes', note);
}

function renderAll() {
  renderList();
  if (mode === 'map') renderMap();
  else if (mode === 'brainstorm') renderBrainstorm();
  else renderNotes();
}

function bindTitle(inputId, kind) {
  document.getElementById(inputId).addEventListener('input', (event) => {
    const item = current(kind); if (!item) return;
    item.title = event.target.value; item.updatedAt = now(); scheduleSave(); renderList();
  });
}

bindTitle('map-title', 'map'); bindTitle('bs-title', 'brainstorm'); bindTitle('note-title', 'notes');
document.getElementById('note-body').addEventListener('input', (event) => {
  let note = current('notes'); if (!note) { createItem('notes'); note = current('notes'); }
  note.body = event.target.value; note.updatedAt = now(); scheduleSave(); renderList();
});
document.getElementById('bs-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.getElementById('bs-input'); const value = input.value.trim(); if (!value) return;
  let session = current('brainstorm'); if (!session) { createItem('brainstorm'); session = current('brainstorm'); }
  session.thoughts.unshift({ id: uid(), text: value }); input.value = ''; session.updatedAt = now(); scheduleSave(); renderAll();
});

document.querySelectorAll('.mode-btn').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
document.getElementById('new-item').addEventListener('click', () => createItem());
document.getElementById('add-node').addEventListener('click', () => {
  addNode((canvasWrap.clientWidth || 900) / 2, (canvasWrap.clientHeight || 600) / 2);
});
document.getElementById('empty-add-node').addEventListener('click', () => document.getElementById('add-node').click());
document.getElementById('auto-arrange').addEventListener('click', autoArrange);
document.getElementById('delete-edge').addEventListener('click', deleteSelectedEdge);
document.querySelectorAll('.star-item').forEach((button) => button.addEventListener('click', () => toggleStar()));
document.querySelectorAll('.brain-btn').forEach((button) => button.addEventListener('click', () => void toggleBrainLink()));
document.querySelectorAll('.delete-current').forEach((button) => button.addEventListener('click', () => { const item = current(); if (item) openDeleteDialog(item.id); }));
document.getElementById('delete-cancel').addEventListener('click', closeDeleteDialog);
document.getElementById('delete-mindspace').addEventListener('click', () => void deleteItem(false));
document.getElementById('delete-everywhere').addEventListener('click', () => void deleteItem(true));
document.getElementById('delete-dialog').addEventListener('click', (event) => { if (event.target.id === 'delete-dialog') closeDeleteDialog(); });

window.addEventListener('rowboat:data-change', (event) => {
  // The host reloads apps after data changes unless the app explicitly takes
  // ownership of the event. Mindspace refreshes state in place so an autosave
  // never tears down an active drag, text edit, voice action, or pending link.
  event.preventDefault();
  if (dirty) return;
  void API.load().then((next) => {
    if (next.updatedAt === state.updatedAt) return;
    state = ensureShape(next);
    const selected = state.lastSelection;
    if (selected) selection[selected.kind] = selected.id;
    renderAll();
  }).catch(() => {});
});

async function initialize() {
  try { const info = await API.app(); document.documentElement.dataset.theme = info.theme === 'dark' ? 'dark' : 'light'; } catch { document.documentElement.dataset.theme = 'light'; }
  try { state = ensureShape(await API.load()); }
  catch (error) { state = freshState(); setSaveStatus('error', 'Load failed'); showToast(error.message || 'Mindspace could not load.'); }
  if (state.lastSelection) selection[state.lastSelection.kind] = state.lastSelection.id;
  selection.map ||= state.maps[0]?.id || null;
  selection.brainstorm ||= state.brainstorm[0]?.id || null;
  selection.notes ||= state.notes[0]?.id || null;
  setMode(state.lastSelection?.kind || 'map');
}

void initialize();
