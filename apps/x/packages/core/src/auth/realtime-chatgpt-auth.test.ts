import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-realtime-chatgpt-auth-test-'));
const tmpCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'x-realtime-chatgpt-codex-test-'));
process.env.ROWBOAT_WORKDIR = tmpWorkDir;
process.env.CODEX_HOME = tmpCodexHome;

const auth = await import('./realtime-chatgpt-auth.js');
const constants = await import('./chatgpt-constants.js');
const AUTH_FILE = path.join(tmpWorkDir, 'config', 'realtime-chatgpt-auth.json');

const NOW_MS = new Date('2026-07-30T12:00:00Z').getTime();
const NOW = Math.floor(NOW_MS / 1000);

function jwt(claims: Record<string, unknown>): string {
    const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `header.${encoded}.signature`;
}

const cipher = {
    available: true,
    isAvailable() { return this.available; },
    encrypt(plain: string) { return `enc:${Buffer.from(plain).toString('base64')}`; },
    decrypt(value: string) {
        if (!value.startsWith('enc:')) throw new Error('bad ciphertext');
        return Buffer.from(value.slice(4), 'base64').toString('utf8');
    },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    cipher.available = true;
    auth.setRealtimeTokenCipher(cipher);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fs.rmSync(AUTH_FILE, { force: true });
    fs.rmSync(path.join(tmpCodexHome, 'auth.json'), { force: true });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

afterAll(() => {
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
    fs.rmSync(tmpCodexHome, { recursive: true, force: true });
});

describe('Realtime ChatGPT OAuth isolation', () => {
    it('does not treat the shared Codex text credential as voice authorization', async () => {
        fs.writeFileSync(path.join(tmpCodexHome, 'auth.json'), JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: {
                access_token: jwt({ exp: NOW + 3600 }),
                refresh_token: 'shared-codex-refresh',
            },
        }));

        await expect(auth.getRealtimeChatGPTStatus()).resolves.toEqual({
            signedIn: false,
            storageReady: true,
        });
        await expect(auth.getRealtimeChatGPTAccessToken()).rejects.toBeInstanceOf(
            auth.RealtimeChatGPTAuthRequiredError,
        );
    });

    it('stores the separate voice grant encrypted and never writes token material in clear text', async () => {
        const accessToken = jwt({
            exp: NOW + 3600,
            email: 'voice@example.com',
            [constants.CHATGPT_AUTH_CLAIM_NAMESPACE]: { chatgpt_account_id: 'voice-account' },
        });
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            access_token: accessToken,
            refresh_token: 'voice-refresh-secret',
        }), { status: 200 }));

        await auth.exchangeRealtimeChatGPTCode('voice-code', 'voice-verifier');

        const raw = fs.readFileSync(AUTH_FILE, 'utf8');
        expect(raw).toContain('tokensEncrypted');
        expect(raw).not.toContain(accessToken);
        expect(raw).not.toContain('voice-refresh-secret');
        await expect(auth.getRealtimeChatGPTAccessToken()).resolves.toBe(accessToken);
        await expect(auth.getRealtimeChatGPTStatus()).resolves.toMatchObject({
            signedIn: true,
            storageReady: true,
            email: 'voice@example.com',
            accountId: 'voice-account',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0]?.[0]).toBe(constants.CHATGPT_TOKEN_URL);
    });

    it('fails closed when secure storage is unavailable', async () => {
        cipher.available = false;
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            access_token: jwt({ exp: NOW + 3600 }),
            refresh_token: 'must-not-persist',
        }), { status: 200 }));

        await expect(auth.exchangeRealtimeChatGPTCode('voice-code', 'voice-verifier'))
            .rejects.toThrow(/secure windows credential storage/i);
        expect(fs.existsSync(AUTH_FILE)).toBe(false);
        await expect(auth.getRealtimeChatGPTStatus()).resolves.toEqual({
            signedIn: false,
            storageReady: false,
        });
    });

    it('does not persist a token exchange after that authorization attempt is superseded', async () => {
        let releaseExchange!: (response: Response) => void;
        const exchangeResponse = new Promise<Response>((resolve) => {
            releaseExchange = resolve;
        });
        fetchMock.mockReturnValueOnce(exchangeResponse);
        const attemptEpoch = auth.beginRealtimeChatGPTAuthorization();
        const exchange = auth.exchangeRealtimeChatGPTCode(
            'old-code',
            'old-verifier',
            attemptEpoch,
        );

        auth.beginRealtimeChatGPTAuthorization();
        releaseExchange(new Response(JSON.stringify({
            access_token: jwt({ exp: NOW + 3600 }),
            refresh_token: 'superseded-refresh',
        }), { status: 200 }));

        await expect(exchange).rejects.toBeInstanceOf(auth.RealtimeChatGPTAuthRequiredError);
        expect(fs.existsSync(AUTH_FILE)).toBe(false);
    });

    it('prevents a late refresh from restoring credentials after sign-out', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            access_token: jwt({ exp: NOW + 1 }),
            refresh_token: 'refresh-before-signout',
        }), { status: 200 }));
        await auth.exchangeRealtimeChatGPTCode('voice-code', 'voice-verifier');

        let releaseRefresh!: (response: Response) => void;
        const refreshResponse = new Promise<Response>((resolve) => {
            releaseRefresh = resolve;
        });
        fetchMock.mockImplementation((url: string) => {
            if (url === constants.CHATGPT_REVOKE_URL) return Promise.resolve(new Response('', { status: 200 }));
            return refreshResponse;
        });
        const refreshing = auth.getRealtimeChatGPTAccessToken();
        await Promise.resolve();
        await auth.signOutRealtimeChatGPT();
        releaseRefresh(new Response(JSON.stringify({
            access_token: jwt({ exp: NOW + 3600 }),
            refresh_token: 'late-refresh-must-not-return',
        }), { status: 200 }));

        await expect(refreshing).rejects.toBeInstanceOf(auth.RealtimeChatGPTAuthRequiredError);
        expect(fs.existsSync(AUTH_FILE)).toBe(false);
        await expect(auth.getRealtimeChatGPTStatus()).resolves.toMatchObject({ signedIn: false });
    });
});
