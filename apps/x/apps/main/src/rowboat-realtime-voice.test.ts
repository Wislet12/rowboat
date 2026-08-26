import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
}));

const { RowboatRealtimeVoiceBroker } = await import('./rowboat-realtime-voice.js');
const { BrowserWindow } = await import('electron');

type FakeEvent = { senderId: number };
const event = (senderId: number) => ({ senderId }) as never;
const authorizeSender = (value: unknown) => (value as FakeEvent).senderId;
const authReady = async () => ({
  signedIn: true,
  storageReady: true,
  accountId: 'voice-account',
});

describe('RowboatRealtimeVoiceBroker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps OAuth admission and WebRTC signaling inside Rowboat', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        value: 'ephemeral-session-secret',
        session: { model: 'gpt-realtime-2.1' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('v=0\r\no=answer\r\n', {
        status: 200,
        headers: { 'Content-Type': 'application/sdp' },
      }));
    const broker = new RowboatRealtimeVoiceBroker({
      fetchImpl,
      getAccessToken: async () => 'rowboat-local-voice-oauth',
      getAuthStatus: authReady,
      isMyOauthActive: () => true,
      authorizeSender,
    });

    const prepared = await broker.prepare(event(10));
    expect(prepared).toMatchObject({
      ok: true,
      provider: 'gpt-realtime-2.1',
      authMode: 'chatgpt_oauth',
      owner: 'rowboat',
      transport: 'webrtc',
      output: 'gpt_realtime_audio',
      voice: 'cedar',
    });
    if (!prepared.ok) throw new Error('prepare failed');
    const result = await broker.negotiate(event(10), {
      sessionId: prepared.sessionId,
      generation: prepared.generation,
      sdp: 'v=0\r\no=offer\r\n',
    });

    expect(result).toMatchObject({ ok: true, answerSdp: 'v=0\r\no=answer\r\n' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/realtime/client_secrets');
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer rowboat-local-voice-oauth',
      'Content-Type': 'application/json',
    });
    const admissionBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(admissionBody.session).toMatchObject({
      type: 'realtime',
      model: 'gpt-realtime-2.1',
      output_modalities: ['audio'],
      tool_choice: 'auto',
      audio: {
        input: {
          transcription: { model: 'gpt-4o-mini-transcribe' },
          turn_detection: {
            type: 'server_vad',
            create_response: false,
            interrupt_response: true,
          },
        },
        output: { voice: 'cedar' },
      },
    });
    expect(admissionBody.session.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        name: 'rowboat_delegate',
        parameters: expect.objectContaining({
          required: ['request'],
          additionalProperties: false,
        }),
      }),
    ]);
    expect(admissionBody.session.instructions).toMatch(/live conversational voice/i);
    expect(admissionBody.session.instructions).toMatch(/warm, clearly masculine[\s\S]*lower-register voice/i);
    expect(admissionBody.session.instructions).toMatch(/CURRENT LIVE CONTEXT[\s\S]*never reuse an older snapshot/i);
    expect(admissionBody.session.instructions).toMatch(/search or open other meeting or Brain notes/i);
    expect(admissionBody.session.instructions).toMatch(/every Rowboat skill, builtin tool, MCP server/i);
    expect(admissionBody.session.tools[0].description).toMatch(/live skill catalog[\s\S]*full builtin toolset/i);
    expect(admissionBody.session.instructions).not.toMatch(/speech transport|say exact text|never answer user audio/i);
    expect(JSON.stringify(admissionBody)).not.toMatch(/jarvis|pocket|gemini|api[_ -]?key/i);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://api.openai.com/v1/realtime/calls');
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      headers: {
        Authorization: 'Bearer ephemeral-session-secret',
        'Content-Type': 'application/sdp',
      },
      body: 'v=0\r\no=offer\r\n',
    });
  });

  it('does not treat the Codex text lane as voice sign-in', async () => {
    const broker = new RowboatRealtimeVoiceBroker({
      getAccessToken: async () => {
        throw new Error('must not be called');
      },
      getAuthStatus: async () => ({ signedIn: false, storageReady: true }),
      isMyOauthActive: () => true,
      authorizeSender,
    });
    await expect(broker.prepare(event(1))).resolves.toMatchObject({
      ok: false,
      reason: 'needs_sign_in',
    });
  });

  it('binds sessions to one renderer, cancels stale work, and never reuses generations', async () => {
    let releaseToken!: (value: string) => void;
    const token = new Promise<string>((resolve) => {
      releaseToken = resolve;
    });
    const fetchImpl = vi.fn();
    const broker = new RowboatRealtimeVoiceBroker({
      fetchImpl,
      getAccessToken: () => token,
      getAuthStatus: authReady,
      isMyOauthActive: () => true,
      authorizeSender,
    });
    const first = await broker.prepare(event(1));
    if (!first.ok) throw new Error('prepare failed');

    await expect(broker.negotiate(event(2), {
      sessionId: first.sessionId,
      generation: first.generation,
      sdp: 'v=0\r\no=wrong-renderer\r\n',
    })).resolves.toMatchObject({ ok: false, reason: 'stale_session' });

    const inFlight = broker.negotiate(event(1), {
      sessionId: first.sessionId,
      generation: first.generation,
      sdp: 'v=0\r\no=cancelled\r\n',
    });
    broker.stop(event(1), { sessionId: first.sessionId, generation: first.generation });
    releaseToken('late-token');
    await expect(inFlight).resolves.toMatchObject({ ok: false, reason: 'cancelled' });
    expect(fetchImpl).not.toHaveBeenCalled();

    const second = await broker.prepare(event(1));
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.generation).toBeGreaterThan(first.generation);
  });

  it('fails closed when Rowboat Hosted owns execution and cancels a mode-switch race', async () => {
    let myOauthActive = false;
    const broker = new RowboatRealtimeVoiceBroker({
      getAccessToken: async () => 'must-not-be-used',
      getAuthStatus: authReady,
      isMyOauthActive: () => myOauthActive,
      authorizeSender,
    });

    await expect(broker.prepare(event(1))).resolves.toMatchObject({
      ok: false,
      reason: 'mode_inactive',
    });

    myOauthActive = true;
    const prepared = await broker.prepare(event(1));
    if (!prepared.ok) throw new Error('prepare failed');
    myOauthActive = false;
    await expect(broker.negotiate(event(1), {
      sessionId: prepared.sessionId,
      generation: prepared.generation,
      sdp: 'v=0\r\no=offer\r\n',
    })).resolves.toMatchObject({
      ok: false,
      reason: 'mode_inactive',
    });
  });

  it('authorizes only the registered primary Rowboat webContents in production', async () => {
    const sender = {
      id: 41,
      isDestroyed: () => false,
      mainFrame: {},
      getURL: () => 'http://localhost:5173',
    };
    const primaryWindow = {
      isDestroyed: () => false,
      webContents: sender,
    };
    vi.mocked(BrowserWindow.fromWebContents).mockImplementation((candidate) =>
      candidate === sender ? primaryWindow as never : null);
    const broker = new RowboatRealtimeVoiceBroker({
      getAuthStatus: authReady,
      isMyOauthActive: () => true,
    });
    broker.setPrimarySender(sender.id);

    await expect(broker.prepare({
      sender,
      senderFrame: sender.mainFrame,
    } as never)).resolves.toMatchObject({
      ok: true,
      owner: 'rowboat',
    });

    await expect(broker.prepare({
      sender: { ...sender, id: 42 },
      senderFrame: sender.mainFrame,
    } as never)).rejects.toMatchObject({
      reason: 'forbidden_sender',
    });

    broker.stopForWebContents(sender.id);
    await expect(broker.prepare({
      sender,
      senderFrame: sender.mainFrame,
    } as never)).rejects.toMatchObject({
      reason: 'forbidden_sender',
    });
  });
});
