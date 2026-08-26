import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { buildNotebookContextFromManifest, getNotebook, type NotebookContextSnapshot, type NotebookDescriptor } from './notebooks.js';
import { exists, readFile, rename, resolveWorkspacePath, writeFile } from '../workspace/workspace.js';
import { withFileLock } from './file-lock.js';

const STUDY_STATE_FILE = '.rowboat-study.json';
const STUDY_SETS_FILE = '.rowboat-study-sets.json';
const STUDY_SET_STATE_DIR = '.rowboat-study-sets';
const MAX_STUDY_CARDS = 80;
const MAX_STUDY_SESSIONS = 730;
const MAX_WORKSPACE_CACHE = 24;
const workspaceCache = new Map<string, StudyWorkspace>();

export const StudyActivityConfigSchema = z.object({
    flashcardCount: z.number().int().min(5).max(80).default(20),
    quizQuestionCount: z.number().int().min(5).max(50).default(10),
    quizTypes: z.array(z.enum(['multiple-choice', 'true-false', 'short-answer'])).min(1).default(['multiple-choice']),
    difficulty: z.enum(['adaptive', 'introductory', 'intermediate', 'advanced']).default('adaptive'),
    topics: z.array(z.string().min(1).max(120)).max(20).default([]),
    includeExplanations: z.boolean().default(true),
});

export const StudySetSchema = z.object({
    id: z.string().min(1).max(100),
    title: z.string().min(1).max(160),
    starred: z.boolean().default(false),
    description: z.string().max(2_000).default(''),
    sourcePaths: z.array(z.string().min(1)).default([]),
    activityConfig: StudyActivityConfigSchema.default({
        flashcardCount: 20,
        quizQuestionCount: 10,
        quizTypes: ['multiple-choice'],
        difficulty: 'adaptive',
        topics: [],
        includeExplanations: true,
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
});
const StudySetRegistrySchema = z.object({ version: z.literal(1), sets: z.array(StudySetSchema) });
export type StudySet = z.infer<typeof StudySetSchema>;

export const StudyRatingSchema = z.enum(['again', 'hard', 'good', 'easy']);
export type StudyRating = z.infer<typeof StudyRatingSchema>;

const StudySettingsSchema = z.object({
    examDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    dailyGoalMinutes: z.number().int().min(5).max(480).default(25),
    sessionMinutes: z.number().int().min(5).max(180).default(25),
});

const StudyCardProgressSchema = z.object({
    repetitions: z.number().int().nonnegative().default(0),
    lapses: z.number().int().nonnegative().default(0),
    intervalDays: z.number().min(0).max(3650).default(0),
    ease: z.number().min(1.3).max(3).default(2.5),
    dueAt: z.string().nullable().default(null),
    lastReviewedAt: z.string().nullable().default(null),
});

const StudySessionSchema = z.object({
    id: z.string().min(1),
    idempotencyKey: z.string().min(1),
    completedAt: z.string(),
    localDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    minutes: z.number().int().min(1).max(720),
    mode: z.enum(['flashcards', 'quiz', 'tutor', 'review', 'other']).default('other'),
});

const StudyStateSchema = z.object({
    version: z.literal(1),
    settings: StudySettingsSchema.default({
        examDate: null,
        dailyGoalMinutes: 25,
        sessionMinutes: 25,
    }),
    cards: z.record(z.string(), StudyCardProgressSchema).default({}),
    reviewKeys: z.array(z.string()).max(5_000).default([]),
    sessions: z.array(StudySessionSchema).max(MAX_STUDY_SESSIONS).default([]),
    lastRecoveryPath: z.string().nullable().default(null),
    createdAt: z.string(),
    updatedAt: z.string(),
});

export type StudySettings = z.infer<typeof StudySettingsSchema>;
export type StudyCardProgress = z.infer<typeof StudyCardProgressSchema>;
export type StudyState = z.infer<typeof StudyStateSchema>;

export type StudyCard = {
    id: string;
    front: string;
    back: string;
    sourceId: string;
    sourcePath: string;
    sourceTitle: string;
};

export type StudyQuizQuestion = {
    id: string;
    prompt: string;
    options: string[];
    correctIndex: number;
    explanation: string;
    sourceId: string;
    sourcePath: string;
    sourceTitle: string;
};

export type StudyWorkspace = {
    notebook: NotebookDescriptor;
    studySet: StudySet;
    settings: StudySettings;
    cards: StudyCard[];
    quiz: StudyQuizQuestion[];
    progress: {
        totalMinutes: number;
        todayMinutes: number;
        sessionsCompleted: number;
        currentStreak: number;
        reviewProgressPercent: number;
        dueCount: number;
        reviewedCount: number;
        lastStudiedAt: string | null;
        nextDueAt: string | null;
        cardProgress: Record<string, StudyCardProgress>;
    };
    retrievalEvidence: NotebookContextSnapshot['retrievalEvidence'];
    unavailableSources: NotebookContextSnapshot['unavailableSources'];
    coverageNotice: string;
    lastRecoveryPath: string | null;
    generatedAt: string;
};

type StudySection = {
    title: string;
    body: string;
};

function registryPath(notebookPath: string): string {
    return `${notebookPath}/${STUDY_SETS_FILE}`;
}

function statePath(notebookPath: string, studySetId?: string): string {
    return studySetId ? `${notebookPath}/${STUDY_SET_STATE_DIR}/${studySetId}.json` : `${notebookPath}/${STUDY_STATE_FILE}`;
}

function defaultStudySet(notebook: NotebookDescriptor): StudySet {
    const now = notebook.createdAt || new Date().toISOString();
    return StudySetSchema.parse({
        id: 'default',
        title: `${notebook.title} study set`,
        description: 'Migrated from the original notebook study workspace.',
        sourcePaths: notebook.sources.map((source) => source.path),
        createdAt: now,
        updatedAt: notebook.updatedAt || now,
    });
}

async function loadRegistry(notebookPath: string): Promise<{ version: 1; sets: StudySet[] }> {
    const notebook = await getNotebook(notebookPath);
    if (!(await exists(registryPath(notebookPath))).exists) {
        const registry = { version: 1 as const, sets: [defaultStudySet(notebook)] };
        await writeFile(registryPath(notebookPath), `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', mkdirp: true, atomic: true });
        return registry;
    }
    return StudySetRegistrySchema.parse(JSON.parse((await readFile(registryPath(notebookPath))).data));
}

async function saveRegistry(notebookPath: string, sets: StudySet[]): Promise<void> {
    await writeFile(registryPath(notebookPath), `${JSON.stringify({ version: 1, sets }, null, 2)}\n`, { encoding: 'utf8', mkdirp: true, atomic: true });
}

export async function listStudySets(notebookPath: string): Promise<StudySet[]> {
    return (await loadRegistry(notebookPath)).sets;
}

type StudySetMutation = Partial<Pick<StudySet, 'title' | 'starred' | 'description' | 'sourcePaths'>> & { activityConfig?: Partial<StudySet['activityConfig']> };

export async function createStudySet(notebookPath: string, input: Pick<StudySet, 'title'> & StudySetMutation): Promise<StudySet> {
    return withStudyLock(notebookPath, async () => {
        const [registry, notebook] = await Promise.all([loadRegistry(notebookPath), getNotebook(notebookPath)]);
        const allowed = new Set(notebook.sources.map((source) => source.path));
        const now = new Date().toISOString();
        const studySet = StudySetSchema.parse({
            id: randomUUID(), title: input.title, description: input.description ?? '',
            starred: input.starred ?? false,
            sourcePaths: (input.sourcePaths ?? notebook.sources.map((source) => source.path)).filter((path) => allowed.has(path)),
            activityConfig: input.activityConfig, createdAt: now, updatedAt: now,
        });
        await saveRegistry(notebookPath, [...registry.sets, studySet]);
        return studySet;
    });
}

export async function updateStudySet(notebookPath: string, studySetId: string, input: StudySetMutation): Promise<StudySet> {
    return withStudyLock(notebookPath, async () => {
        const [registry, notebook] = await Promise.all([loadRegistry(notebookPath), getNotebook(notebookPath)]);
        const current = registry.sets.find((set) => set.id === studySetId);
        if (!current) throw new Error('Study set not found.');
        const allowed = new Set(notebook.sources.map((source) => source.path));
        const updated = StudySetSchema.parse({ ...current, ...input, activityConfig: { ...current.activityConfig, ...input.activityConfig }, sourcePaths: (input.sourcePaths ?? current.sourcePaths).filter((path) => allowed.has(path)), updatedAt: new Date().toISOString() });
        await saveRegistry(notebookPath, registry.sets.map((set) => set.id === studySetId ? updated : set));
        workspaceCache.delete(`${notebookPath}::${studySetId}`);
        return updated;
    });
}

export async function removeSourceFromStudySets(notebookPath: string, sourcePath: string): Promise<void> {
    await withStudyLock(notebookPath, async () => {
        const registry = await loadRegistry(notebookPath);
        const nextSets = registry.sets.map((studySet) => studySet.sourcePaths.includes(sourcePath)
            ? StudySetSchema.parse({
                ...studySet,
                sourcePaths: studySet.sourcePaths.filter((path) => path !== sourcePath),
                updatedAt: new Date().toISOString(),
            })
            : studySet);
        if (nextSets.some((studySet, index) => studySet !== registry.sets[index])) {
            await saveRegistry(notebookPath, nextSets);
            for (const studySet of nextSets) workspaceCache.delete(`${notebookPath}::${studySet.id}`);
        }
    });
}

export async function deleteStudySet(notebookPath: string, studySetId: string): Promise<{ ok: true; recoveryPath: string | null }> {
    return withStudyLock(notebookPath, async () => {
        const registry = await loadRegistry(notebookPath);
        const current = registry.sets.find((set) => set.id === studySetId);
        if (!current) throw new Error('Study set not found.');
        const recoveryPath = `${notebookPath}/.trash/study-set-${studySetId}-${timestampSlug()}.json`;
        let state: unknown = null;
        const currentStatePath = statePath(notebookPath, studySetId === 'default' ? undefined : studySetId);
        if ((await exists(currentStatePath)).exists) state = JSON.parse((await readFile(currentStatePath)).data);
        await writeFile(recoveryPath, `${JSON.stringify({ studySet: current, state }, null, 2)}\n`, { encoding: 'utf8', mkdirp: true, atomic: true });
        await saveRegistry(notebookPath, registry.sets.filter((set) => set.id !== studySetId));
        workspaceCache.delete(`${notebookPath}::${studySetId}`);
        return { ok: true, recoveryPath };
    });
}

function timestampSlug(now = new Date()): string {
    return now.toISOString().replace(/[:.]/g, '-');
}

function localDayKey(now = new Date()): string {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function dayNumberFromLocalKey(value: string): number {
    const [year, month, day] = value.split('-').map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

async function withStudyLock<T>(notebookPath: string, fn: () => Promise<T>): Promise<T> {
    // Use a dedicated in-memory lock key. The workspace writer applies its own
    // lock to the actual JSON file; reusing that key here would self-deadlock.
    return withFileLock(resolveWorkspacePath(`${notebookPath}/.rowboat-study.mutation-lock`), fn);
}

function cleanText(value: string, maxLength = 1_200): string {
    return value
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*_~`>#|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function stableId(...parts: string[]): string {
    return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 20);
}

function extractSections(markdown: string): StudySection[] {
    const withoutFrontmatter = markdown.replace(/^---\s*[\s\S]*?\s---\s*/u, '');
    const lines = withoutFrontmatter.split(/\r?\n/);
    const sections: StudySection[] = [];
    let title = '';
    let body: string[] = [];

    const flush = () => {
        const cleanedBody = cleanText(body.join('\n'));
        if (cleanedBody.length >= 24) {
            sections.push({ title: cleanText(title, 180), body: cleanedBody });
        }
        body = [];
    };

    for (const line of lines) {
        const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
        if (heading) {
            flush();
            title = heading[1];
            continue;
        }
        body.push(line);
    }
    flush();

    if (sections.length > 0) return sections;
    return withoutFrontmatter
        .split(/\n\s*\n/)
        .map((paragraph) => cleanText(paragraph))
        .filter((paragraph) => paragraph.length >= 24)
        .map((paragraph) => ({ title: '', body: paragraph }));
}

function definitionCards(
    content: string,
    source: NotebookContextSnapshot['sources'][number],
): StudyCard[] {
    const cards: StudyCard[] = [];
    const seen = new Set<string>();
    const definitionPattern = /(?:^|\n)\s*(?:[-*]\s+)?(?:\*\*)?([^\n:—–-]{2,80})(?:\*\*)?\s*(?::|\s[—–]\s)\s*([^\n]{12,700})/g;
    for (const match of content.matchAll(definitionPattern)) {
        const term = cleanText(match[1], 100);
        const definition = cleanText(match[2], 700);
        const normalized = term.toLowerCase();
        if (!term || !definition || seen.has(normalized)) continue;
        seen.add(normalized);
        cards.push({
            id: stableId(source.path, 'definition', normalized, definition),
            front: `What is ${term}?`,
            back: definition,
            sourceId: source.id,
            sourcePath: source.path,
            sourceTitle: source.title,
        });
    }
    return cards;
}

export function buildStudyCards(context: NotebookContextSnapshot): StudyCard[] {
    const cards: StudyCard[] = [];
    const seen = new Set<string>();

    for (const source of context.sources) {
        const candidates = [
            ...definitionCards(source.content, source),
            ...extractSections(source.content).map((section, sectionIndex): StudyCard => {
                const topic = section.title || cleanText(section.body.split(/[.!?]/)[0] ?? '', 90) || `section ${sectionIndex + 1}`;
                return {
                    id: stableId(source.path, 'section', topic, section.body),
                    front: section.title
                        ? `Explain ${section.title}.`
                        : `What should you remember about ${topic}?`,
                    back: section.body.slice(0, 900),
                    sourceId: source.id,
                    sourcePath: source.path,
                    sourceTitle: source.title,
                };
            }),
        ];

        for (const card of candidates) {
            const key = `${card.front.toLowerCase()}\0${card.back.toLowerCase()}`;
            if (seen.has(key) || card.back.length < 20) continue;
            seen.add(key);
            cards.push(card);
            if (cards.length >= MAX_STUDY_CARDS) return cards;
        }
    }
    return cards;
}

function optionText(value: string): string {
    const sentence = value.split(/(?<=[.!?])\s+/)[0] ?? value;
    return cleanText(sentence, 240);
}

export function buildStudyQuiz(cards: StudyCard[]): StudyQuizQuestion[] {
    if (cards.length < 2) return [];
    return cards.slice(0, 40).flatMap((card, index) => {
        const correct = optionText(card.back);
        const distractors: string[] = [];
        for (let offset = 1; offset < cards.length && distractors.length < 3; offset += 1) {
            const candidate = optionText(cards[(index + offset) % cards.length].back);
            if (candidate && candidate !== correct && !distractors.includes(candidate)) distractors.push(candidate);
        }
        if (distractors.length === 0) return [];
        const options = [correct, ...distractors];
        const rotation = Number.parseInt(stableId(card.id, 'quiz').slice(0, 4), 16) % options.length;
        const rotated = [...options.slice(rotation), ...options.slice(0, rotation)];
        return [{
            id: stableId(card.id, 'question'),
            prompt: card.front,
            options: rotated,
            correctIndex: rotated.indexOf(correct),
            explanation: card.back,
            sourceId: card.sourceId,
            sourcePath: card.sourcePath,
            sourceTitle: card.sourceTitle,
        }];
    });
}

export function applyStudyRating(
    previousInput: StudyCardProgress | undefined,
    rating: StudyRating,
    now = new Date(),
): StudyCardProgress {
    const previous = StudyCardProgressSchema.parse(previousInput ?? {});
    const reviewedAt = now.toISOString();
    let repetitions = previous.repetitions;
    let lapses = previous.lapses;
    let ease = previous.ease;
    let intervalDays = previous.intervalDays;

    if (rating === 'again') {
        repetitions = 0;
        lapses += 1;
        ease = Math.max(1.3, ease - 0.2);
        intervalDays = 0;
    } else {
        repetitions += 1;
        if (rating === 'hard') {
            ease = Math.max(1.3, ease - 0.15);
            intervalDays = Math.max(1, previous.intervalDays * 1.2 || 1);
        } else if (rating === 'good') {
            intervalDays = repetitions === 1 ? 1 : repetitions === 2 ? 3 : Math.max(3, previous.intervalDays * ease);
        } else {
            ease = Math.min(3, ease + 0.15);
            intervalDays = repetitions === 1 ? 3 : Math.max(5, previous.intervalDays * ease * 1.25);
        }
    }

    const dueAt = new Date(now.getTime() + intervalDays * 86_400_000).toISOString();
    return StudyCardProgressSchema.parse({
        repetitions,
        lapses,
        intervalDays: Math.round(intervalDays * 100) / 100,
        ease: Math.round(ease * 100) / 100,
        dueAt,
        lastReviewedAt: reviewedAt,
    });
}

function newStudyState(now = new Date()): StudyState {
    const timestamp = now.toISOString();
    return StudyStateSchema.parse({
        version: 1,
        settings: {},
        cards: {},
        reviewKeys: [],
        sessions: [],
        lastRecoveryPath: null,
        createdAt: timestamp,
        updatedAt: timestamp,
    });
}

async function loadStudyState(notebookPath: string, studySetId?: string): Promise<StudyState> {
    await getNotebook(notebookPath);
    const path = statePath(notebookPath, studySetId && studySetId !== 'default' ? studySetId : undefined);
    if (!(await exists(path)).exists) return newStudyState();
    try {
        return StudyStateSchema.parse(JSON.parse((await readFile(path)).data));
    } catch (error) {
        const recoveryPath = `${notebookPath}/.rowboat-study.corrupt.${timestampSlug()}.json`;
        await rename(path, recoveryPath);
        throw new Error(`Study progress could not be read and was preserved at ${recoveryPath}. No progress was overwritten. ${error instanceof Error ? error.message : ''}`.trim());
    }
}

async function persistStudyState(notebookPath: string, state: StudyState, studySetId?: string): Promise<StudyState> {
    await getNotebook(notebookPath);
    const parsed = StudyStateSchema.parse({ ...state, updatedAt: new Date().toISOString() });
    await writeFile(statePath(notebookPath, studySetId && studySetId !== 'default' ? studySetId : undefined), `${JSON.stringify(parsed, null, 2)}\n`, {
        encoding: 'utf8',
        mkdirp: true,
        atomic: true,
    });
    return parsed;
}

function currentStreak(sessions: StudyState['sessions'], now: Date): number {
    const studiedDays = [...new Set(sessions.map((session) => dayNumberFromLocalKey(session.localDay)))].sort((a, b) => b - a);
    if (studiedDays.length === 0) return 0;
    const today = dayNumberFromLocalKey(localDayKey(now));
    if (today - studiedDays[0] > 1) return 0;
    let streak = 1;
    for (let index = 1; index < studiedDays.length; index += 1) {
        if (studiedDays[index - 1] - studiedDays[index] !== 1) break;
        streak += 1;
    }
    return streak;
}

function buildStudyProgress(state: StudyState, cards: StudyCard[], now: Date): StudyWorkspace['progress'] {
    const nowMs = now.getTime();
    const today = localDayKey(now);
    const currentIds = new Set(cards.map((card) => card.id));
    const currentProgress = Object.fromEntries(
        Object.entries(state.cards).filter(([cardId]) => currentIds.has(cardId)),
    );
    const reviewed = Object.values(currentProgress).filter((entry) => entry.lastReviewedAt);
    const reviewProgressTotal = cards.reduce((total, card) => {
        const item = currentProgress[card.id];
        if (!item) return total;
        return total + Math.max(0, Math.min(100, item.repetitions * 25));
    }, 0);
    const dueDates = cards.map((card) => currentProgress[card.id]?.dueAt).filter((value): value is string => Boolean(value));
    const dueCount = cards.filter((card) => {
        const dueAt = currentProgress[card.id]?.dueAt;
        return !dueAt || new Date(dueAt).getTime() <= nowMs;
    }).length;
    const sessions = state.sessions;
    return {
        totalMinutes: sessions.reduce((total, session) => total + session.minutes, 0),
        todayMinutes: sessions
            .filter((session) => session.localDay === today)
            .reduce((total, session) => total + session.minutes, 0),
        sessionsCompleted: sessions.length,
        currentStreak: currentStreak(sessions, now),
        reviewProgressPercent: cards.length === 0 ? 0 : Math.round(reviewProgressTotal / cards.length),
        dueCount,
        reviewedCount: reviewed.length,
        lastStudiedAt: sessions.at(-1)?.completedAt ?? null,
        nextDueAt: dueDates.sort()[0] ?? null,
        cardProgress: currentProgress,
    };
}

async function composeStudyWorkspace(notebookPath: string, studySet: StudySet, state: StudyState, now = new Date()): Promise<StudyWorkspace> {
    const notebook = await getNotebook(notebookPath);
    const selected = new Set(studySet.sourcePaths);
    const scopedNotebook = { ...notebook, sources: notebook.sources.map((source) => ({ ...source, enabled: source.enabled && selected.has(source.path) })) };
    const context = await buildNotebookContextFromManifest(scopedNotebook, studySet.activityConfig.topics.join(' '), async (sourcePath) => (await readFile(sourcePath)).data);
    const cards = buildStudyCards(context).slice(0, studySet.activityConfig.flashcardCount);
    const workspace = {
        notebook,
        studySet,
        settings: state.settings,
        cards,
        quiz: buildStudyQuiz(cards).slice(0, studySet.activityConfig.quizQuestionCount),
        progress: buildStudyProgress(state, cards, now),
        retrievalEvidence: context.retrievalEvidence,
        unavailableSources: context.unavailableSources,
        coverageNotice: 'Cards and checks cover the source passages selected by this notebook retrieval profile. Open Notebook Studio to adjust source scope.',
        lastRecoveryPath: state.lastRecoveryPath,
        generatedAt: now.toISOString(),
    };
    const cacheKey = `${notebookPath}::${studySet.id}`;
    workspaceCache.delete(cacheKey);
    workspaceCache.set(cacheKey, workspace);
    if (workspaceCache.size > MAX_WORKSPACE_CACHE) {
        const oldest = workspaceCache.keys().next().value;
        if (oldest) workspaceCache.delete(oldest);
    }
    return workspace;
}

function sourceRevision(notebook: NotebookDescriptor): string {
    return notebook.sources
        .map((source) => [source.path, source.enabled, source.contextMode, source.available, source.modifiedAt ?? 'missing'].join(':'))
        .join('|');
}

async function composeOrReuseStudyWorkspace(notebookPath: string, studySet: StudySet, state: StudyState, now = new Date()): Promise<StudyWorkspace> {
    const cacheKey = `${notebookPath}::${studySet.id}`;
    const cached = workspaceCache.get(cacheKey);
    if (!cached) return composeStudyWorkspace(notebookPath, studySet, state, now);
    const notebook = await getNotebook(notebookPath);
    if (sourceRevision(cached.notebook) !== sourceRevision(notebook)) {
        return composeStudyWorkspace(notebookPath, studySet, state, now);
    }
    workspaceCache.delete(cacheKey);
    const workspace: StudyWorkspace = {
        ...cached,
        notebook,
        studySet,
        settings: state.settings,
        progress: buildStudyProgress(state, cached.cards, now),
        lastRecoveryPath: state.lastRecoveryPath,
        generatedAt: now.toISOString(),
    };
    workspaceCache.set(cacheKey, workspace);
    return workspace;
}

async function resolveStudySet(notebookPath: string, studySetId?: string): Promise<StudySet> {
    const sets = await listStudySets(notebookPath);
    const studySet = studySetId ? sets.find((set) => set.id === studySetId) : sets[0];
    if (!studySet) throw new Error('Create a study set in this notebook to begin.');
    return studySet;
}

export async function getStudyWorkspace(notebookPath: string, studySetId?: string): Promise<StudyWorkspace> {
    const studySet = await resolveStudySet(notebookPath, studySetId);
    const state = await loadStudyState(notebookPath, studySet.id);
    return composeOrReuseStudyWorkspace(notebookPath, studySet, state);
}

export async function updateStudySettings(
    notebookPath: string,
    input: Partial<StudySettings>,
    studySetId?: string,
): Promise<StudyWorkspace> {
    return withStudyLock(notebookPath, async () => {
        const studySet = await resolveStudySet(notebookPath, studySetId);
        const state = await loadStudyState(notebookPath, studySet.id);
        const settings = StudySettingsSchema.parse({ ...state.settings, ...input });
        const saved = await persistStudyState(notebookPath, { ...state, settings }, studySet.id);
        return composeOrReuseStudyWorkspace(notebookPath, studySet, saved);
    });
}

export async function reviewStudyCard(
    notebookPath: string,
    cardId: string,
    ratingInput: StudyRating,
    idempotencyKeyInput?: string,
    studySetId?: string,
): Promise<StudyWorkspace> {
    return withStudyLock(notebookPath, async () => {
        const rating = StudyRatingSchema.parse(ratingInput);
        const idempotencyKey = idempotencyKeyInput?.trim() || randomUUID();
        const studySet = await resolveStudySet(notebookPath, studySetId);
        const state = await loadStudyState(notebookPath, studySet.id);
        const workspace = await composeOrReuseStudyWorkspace(notebookPath, studySet, state);
        if (!workspace.cards.some((card) => card.id === cardId)) {
            throw new Error('That study card is no longer available from the selected sources.');
        }
        const reviewKey = stableId(cardId, idempotencyKey);
        if (state.reviewKeys.includes(reviewKey)) return workspace;
        const cards = {
            ...state.cards,
            [cardId]: applyStudyRating(state.cards[cardId], rating),
        };
        const reviewKeys = [...state.reviewKeys, reviewKey].slice(-5_000);
        const saved = await persistStudyState(notebookPath, { ...state, cards, reviewKeys }, studySet.id);
        return {
            ...workspace,
            progress: buildStudyProgress(saved, workspace.cards, new Date()),
            generatedAt: new Date().toISOString(),
        };
    });
}

export async function recordStudySession(
    notebookPath: string,
    minutesInput: number,
    modeInput: z.infer<typeof StudySessionSchema>['mode'],
    idempotencyKeyInput?: string,
    studySetId?: string,
): Promise<StudyWorkspace> {
    return withStudyLock(notebookPath, async () => {
        const studySet = await resolveStudySet(notebookPath, studySetId);
        const state = await loadStudyState(notebookPath, studySet.id);
        const idempotencyKey = idempotencyKeyInput?.trim() || randomUUID();
        if (state.sessions.some((session) => session.idempotencyKey === idempotencyKey)) {
            return composeOrReuseStudyWorkspace(notebookPath, studySet, state);
        }
        const now = new Date();
        const session = StudySessionSchema.parse({
            id: randomUUID(),
            idempotencyKey,
            completedAt: now.toISOString(),
            localDay: localDayKey(now),
            minutes: minutesInput,
            mode: modeInput,
        });
        const sessions = [...state.sessions, session].slice(-MAX_STUDY_SESSIONS);
        const saved = await persistStudyState(notebookPath, { ...state, sessions }, studySet.id);
        return composeOrReuseStudyWorkspace(notebookPath, studySet, saved, now);
    });
}

export async function resetStudyProgress(notebookPath: string, studySetId?: string): Promise<StudyWorkspace> {
    return withStudyLock(notebookPath, async () => {
        const studySet = await resolveStudySet(notebookPath, studySetId);
        const state = await loadStudyState(notebookPath, studySet.id);
        const recoveryPath = `${notebookPath}/.rowboat-study.${studySet.id}.reset.${timestampSlug()}.json`;
        await writeFile(recoveryPath, `${JSON.stringify(state, null, 2)}\n`, {
            encoding: 'utf8',
            mkdirp: true,
            atomic: true,
        });
        const saved = await persistStudyState(notebookPath, {
            ...state,
            cards: {},
            reviewKeys: [],
            sessions: [],
            lastRecoveryPath: recoveryPath,
        }, studySet.id);
        return composeOrReuseStudyWorkspace(notebookPath, studySet, saved);
    });
}
