import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { WorkDir } from '../config/config.js';
import * as workspaceFiles from '../filesystem/files.js';

export const MINDSPACE_FOLDER = 'mindspace';
export const MINDSPACE_DATA_FILE = 'state.json';
export const MINDSPACE_ENHANCEMENT_VERSION = 3;

const MindspaceNodeSchema = z.object({
    id: z.string().min(1).max(100),
    x: z.number().finite(),
    y: z.number().finite(),
    text: z.string().max(20_000),
    root: z.boolean().optional(),
});

const MindspaceItemBaseSchema = z.object({
    id: z.string().min(1).max(100),
    title: z.string().max(1_000).default(''),
    createdAt: z.string().max(100),
    updatedAt: z.string().max(100).optional(),
    starred: z.boolean().optional().default(false),
    brainPath: z.string().max(2_000).optional(),
    brainSyncedAt: z.string().max(100).optional(),
});

const MindspaceMapSchema = MindspaceItemBaseSchema.extend({
    nodes: z.array(MindspaceNodeSchema).max(1_000).default([]),
    edges: z.array(z.tuple([z.string().max(100), z.string().max(100)])).max(4_000).default([]),
});

const MindspaceBrainstormSchema = MindspaceItemBaseSchema.extend({
    thoughts: z.array(z.object({
        id: z.string().min(1).max(100),
        text: z.string().max(50_000),
    })).max(4_000).default([]),
});

const MindspaceNoteSchema = MindspaceItemBaseSchema.extend({
    body: z.string().max(2_000_000).default(''),
});

export const MindspaceStateSchema = z.object({
    updatedAt: z.string().max(100),
    maps: z.array(MindspaceMapSchema).max(1_000).default([]),
    brainstorm: z.array(MindspaceBrainstormSchema).max(1_000).default([]),
    notes: z.array(MindspaceNoteSchema).max(1_000).default([]),
    lastSelection: z.object({
        kind: z.enum(['map', 'brainstorm', 'notes']),
        id: z.string().min(1).max(100),
    }).nullable().optional(),
});

export type MindspaceState = z.infer<typeof MindspaceStateSchema>;
export type MindspaceKind = 'map' | 'brainstorm' | 'notes';
export type MindspaceItem = MindspaceState['maps'][number]
    | MindspaceState['brainstorm'][number]
    | MindspaceState['notes'][number];

export type MindspaceAction = {
    action:
        | 'list'
        | 'read'
        | 'create'
        | 'update-item'
        | 'delete-item'
        | 'add-node'
        | 'update-node'
        | 'delete-node'
        | 'connect-nodes'
        | 'disconnect-nodes'
        | 'add-thought'
        | 'update-thought'
        | 'delete-thought'
        | 'add-to-brain'
        | 'remove-from-brain';
    kind?: MindspaceKind;
    itemId?: string;
    title?: string;
    body?: string;
    text?: string;
    nodeId?: string;
    thoughtId?: string;
    sourceNodeId?: string;
    targetNodeId?: string;
    x?: number;
    y?: number;
    starred?: boolean;
    deleteEverywhere?: boolean;
};

const defaultState = (): MindspaceState => ({
    updatedAt: new Date().toISOString(),
    maps: [],
    brainstorm: [],
    notes: [],
    lastSelection: null,
});

const appRoot = () => path.join(WorkDir, 'apps', MINDSPACE_FOLDER);
const dataPath = () => path.join(appRoot(), 'data', MINDSPACE_DATA_FILE);

function uid(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeBrainPath(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const normalized = value.replace(/\\/g, '/');
    if (!normalized.startsWith('knowledge/Brain/Mindspace/') || !normalized.endsWith('.md') || normalized.includes('..')) {
        return undefined;
    }
    return normalized;
}

export function normalizeMindspaceState(input: unknown): MindspaceState {
    const parsed = MindspaceStateSchema.safeParse(input);
    let state: MindspaceState;
    if (!parsed.success) {
        const source = input && typeof input === 'object' ? input as Record<string, unknown> : {};
        const fallback = {
            updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString(),
            maps: Array.isArray(source.maps) ? source.maps : [],
            brainstorm: Array.isArray(source.brainstorm) ? source.brainstorm : [],
            notes: Array.isArray(source.notes) ? source.notes : [],
            lastSelection: source.lastSelection ?? null,
        };
        const repaired = MindspaceStateSchema.safeParse(fallback);
        if (!repaired.success) return defaultState();
        state = repaired.data;
    } else state = parsed.data;
    for (const item of [...state.maps, ...state.brainstorm, ...state.notes]) {
        item.brainPath = safeBrainPath(item.brainPath);
    }
    for (const map of state.maps) {
        const nodeIds = new Set(map.nodes.map((node) => node.id));
        const seen = new Set<string>();
        map.edges = map.edges.filter(([a, b]) => {
            if (a === b || !nodeIds.has(a) || !nodeIds.has(b)) return false;
            const key = [a, b].sort().join('|');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
    if (state.lastSelection) {
        const selected = itemsFor(state, state.lastSelection.kind).some((item) => item.id === state.lastSelection?.id);
        if (!selected) state.lastSelection = null;
    }
    return state;
}

function assetsDirectory(): string {
    const configured = process.env.ROWBOAT_MINDSPACE_ASSETS_DIR?.trim();
    if (configured) return path.resolve(configured);
    return path.join(path.dirname(fileURLToPath(import.meta.url)), 'mindspace');
}

async function writeIfChanged(target: string, content: string | Buffer): Promise<void> {
    let current: Buffer | null = null;
    try { current = await fsp.readFile(target); } catch { /* missing */ }
    const next = Buffer.isBuffer(content) ? content : Buffer.from(content);
    if (current?.equals(next)) return;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${Math.random().toString(16).slice(2, 10)}`;
    await fsp.writeFile(tmp, next);
    await fsp.rename(tmp, target);
}

/**
 * Materialize the promoted first-party Mindspace experience without touching
 * its data directory. A one-time upstream backup makes the visual enhancement
 * recoverable, while the version marker makes every later startup idempotent.
 */
export async function ensureFirstClassMindspaceApp(): Promise<void> {
    const root = appRoot();
    const dist = path.join(root, 'dist');
    const markerPath = path.join(root, '.rowboat-mindspace-enhancement.json');
    let markerVersion = 0;
    try {
        markerVersion = Number(JSON.parse(await fsp.readFile(markerPath, 'utf8')).version) || 0;
    } catch { /* first enhancement */ }

    if (markerVersion >= MINDSPACE_ENHANCEMENT_VERSION
        && fs.existsSync(path.join(dist, 'app.js'))
        && fs.existsSync(path.join(dist, 'index.html'))
        && fs.existsSync(path.join(dist, 'styles.css'))) return;

    const assets = assetsDirectory();
    const required = ['app.js', 'index.html', 'styles.css', 'LICENSE'];
    for (const file of required) {
        if (!fs.existsSync(path.join(assets, file))) {
            throw new Error(`Bundled Mindspace asset is missing: ${file}`);
        }
    }

    await fsp.mkdir(path.join(root, 'data'), { recursive: true });
    if (fs.existsSync(dist) && markerVersion === 0) {
        const backup = path.join(root, '.mindspace-upstream-backup');
        if (!fs.existsSync(backup)) await fsp.cp(dist, backup, { recursive: true });
    }
    await fsp.mkdir(dist, { recursive: true });
    for (const file of ['app.js', 'index.html', 'styles.css']) {
        await writeIfChanged(path.join(dist, file), await fsp.readFile(path.join(assets, file)));
    }
    await writeIfChanged(path.join(root, 'LICENSE.mindspace'), await fsp.readFile(path.join(assets, 'LICENSE')));

    const manifestPath = path.join(root, 'rowboat-app.json');
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as Record<string, unknown>; } catch { /* create */ }
    await writeIfChanged(manifestPath, `${JSON.stringify({
        ...existing,
        schemaVersion: 1,
        name: 'mindspace',
        version: '0.2.0',
        description: 'Persistent mind maps, brainstorming, journals, notes, Brain links, and agent-aware context',
        entry: 'index.html',
        capabilities: [],
        dataContracts: [{
            file: MINDSPACE_DATA_FILE,
            requiredKeys: ['updatedAt', 'maps', 'brainstorm', 'notes'],
            nonEmptyArrayKeys: [],
        }],
    }, null, 2)}\n`);
    if (!fs.existsSync(dataPath())) await writeMindspaceState(defaultState(), { syncBrain: false });
    await writeIfChanged(markerPath, `${JSON.stringify({
        version: MINDSPACE_ENHANCEMENT_VERSION,
        source: 'Rowboat first-class Mindspace integration',
        upstream: 'Gagancreates/mindspace',
        license: 'MIT',
        updatedAt: new Date().toISOString(),
    }, null, 2)}\n`);
}

export async function readMindspaceState(): Promise<MindspaceState> {
    await ensureFirstClassMindspaceApp();
    try {
        return normalizeMindspaceState(JSON.parse(await fsp.readFile(dataPath(), 'utf8')));
    } catch {
        return defaultState();
    }
}

function itemsFor(state: MindspaceState, kind: MindspaceKind): MindspaceItem[] {
    if (kind === 'map') return state.maps;
    if (kind === 'brainstorm') return state.brainstorm;
    return state.notes;
}

function findItem(state: MindspaceState, kind: MindspaceKind, itemId: string): MindspaceItem {
    const item = itemsFor(state, kind).find((candidate) => candidate.id === itemId);
    if (!item) throw new Error(`No ${kind} item named ${itemId}`);
    return item;
}

function itemLabel(kind: MindspaceKind, item: MindspaceItem): string {
    if (item.title.trim()) return item.title.trim();
    if (kind === 'notes' && 'body' in item && item.body.trim()) return item.body.trim().split(/\r?\n/)[0].slice(0, 80);
    if (kind === 'brainstorm' && 'thoughts' in item && item.thoughts[0]?.text) return item.thoughts[0].text.slice(0, 80);
    if (kind === 'map' && 'nodes' in item && item.nodes[0]?.text) return item.nodes[0].text.slice(0, 80);
    return kind === 'map' ? 'Untitled map' : kind === 'brainstorm' ? 'Untitled brainstorm' : 'Untitled note';
}

function markdownForItem(kind: MindspaceKind, item: MindspaceItem): string {
    const title = itemLabel(kind, item);
    if (kind === 'notes' && 'body' in item) {
        return `# ${title}\n\n${item.body.trim() || '_Empty note_'}\n`;
    }
    if (kind === 'brainstorm' && 'thoughts' in item) {
        const thoughts = item.thoughts.map((thought) => `- ${thought.text}`).join('\n') || '- _No thoughts yet_';
        return `# ${title}\n\n## Ideas\n\n${thoughts}\n`;
    }
    if (kind === 'map' && 'nodes' in item) {
        const byId = new Map(item.nodes.map((node) => [node.id, node.text]));
        const ideas = item.nodes.map((node) => `- ${node.root ? '**Central idea:** ' : ''}${node.text}`).join('\n') || '- _No ideas yet_';
        const links = item.edges.map(([a, b]) => `- ${byId.get(a) ?? a} ↔ ${byId.get(b) ?? b}`).join('\n') || '- _No connections yet_';
        return `# ${title}\n\n## Ideas\n\n${ideas}\n\n## Connections\n\n${links}\n`;
    }
    return `# ${title}\n`;
}

const MANAGED_START = '<!-- mindspace:managed:start -->';
const MANAGED_END = '<!-- mindspace:managed:end -->';

function managedBlock(kind: MindspaceKind, item: MindspaceItem): string {
    return `${MANAGED_START}\n${markdownForItem(kind, item).trim()}\n${MANAGED_END}`;
}

function brainFrontmatter(kind: MindspaceKind, item: MindspaceItem): string {
    return [
        '---',
        `title: ${JSON.stringify(itemLabel(kind, item))}`,
        'source: mindspace',
        `mindspace_kind: ${kind}`,
        `mindspace_id: ${JSON.stringify(item.id)}`,
        `mindspace_starred: ${item.starred ? 'true' : 'false'}`,
        `updated: ${JSON.stringify(new Date().toISOString())}`,
        '---',
    ].join('\n');
}

async function syncBrainItem(kind: MindspaceKind, item: MindspaceItem): Promise<void> {
    if (!item.brainPath) return;
    const block = managedBlock(kind, item);
    let existing = '';
    try { existing = await fsp.readFile(path.join(WorkDir, ...item.brainPath.split('/')), 'utf8'); } catch { /* create */ }
    let body: string;
    const start = existing.indexOf(MANAGED_START);
    const end = existing.indexOf(MANAGED_END);
    if (start >= 0 && end >= start) {
        body = `${existing.slice(0, start)}${block}${existing.slice(end + MANAGED_END.length)}`;
        if (body.startsWith('---')) {
            const frontmatterEnd = body.indexOf('\n---', 3);
            if (frontmatterEnd >= 0) body = `${brainFrontmatter(kind, item)}${body.slice(frontmatterEnd + 4)}`;
        }
    } else if (existing.trim()) {
        body = `${existing.trimEnd()}\n\n${block}\n`;
    } else {
        body = `${brainFrontmatter(kind, item)}\n\n${block}\n`;
    }
    await workspaceFiles.writeText(item.brainPath, body, { mkdirp: true, atomic: true });
    item.brainSyncedAt = new Date().toISOString();
}

let mutationQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = mutationQueue.then(operation, operation);
    mutationQueue = run.then(() => undefined, () => undefined);
    return run;
}

export async function writeMindspaceState(
    input: unknown,
    options: { syncBrain?: boolean } = {},
): Promise<MindspaceState> {
    return serialized(async () => {
        const baseUpdatedAt = input && typeof input === 'object' && typeof (input as Record<string, unknown>)._baseUpdatedAt === 'string'
            ? String((input as Record<string, unknown>)._baseUpdatedAt)
            : undefined;
        let state = normalizeMindspaceState(input);
        if (baseUpdatedAt) {
            let current: MindspaceState | undefined;
            try { current = normalizeMindspaceState(JSON.parse(await fsp.readFile(dataPath(), 'utf8'))); } catch { /* first write */ }
            if (current && current.updatedAt !== baseUpdatedAt) {
                const baseTime = Date.parse(baseUpdatedAt) || 0;
                const mergeItems = <T extends MindspaceItem>(incoming: T[], existing: T[]): T[] => {
                    const existingById = new Map(existing.map((item) => [item.id, item]));
                    const merged = incoming.map((item) => {
                        const prior = existingById.get(item.id);
                        if (!prior) return item;
                        existingById.delete(item.id);
                        const incomingTime = Date.parse(item.updatedAt ?? item.createdAt) || 0;
                        const existingTime = Date.parse(prior.updatedAt ?? prior.createdAt) || 0;
                        return existingTime > baseTime && existingTime > incomingTime ? prior : item;
                    });
                    for (const item of existingById.values()) {
                        const existingTime = Date.parse(item.updatedAt ?? item.createdAt) || 0;
                        if (existingTime > baseTime) merged.push(item);
                    }
                    return merged;
                };
                state = {
                    ...state,
                    maps: mergeItems(state.maps, current.maps),
                    brainstorm: mergeItems(state.brainstorm, current.brainstorm),
                    notes: mergeItems(state.notes, current.notes),
                };
            }
        }
        state.updatedAt = new Date().toISOString();
        if (options.syncBrain !== false) {
            for (const [kind, items] of [
                ['map', state.maps],
                ['brainstorm', state.brainstorm],
                ['notes', state.notes],
            ] as const) {
                for (const item of items) await syncBrainItem(kind, item);
            }
        }
        await fsp.mkdir(path.dirname(dataPath()), { recursive: true });
        const tmp = `${dataPath()}.tmp-${Math.random().toString(16).slice(2, 10)}`;
        await fsp.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
        await fsp.rename(tmp, dataPath());
        return state;
    });
}

function brainSlug(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'mindspace';
}

async function addItemToBrainUnlocked(state: MindspaceState, kind: MindspaceKind, item: MindspaceItem): Promise<void> {
    if (!item.brainPath) {
        item.brainPath = `knowledge/Brain/Mindspace/${brainSlug(itemLabel(kind, item))}-${brainSlug(item.id)}.md`;
    }
    item.updatedAt = new Date().toISOString();
    await syncBrainItem(kind, item);
    state.updatedAt = new Date().toISOString();
}

async function removeItemFromBrainUnlocked(item: MindspaceItem): Promise<void> {
    if (!item.brainPath) return;
    try { await workspaceFiles.remove(item.brainPath, { trash: true }); } catch { /* already absent */ }
    delete item.brainPath;
    delete item.brainSyncedAt;
    item.updatedAt = new Date().toISOString();
}

async function persistUnlocked(state: MindspaceState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await fsp.mkdir(path.dirname(dataPath()), { recursive: true });
    const tmp = `${dataPath()}.tmp-${Math.random().toString(16).slice(2, 10)}`;
    await fsp.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await fsp.rename(tmp, dataPath());
}

export async function setMindspaceBrainLink(kind: MindspaceKind, itemId: string, linked: boolean): Promise<MindspaceState> {
    await ensureFirstClassMindspaceApp();
    return serialized(async () => {
        const state = await readMindspaceState();
        const item = findItem(state, kind, itemId);
        if (linked) await addItemToBrainUnlocked(state, kind, item);
        else await removeItemFromBrainUnlocked(item);
        await persistUnlocked(state);
        return state;
    });
}

function newItem(kind: MindspaceKind, input: MindspaceAction): MindspaceItem {
    const createdAt = new Date().toISOString();
    const base = { id: uid(), title: input.title?.trim() ?? '', createdAt, updatedAt: createdAt, starred: input.starred ?? false };
    if (kind === 'map') {
        const central = input.text?.trim() || input.body?.trim() || 'Central idea';
        return { ...base, nodes: [{ id: uid(), x: 420, y: 280, text: central, root: true }], edges: [] };
    }
    if (kind === 'brainstorm') {
        return { ...base, thoughts: input.text?.trim() ? [{ id: uid(), text: input.text.trim() }] : [] };
    }
    return { ...base, body: input.body ?? input.text ?? '' };
}

export async function runMindspaceAction(input: MindspaceAction): Promise<Record<string, unknown>> {
    await ensureFirstClassMindspaceApp();
    if (input.action === 'list') {
        const state = await readMindspaceState();
        return {
            success: true,
            updatedAt: state.updatedAt,
            lastSelection: state.lastSelection,
            maps: state.maps.map((item) => ({ id: item.id, title: itemLabel('map', item), starred: item.starred, inBrain: Boolean(item.brainPath) })),
            brainstorms: state.brainstorm.map((item) => ({ id: item.id, title: itemLabel('brainstorm', item), starred: item.starred, inBrain: Boolean(item.brainPath) })),
            notes: state.notes.map((item) => ({ id: item.id, title: itemLabel('notes', item), starred: item.starred, inBrain: Boolean(item.brainPath) })),
        };
    }
    if (!input.kind) return { success: false, error: `${input.action} requires kind` };
    if (input.action === 'read') {
        if (!input.itemId) return { success: false, error: 'read requires itemId' };
        const state = await readMindspaceState();
        const item = findItem(state, input.kind, input.itemId);
        return { success: true, kind: input.kind, item, markdown: markdownForItem(input.kind, item) };
    }

    return serialized(async () => {
        const state = await readMindspaceState();
        if (input.action === 'create') {
            const item = newItem(input.kind!, input);
            itemsFor(state, input.kind!).unshift(item);
            state.lastSelection = { kind: input.kind!, id: item.id };
            await persistUnlocked(state);
            return { success: true, kind: input.kind, item };
        }
        if (!input.itemId) return { success: false, error: `${input.action} requires itemId` };
        const item = findItem(state, input.kind!, input.itemId);

        if (input.action === 'update-item') {
            if (input.title !== undefined) item.title = input.title.slice(0, 1_000);
            if (input.starred !== undefined) item.starred = input.starred;
            if (input.kind === 'notes' && 'body' in item && input.body !== undefined) item.body = input.body.slice(0, 2_000_000);
        } else if (input.action === 'delete-item') {
            if (input.deleteEverywhere) await removeItemFromBrainUnlocked(item);
            const collection = itemsFor(state, input.kind!);
            collection.splice(collection.findIndex((candidate) => candidate.id === item.id), 1);
            if (state.lastSelection?.id === item.id) state.lastSelection = null;
            await persistUnlocked(state);
            return { success: true, deleted: true, brainCopyKept: Boolean(item.brainPath) };
        } else if (input.action === 'add-to-brain') {
            await addItemToBrainUnlocked(state, input.kind!, item);
        } else if (input.action === 'remove-from-brain') {
            await removeItemFromBrainUnlocked(item);
        } else if (input.kind === 'map' && 'nodes' in item) {
            if (input.action === 'add-node') {
                const node = { id: uid(), x: input.x ?? 520, y: input.y ?? 320, text: (input.text ?? 'Idea').slice(0, 20_000) };
                item.nodes.push(node);
                if (input.sourceNodeId && item.nodes.some((candidate) => candidate.id === input.sourceNodeId)) {
                    item.edges.push([input.sourceNodeId, node.id]);
                }
            } else if (input.action === 'update-node') {
                const node = item.nodes.find((candidate) => candidate.id === input.nodeId);
                if (!node) return { success: false, error: `No node ${input.nodeId}` };
                if (input.text !== undefined) node.text = input.text.slice(0, 20_000);
                if (input.x !== undefined) node.x = input.x;
                if (input.y !== undefined) node.y = input.y;
            } else if (input.action === 'delete-node') {
                if (!input.nodeId) return { success: false, error: 'delete-node requires nodeId' };
                item.nodes = item.nodes.filter((candidate) => candidate.id !== input.nodeId);
                item.edges = item.edges.filter(([a, b]) => a !== input.nodeId && b !== input.nodeId);
            } else if (input.action === 'connect-nodes' || input.action === 'disconnect-nodes') {
                const a = input.sourceNodeId;
                const b = input.targetNodeId;
                if (!a || !b || a === b || !item.nodes.some((node) => node.id === a) || !item.nodes.some((node) => node.id === b)) {
                    return { success: false, error: `${input.action} requires two different existing node IDs` };
                }
                const matches = ([x, y]: [string, string]) => (x === a && y === b) || (x === b && y === a);
                if (input.action === 'connect-nodes' && !item.edges.some(matches)) item.edges.push([a, b]);
                if (input.action === 'disconnect-nodes') item.edges = item.edges.filter((edge) => !matches(edge));
            } else {
                return { success: false, error: `${input.action} is not valid for a map` };
            }
        } else if (input.kind === 'brainstorm' && 'thoughts' in item) {
            if (input.action === 'add-thought') item.thoughts.unshift({ id: uid(), text: (input.text ?? '').slice(0, 50_000) });
            else if (input.action === 'update-thought') {
                const thought = item.thoughts.find((candidate) => candidate.id === input.thoughtId);
                if (!thought) return { success: false, error: `No thought ${input.thoughtId}` };
                thought.text = (input.text ?? '').slice(0, 50_000);
            } else if (input.action === 'delete-thought') {
                item.thoughts = item.thoughts.filter((candidate) => candidate.id !== input.thoughtId);
            } else return { success: false, error: `${input.action} is not valid for a brainstorm` };
        } else {
            return { success: false, error: `${input.action} is not valid for ${input.kind}` };
        }

        item.updatedAt = new Date().toISOString();
        if (item.brainPath) await syncBrainItem(input.kind!, item);
        await persistUnlocked(state);
        return { success: true, kind: input.kind, item };
    });
}

export async function getMindspaceContext(): Promise<{
    kind: 'mindspace';
    contextId: string;
    title: string;
    selectedKind?: MindspaceKind;
    selectedId?: string;
    content: string;
    capturedAt: string;
}> {
    const state = await readMindspaceState();
    const selected = state.lastSelection
        ? itemsFor(state, state.lastSelection.kind).find((item) => item.id === state.lastSelection?.id)
        : undefined;
    const sections: string[] = [];
    if (selected && state.lastSelection) {
        sections.push(`## Currently selected ${state.lastSelection.kind}\n\n${markdownForItem(state.lastSelection.kind, selected)}`);
    }
    for (const [kind, items] of [
        ['map', state.maps],
        ['brainstorm', state.brainstorm],
        ['notes', state.notes],
    ] as const) {
        const remaining = items.filter((item) => item.id !== selected?.id);
        if (!remaining.length) continue;
        sections.push(`## Other ${kind} items\n\n${remaining.map((item) => markdownForItem(kind, item)).join('\n\n---\n\n')}`);
    }
    return {
        kind: 'mindspace',
        contextId: `mindspace:${state.updatedAt}`,
        title: selected && state.lastSelection ? itemLabel(state.lastSelection.kind, selected) : 'Mindspace',
        ...(state.lastSelection ? { selectedKind: state.lastSelection.kind, selectedId: state.lastSelection.id } : {}),
        content: sections.join('\n\n').slice(0, 60_000) || 'Mindspace is empty.',
        capturedAt: new Date().toISOString(),
    };
}
