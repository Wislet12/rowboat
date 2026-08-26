import { BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import {
  getRealtimeChatGPTAccessToken,
  getRealtimeChatGPTStatus,
  RealtimeChatGPTAuthRequiredError,
} from '@x/core/dist/auth/realtime-chatgpt-auth.js';
import { ROWBOAT_REALTIME_BASE_INSTRUCTIONS } from '@x/shared/dist/realtime-voice-context.js';
import { getJarvisExecutionAuthority } from './jarvis-execution-authority.js';

const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const MODEL = 'gpt-realtime-2.1' as const;
const OUTPUT_VOICE = 'cedar' as const;
const TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
const MAX_SDP_BYTES = 256 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_ERROR_BYTES = 4 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export type RowboatRealtimeVoiceFailure =
  | 'needs_sign_in'
  | 'secure_storage_unavailable'
  | 'oauth_realtime_not_authorized'
  | 'network_unavailable'
  | 'invalid_request'
  | 'stale_session'
  | 'mode_inactive'
  | 'forbidden_sender'
  | 'provider_unavailable'
  | 'cancelled';

type SessionRecord = {
  id: string;
  generation: number;
  senderId: number;
  abort: AbortController;
  negotiating: boolean;
};

type BrokerDependencies = {
  fetchImpl?: typeof fetch;
  getAccessToken?: typeof getRealtimeChatGPTAccessToken;
  getAuthStatus?: typeof getRealtimeChatGPTStatus;
  isMyOauthActive?: () => boolean;
  authorizeSender?: (event: IpcMainInvokeEvent) => number;
};

class RowboatRealtimeVoiceError extends Error {
  reason: RowboatRealtimeVoiceFailure;
  status?: number;

  constructor(message: string, reason: RowboatRealtimeVoiceFailure, status?: number) {
    super(message);
    this.name = 'RowboatRealtimeVoiceError';
    this.reason = reason;
    this.status = status;
  }
}

function authorizePrimarySender(event: IpcMainInvokeEvent, primarySenderId: number): number {
  const window = BrowserWindow.fromWebContents(event.sender);
  const isPrimaryWorkspace =
    primarySenderId > 0
    && event.sender.id === primarySenderId
    && !!window
    && !window.isDestroyed()
    && !event.sender.isDestroyed()
    && event.senderFrame === event.sender.mainFrame
    && window.webContents.id === primarySenderId;
  if (!isPrimaryWorkspace) {
    throw new RowboatRealtimeVoiceError(
      'GPT Realtime voice is available only from Rowboat’s primary workspace window.',
      'forbidden_sender',
    );
  }
  return event.sender.id;
}

function validateSdp(value: unknown): string {
  const sdp = typeof value === 'string' ? value : '';
  if (!sdp.startsWith('v=0')) {
    throw new RowboatRealtimeVoiceError('The Rowboat WebRTC offer is invalid.', 'invalid_request');
  }
  if (Buffer.byteLength(sdp, 'utf8') > MAX_SDP_BYTES) {
    throw new RowboatRealtimeVoiceError('The Rowboat WebRTC offer is too large.', 'invalid_request');
  }
  return sdp;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new RowboatRealtimeVoiceError('The Realtime service returned an oversized response.', 'provider_unavailable');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let result = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RowboatRealtimeVoiceError('The Realtime service returned an oversized response.', 'provider_unavailable');
    }
    result += decoder.decode(chunk.value, { stream: true });
  }
  return result + decoder.decode();
}

function failureReason(status: number): RowboatRealtimeVoiceFailure {
  if (status === 401 || status === 403) return 'oauth_realtime_not_authorized';
  if (status === 400 || status === 404 || status === 422) return 'invalid_request';
  return 'provider_unavailable';
}

function publicFailure(error: unknown) {
  if (error instanceof RowboatRealtimeVoiceError) {
    return { reason: error.reason, error: error.message.slice(0, 700) };
  }
  if (error instanceof RealtimeChatGPTAuthRequiredError) {
    return { reason: 'needs_sign_in' as const, error: error.message.slice(0, 700) };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/abort/i.test(message)) {
    return { reason: 'cancelled' as const, error: 'The GPT Realtime voice request was cancelled.' };
  }
  if (/fetch|network|socket|connect|dns|timeout/i.test(message)) {
    return { reason: 'network_unavailable' as const, error: 'GPT Realtime voice could not reach OpenAI.' };
  }
  return { reason: 'provider_unavailable' as const, error: 'GPT Realtime voice is currently unavailable.' };
}

function sessionConfig() {
  return {
    type: 'realtime',
    model: MODEL,
    output_modalities: ['audio'],
    instructions: ROWBOAT_REALTIME_BASE_INSTRUCTIONS,
    audio: {
      input: {
        noise_reduction: { type: 'near_field' },
        transcription: { model: TRANSCRIPTION_MODEL },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.45,
          prefix_padding_ms: 300,
          silence_duration_ms: 450,
          // The renderer creates each response only after refreshing the
          // permission-checked current note/browser replacement snapshot.
          create_response: false,
          interrupt_response: true,
        },
      },
      output: {
        voice: OUTPUT_VOICE,
      },
    },
    tools: [
      {
        type: 'function',
        name: 'rowboat_delegate',
        description:
          'Delegate work to Rowboat’s existing Codex-authorized agent and tool runtime. '
          + 'Use this to search or open meeting/Brain notes, for connected apps, files, code execution, '
          + 'web research beyond the supplied current page, skills, MCP servers, sub-agents, or any request that '
          + 'requires tools or a durable action. The delegated agent can inspect Rowboat’s live skill catalog and '
          + 'load its full builtin toolset, so current note context never narrows available capabilities. '
          + 'Do not use it for ordinary conversation grounded in the supplied current snapshot.',
        parameters: {
          type: 'object',
          properties: {
            request: {
              type: 'string',
              description: 'The complete, self-contained task for Rowboat to perform.',
            },
          },
          required: ['request'],
          additionalProperties: false,
        },
      },
    ],
    tool_choice: 'auto',
  };
}

export class RowboatRealtimeVoiceBroker {
  private fetchImpl: typeof fetch;
  private getAccessToken: typeof getRealtimeChatGPTAccessToken;
  private getAuthStatus: typeof getRealtimeChatGPTStatus;
  private isMyOauthActive: () => boolean;
  private customAuthorizeSender: ((event: IpcMainInvokeEvent) => number) | null;
  private primarySenderId = 0;
  private sessions = new Map<number, SessionRecord>();
  private generation = 0;

  constructor(dependencies: BrokerDependencies = {}) {
    this.fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
    this.getAccessToken = dependencies.getAccessToken ?? getRealtimeChatGPTAccessToken;
    this.getAuthStatus = dependencies.getAuthStatus ?? getRealtimeChatGPTStatus;
    this.isMyOauthActive = dependencies.isMyOauthActive
      ?? (() => getJarvisExecutionAuthority().managed);
    this.customAuthorizeSender = dependencies.authorizeSender ?? null;
  }

  setPrimarySender(senderId: number): void {
    const normalized = Number.isSafeInteger(senderId) && senderId > 0 ? senderId : 0;
    if (this.primarySenderId && this.primarySenderId !== normalized) {
      this.stopForSender(this.primarySenderId);
    }
    this.primarySenderId = normalized;
  }

  stopForWebContents(senderId: number): void {
    this.stopForSender(senderId);
    if (this.primarySenderId === senderId) this.primarySenderId = 0;
  }

  authorize(event: IpcMainInvokeEvent): number {
    return this.customAuthorizeSender
      ? this.customAuthorizeSender(event)
      : authorizePrimarySender(event, this.primarySenderId);
  }

  async status() {
    const auth = await this.getAuthStatus();
    return {
      signedIn: auth.signedIn,
      storageReady: auth.storageReady,
      provider: MODEL,
      authMode: 'chatgpt_oauth' as const,
      owner: 'rowboat' as const,
      transport: 'webrtc' as const,
      output: 'gpt_realtime_audio' as const,
      voice: OUTPUT_VOICE,
    };
  }

  async prepare(event: IpcMainInvokeEvent) {
    const senderId = this.authorize(event);
    if (!this.isMyOauthActive()) {
      return {
        ok: false as const,
        reason: 'mode_inactive' as const,
        error: 'Switch on My OAuth before starting GPT Realtime voice.',
      };
    }
    const auth = await this.getAuthStatus();
    if (!auth.storageReady) {
      return {
        ok: false as const,
        reason: 'secure_storage_unavailable' as const,
        error: 'Secure Windows credential storage is unavailable for GPT Realtime OAuth.',
      };
    }
    if (!auth.signedIn) {
      return {
        ok: false as const,
        reason: 'needs_sign_in' as const,
        error: 'Sign in with ChatGPT for GPT Realtime 2.1 voice.',
      };
    }
    this.stopForSender(senderId);
    const record: SessionRecord = {
      id: randomUUID(),
      generation: ++this.generation,
      senderId,
      abort: new AbortController(),
      negotiating: false,
    };
    this.sessions.set(senderId, record);
    return {
      ok: true as const,
      sessionId: record.id,
      generation: record.generation,
      provider: MODEL,
      authMode: 'chatgpt_oauth' as const,
      owner: 'rowboat' as const,
      transport: 'webrtc' as const,
      output: 'gpt_realtime_audio' as const,
      voice: OUTPUT_VOICE,
    };
  }

  async negotiate(
    event: IpcMainInvokeEvent,
    input: { sessionId: string; generation: number; sdp: string },
  ) {
    const senderId = this.authorize(event);
    if (!this.isMyOauthActive()) {
      this.stopForSender(senderId);
      return {
        ok: false as const,
        reason: 'mode_inactive' as const,
        error: 'My OAuth voice was stopped because Rowboat Hosted is active.',
      };
    }
    const record = this.sessions.get(senderId);
    if (
      !record
      || record.id !== input.sessionId
      || record.generation !== input.generation
      || record.abort.signal.aborted
    ) {
      return {
        ok: false as const,
        reason: 'stale_session' as const,
        error: 'The Rowboat GPT Realtime voice session is no longer current.',
      };
    }
    if (record.negotiating) {
      return {
        ok: false as const,
        reason: 'invalid_request' as const,
        error: 'A WebRTC negotiation is already in progress for this Rowboat voice session.',
      };
    }
    const offer = validateSdp(input.sdp);
    record.negotiating = true;
    const timeout = setTimeout(() => record.abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      const bearer = await this.getAccessToken();
      this.assertCurrent(senderId, record);
      this.assertMyOauthActive();
      const authStatus = await this.getAuthStatus();
      const safetyIdentifier = authStatus.accountId
        ? createHash('sha256').update(`rowboat-realtime:${authStatus.accountId}`).digest('hex')
        : undefined;
      const admitted = await this.fetchWithTimeout(record, CLIENT_SECRETS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
          ...(safetyIdentifier ? { 'OpenAI-Safety-Identifier': safetyIdentifier } : {}),
        },
        body: JSON.stringify({
          expires_after: { anchor: 'created_at', seconds: 60 },
          session: sessionConfig(),
        }),
      });
      this.assertCurrent(senderId, record);
      this.assertMyOauthActive();
      if (!admitted.ok) {
        await readBoundedText(admitted, MAX_ERROR_BYTES).catch(() => '');
        throw new RowboatRealtimeVoiceError(
          admitted.status === 401 || admitted.status === 403
            ? 'This ChatGPT OAuth account is not currently authorized for GPT Realtime 2.1 voice.'
            : `GPT Realtime OAuth admission failed (HTTP ${admitted.status}).`,
          failureReason(admitted.status),
          admitted.status,
        );
      }
      const admittedText = await readBoundedText(admitted, MAX_JSON_BYTES);
      this.assertCurrent(senderId, record);
      this.assertMyOauthActive();
      let ephemeralSecret = '';
      try {
        ephemeralSecret = String((JSON.parse(admittedText) as { value?: unknown }).value || '');
      } catch {
        // Normalized below.
      }
      if (!ephemeralSecret) {
        throw new RowboatRealtimeVoiceError(
          'GPT Realtime OAuth admission returned no session credential.',
          'provider_unavailable',
        );
      }
      const signaled = await this.fetchWithTimeout(record, CALLS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ephemeralSecret}`,
          'Content-Type': 'application/sdp',
        },
        body: offer,
      });
      ephemeralSecret = '';
      this.assertCurrent(senderId, record);
      this.assertMyOauthActive();
      if (!signaled.ok) {
        await readBoundedText(signaled, MAX_ERROR_BYTES).catch(() => '');
        throw new RowboatRealtimeVoiceError(
          `GPT Realtime WebRTC signaling failed (HTTP ${signaled.status}).`,
          failureReason(signaled.status),
          signaled.status,
        );
      }
      const answerSdp = await readBoundedText(signaled, MAX_SDP_BYTES);
      this.assertCurrent(senderId, record);
      this.assertMyOauthActive();
      if (!answerSdp.startsWith('v=0')) {
        throw new RowboatRealtimeVoiceError(
          'GPT Realtime WebRTC signaling returned an invalid answer.',
          'provider_unavailable',
        );
      }
      return {
        ok: true as const,
        sessionId: record.id,
        generation: record.generation,
        answerSdp,
        provider: MODEL,
      };
    } catch (error) {
      return { ok: false as const, ...publicFailure(error) };
    } finally {
      clearTimeout(timeout);
      if (this.sessions.get(senderId) === record) record.negotiating = false;
    }
  }

  stop(
    event: IpcMainInvokeEvent,
    input: { sessionId: string; generation: number },
  ) {
    const senderId = this.authorize(event);
    const record = this.sessions.get(senderId);
    if (record && record.id === input.sessionId && record.generation === input.generation) {
      this.stopForSender(senderId);
    }
    return { ok: true as const };
  }

  stopAll(): void {
    for (const senderId of this.sessions.keys()) this.stopForSender(senderId);
  }

  private stopForSender(senderId: number): void {
    const record = this.sessions.get(senderId);
    if (!record) return;
    this.sessions.delete(senderId);
    record.abort.abort();
  }

  private assertCurrent(senderId: number, record: SessionRecord): void {
    if (this.sessions.get(senderId) !== record || record.abort.signal.aborted) {
      throw new RowboatRealtimeVoiceError(
        'The Rowboat GPT Realtime voice session was cancelled.',
        'cancelled',
      );
    }
  }

  private assertMyOauthActive(): void {
    if (!this.isMyOauthActive()) {
      throw new RowboatRealtimeVoiceError(
        'My OAuth voice was stopped because Rowboat Hosted is active.',
        'mode_inactive',
      );
    }
  }

  private async fetchWithTimeout(
    record: SessionRecord,
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    return this.fetchImpl(url, { ...init, signal: record.abort.signal });
  }
}

export const rowboatRealtimeVoiceBroker = new RowboatRealtimeVoiceBroker();
