import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkDir } from '../config/config.js';
import {
    CHATGPT_AUTH_CLAIM_NAMESPACE,
    CHATGPT_CLIENT_ID,
    CHATGPT_PROFILE_CLAIM_NAMESPACE,
    CHATGPT_REDIRECT_URI,
    CHATGPT_REFRESH_MARGIN_SECONDS,
    CHATGPT_REVOKE_URL,
    CHATGPT_TOKEN_URL,
} from './chatgpt-constants.js';

/**
 * Rowboat-owned GPT Realtime OAuth storage.
 *
 * This is intentionally separate from chatgpt-auth.ts. The latter is the
 * Codex text-model lane and may use the shared Codex CLI credential. Voice
 * must never inherit that credential implicitly, so this module reads only
 * its own encrypted Rowboat file.
 */
const AUTH_FILE = path.join(WorkDir, 'config', 'realtime-chatgpt-auth.json');

export interface RealtimeTokenCipher {
    isAvailable(): boolean;
    encrypt(plain: string): string;
    decrypt(encrypted: string): string;
}

type TokenMaterial = {
    accessToken: string;
    refreshToken: string;
};

type StoredRealtimeAuth = {
    accountId?: string;
    email?: string;
    expiresAt: number;
    createdAt: string;
    tokensEncrypted: string;
};

export type RealtimeChatGPTStatus = {
    signedIn: boolean;
    storageReady: boolean;
    email?: string;
    accountId?: string;
};

export class RealtimeChatGPTAuthRequiredError extends Error {
    constructor(message = 'Sign in with ChatGPT for GPT Realtime voice.') {
        super(message);
        this.name = 'RealtimeChatGPTAuthRequiredError';
    }
}

let cipher: RealtimeTokenCipher | null = null;
let authEpoch = 0;
let mutationTail: Promise<void> = Promise.resolve();
let refreshInFlight: { epoch: number; promise: Promise<string> } | null = null;

export function setRealtimeTokenCipher(value: RealtimeTokenCipher): void {
    cipher = value;
}

export function beginRealtimeChatGPTAuthorization(): number {
    authEpoch += 1;
    refreshInFlight = null;
    return authEpoch;
}

function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
    try {
        const payload = token.split('.')[1];
        if (!payload) return null;
        const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
        return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function claimString(source: unknown, key: string): string | undefined {
    if (!source || typeof source !== 'object') return undefined;
    const value = (source as Record<string, unknown>)[key];
    return typeof value === 'string' && value ? value : undefined;
}

function extractIdentity(tokens: Array<string | undefined>): { accountId?: string; email?: string } {
    let accountId: string | undefined;
    let email: string | undefined;
    for (const token of tokens) {
        if (!token) continue;
        const claims = decodeJwtClaims(token);
        if (!claims) continue;
        accountId ??= claimString(claims[CHATGPT_AUTH_CLAIM_NAMESPACE], 'chatgpt_account_id');
        email ??= claimString(claims, 'email')
            ?? claimString(claims[CHATGPT_PROFILE_CLAIM_NAMESPACE], 'email');
    }
    return { accountId, email };
}

async function readAuth(): Promise<StoredRealtimeAuth | null> {
    try {
        const metadata = await fs.lstat(AUTH_FILE);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 128 * 1024) {
            return null;
        }
        const parsed = JSON.parse(await fs.readFile(AUTH_FILE, 'utf8')) as Partial<StoredRealtimeAuth>;
        return typeof parsed.tokensEncrypted === 'string'
            && parsed.tokensEncrypted.length > 0
            && typeof parsed.expiresAt === 'number'
            && typeof parsed.createdAt === 'string'
            ? parsed as StoredRealtimeAuth
            : null;
    } catch {
        return null;
    }
}

async function writeAuth(auth: StoredRealtimeAuth): Promise<void> {
    if (!cipher?.isAvailable()) {
        throw new Error('Secure Windows credential storage is unavailable; GPT Realtime OAuth was not saved.');
    }
    await fs.mkdir(path.dirname(AUTH_FILE), { recursive: true });
    const temporary = `${AUTH_FILE}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
    try {
        await fs.rename(temporary, AUTH_FILE);
    } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
}

async function clearStore(expectedEpoch = authEpoch): Promise<void> {
    await serializeMutation(async () => {
        if (expectedEpoch !== authEpoch) return;
        await fs.rm(AUTH_FILE, { force: true });
    });
}

async function readMaterial(auth: StoredRealtimeAuth): Promise<TokenMaterial | null> {
    if (!cipher?.isAvailable()) return null;
    try {
        const parsed = JSON.parse(cipher.decrypt(auth.tokensEncrypted)) as Partial<TokenMaterial>;
        return typeof parsed.accessToken === 'string'
            && parsed.accessToken.length > 0
            && typeof parsed.refreshToken === 'string'
            && parsed.refreshToken.length > 0
            ? parsed as TokenMaterial
            : null;
    } catch {
        return null;
    }
}

async function saveTokens(input: {
    accessToken: string;
    refreshToken: string;
    idToken?: string;
}, expectedEpoch: number): Promise<{ accountId?: string; email?: string }> {
    if (!cipher?.isAvailable()) {
        throw new Error('Secure Windows credential storage is unavailable; GPT Realtime OAuth was not saved.');
    }
    const identity = extractIdentity([input.idToken, input.accessToken]);
    const tokenExpiry = decodeJwtClaims(input.accessToken)?.exp;
    const expiresAt = typeof tokenExpiry === 'number'
        ? tokenExpiry
        : Math.floor(Date.now() / 1000) + 3600;
    const material: TokenMaterial = {
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
    };
    const encrypted = cipher.encrypt(JSON.stringify(material));
    return serializeMutation(async () => {
        if (expectedEpoch !== authEpoch) {
            throw new RealtimeChatGPTAuthRequiredError('This ChatGPT voice authorization attempt is no longer current.');
        }
        const existing = await readAuth();
        const accountId = identity.accountId ?? existing?.accountId;
        const email = identity.email ?? existing?.email;
        await writeAuth({
            ...(accountId ? { accountId } : {}),
            ...(email ? { email } : {}),
            expiresAt,
            createdAt: existing?.createdAt ?? new Date().toISOString(),
            tokensEncrypted: encrypted,
        });
        return { accountId, email };
    });
}

export async function exchangeRealtimeChatGPTCode(
    code: string,
    codeVerifier: string,
    expectedEpoch = authEpoch,
    signal?: AbortSignal,
): Promise<{ accountId?: string; email?: string }> {
    const response = await fetch(CHATGPT_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: CHATGPT_REDIRECT_URI,
            client_id: CHATGPT_CLIENT_ID,
            code_verifier: codeVerifier,
        }).toString(),
        signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        throw new Error(`ChatGPT voice token exchange failed: HTTP ${response.status}`);
    }
    const body = await response.json() as {
        id_token?: string;
        access_token?: string;
        refresh_token?: string;
    };
    if (!body.access_token || !body.refresh_token) {
        throw new Error('ChatGPT voice token exchange response is missing tokens.');
    }
    return saveTokens({
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        ...(body.id_token ? { idToken: body.id_token } : {}),
    }, expectedEpoch);
}

async function refreshAccessToken(refreshToken: string, expectedEpoch: number): Promise<string> {
    let response: Response;
    try {
        response = await fetch(CHATGPT_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: CHATGPT_CLIENT_ID,
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
            }),
            signal: AbortSignal.timeout(30_000),
        });
    } catch (error) {
        throw new Error(`ChatGPT voice token refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 400 || response.status === 401) {
        await clearStore(expectedEpoch);
        throw new RealtimeChatGPTAuthRequiredError('ChatGPT voice authorization expired. Sign in again.');
    }
    if (!response.ok) {
        throw new Error(`ChatGPT voice token refresh failed: HTTP ${response.status}`);
    }
    const body = await response.json() as {
        id_token?: string;
        access_token?: string;
        refresh_token?: string;
    };
    if (!body.access_token) throw new Error('ChatGPT voice token refresh returned no access token.');
    await saveTokens({
        accessToken: body.access_token,
        refreshToken: body.refresh_token || refreshToken,
        ...(body.id_token ? { idToken: body.id_token } : {}),
    }, expectedEpoch);
    return body.access_token;
}

/** Main-process-only. Never returns the Codex text credential. */
export async function getRealtimeChatGPTAccessToken(): Promise<string> {
    const expectedEpoch = authEpoch;
    const auth = await readAuth();
    const material = auth ? await readMaterial(auth) : null;
    if (!auth || !material) throw new RealtimeChatGPTAuthRequiredError();
    const now = Math.floor(Date.now() / 1000);
    if (auth.expiresAt - now > CHATGPT_REFRESH_MARGIN_SECONDS) {
        return material.accessToken;
    }
    if (!refreshInFlight || refreshInFlight.epoch !== expectedEpoch) {
        const promise = refreshAccessToken(material.refreshToken, expectedEpoch).finally(() => {
            if (refreshInFlight?.promise === promise) refreshInFlight = null;
        });
        refreshInFlight = { epoch: expectedEpoch, promise };
    }
    return refreshInFlight.promise;
}

export async function getRealtimeChatGPTStatus(): Promise<RealtimeChatGPTStatus> {
    const storageReady = cipher?.isAvailable() === true;
    const auth = await readAuth();
    if (!storageReady || !auth || !(await readMaterial(auth))) {
        return { signedIn: false, storageReady };
    }
    return {
        signedIn: true,
        storageReady,
        ...(auth.email ? { email: auth.email } : {}),
        ...(auth.accountId ? { accountId: auth.accountId } : {}),
    };
}

export async function signOutRealtimeChatGPT(): Promise<void> {
    const auth = await readAuth();
    const material = auth ? await readMaterial(auth) : null;
    const signOutEpoch = ++authEpoch;
    refreshInFlight = null;
    await clearStore(signOutEpoch);
    if (material) {
        const body = material.refreshToken
            ? { token: material.refreshToken, token_type_hint: 'refresh_token', client_id: CHATGPT_CLIENT_ID }
            : { token: material.accessToken, token_type_hint: 'access_token' };
        try {
            await fetch(CHATGPT_REVOKE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(10_000),
            });
        } catch {
            // Revocation is best-effort; local removal is authoritative.
        }
    }
}
