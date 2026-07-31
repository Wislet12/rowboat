import { describe, expect, it, vi } from 'vitest'
import { RowboatRealtimeWebRtcSession } from './rowboat-realtime-webrtc'

class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting'
  sent: Array<Record<string, any>> = []
  onmessage: ((event: MessageEvent) => void) | null = null

  send(value: string) {
    this.sent.push(JSON.parse(value) as Record<string, any>)
  }

  open() {
    this.readyState = 'open'
    this.dispatchEvent(new Event('open'))
  }

  message(value: Record<string, unknown>) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(value) }))
  }

  close() {
    this.readyState = 'closed'
    this.dispatchEvent(new Event('close'))
  }
}

class FakePeer extends EventTarget {
  iceGatheringState: RTCIceGatheringState = 'complete'
  connectionState: RTCPeerConnectionState = 'new'
  localDescription: RTCSessionDescription | null = null
  ontrack: ((event: RTCTrackEvent) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  readonly channel = new FakeChannel()

  createDataChannel() {
    return this.channel as unknown as RTCDataChannel
  }

  addTrack() {
    return {} as RTCRtpSender
  }

  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\no=rowboat-offer\r\n' } as RTCSessionDescriptionInit
  }

  async setLocalDescription(value: RTCSessionDescriptionInit) {
    this.localDescription = value as RTCSessionDescription
  }

  async setRemoteDescription() {
    this.connectionState = 'connected'
    this.channel.open()
  }

  close() {
    this.connectionState = 'closed'
  }
}

function harness(callbacks: ConstructorParameters<typeof RowboatRealtimeWebRtcSession>[0] = {}) {
  const peer = new FakePeer()
  const track = { enabled: true, stop: vi.fn() }
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream
  const audio = {
    autoplay: false,
    srcObject: null,
    setAttribute: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    remove: vi.fn(),
  } as unknown as HTMLAudioElement
  const invoke = vi.fn(async (name: string) => {
    if (name === 'rowboatRealtimeVoice:prepare') {
      return {
        ok: true,
        sessionId: '11b53142-c4c4-4f07-962b-43fa3c98fc70',
        generation: 7,
        provider: 'gpt-realtime-2.1',
        authMode: 'chatgpt_oauth',
        owner: 'rowboat',
        transport: 'webrtc',
        output: 'gpt_realtime_audio',
      }
    }
    if (name === 'rowboatRealtimeVoice:negotiate') {
      return {
        ok: true,
        sessionId: '11b53142-c4c4-4f07-962b-43fa3c98fc70',
        generation: 7,
        provider: 'gpt-realtime-2.1',
        answerSdp: 'v=0\r\no=rowboat-answer\r\n',
      }
    }
    return { ok: true }
  }) as unknown as typeof window.ipc.invoke
  const session = new RowboatRealtimeWebRtcSession(callbacks, {
    invoke,
    mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } as unknown as MediaDevices,
    createPeer: () => peer as unknown as RTCPeerConnection,
    createAudio: () => audio,
  })
  return { session, peer, track, audio, invoke }
}

describe('RowboatRealtimeWebRtcSession', () => {
  it('keeps a continuous mic, follows VAD, and renders direct provider speech', async () => {
    const onTranscript = vi.fn()
    const onAssistantCaption = vi.fn()
    const onAssistantTranscript = vi.fn()
    const onState = vi.fn()
    const { session, peer, track, audio, invoke } = harness({
      onTranscript,
      onAssistantCaption,
      onAssistantTranscript,
      onState,
    })

    await session.connect()
    expect(track.enabled).toBe(true)
    expect(onState).toHaveBeenLastCalledWith('connected')
    expect(invoke).toHaveBeenCalledWith('rowboatRealtimeVoice:negotiate', expect.objectContaining({
      generation: 7,
      sdp: 'v=0\r\no=rowboat-offer\r\n',
    }))
    expect(peer.channel.sent.map((event) => event.type)).not.toContain('input_audio_buffer.commit')

    session.setMuted(true)
    expect(track.enabled).toBe(false)
    session.setMuted(false)
    expect(track.enabled).toBe(true)

    peer.channel.message({ type: 'input_audio_buffer.speech_started' })
    expect(onState).toHaveBeenLastCalledWith('listening')
    peer.channel.message({ type: 'input_audio_buffer.speech_stopped' })
    expect(onState).toHaveBeenLastCalledWith('transcribing')
    peer.channel.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-audio-1',
      transcript: 'How are you doing today?',
    })
    expect(onTranscript).toHaveBeenCalledWith({
      id: 'user-audio-1',
      text: 'How are you doing today?',
    })

    peer.channel.message({
      type: 'response.created',
      response: { id: 'response-rowboat-1' },
    })
    peer.channel.message({
      type: 'response.output_audio_transcript.delta',
      response_id: 'response-rowboat-1',
      delta: 'I am doing ',
    })
    peer.channel.message({
      type: 'response.output_audio_transcript.delta',
      response_id: 'response-rowboat-1',
      delta: 'well.',
    })
    expect(onAssistantCaption).toHaveBeenLastCalledWith('I am doing well.')
    expect(onState).toHaveBeenLastCalledWith('speaking')
    peer.channel.message({
      type: 'response.output_audio_transcript.done',
      response_id: 'response-rowboat-1',
      item_id: 'assistant-audio-1',
      transcript: 'I am doing well.',
    })
    expect(onAssistantTranscript).toHaveBeenCalledWith({
      id: 'assistant-audio-1',
      text: 'I am doing well.',
    })
    peer.channel.message({
      type: 'response.done',
      response: { id: 'response-rowboat-1', status: 'completed', output: [] },
    })
    expect(onState).toHaveBeenLastCalledWith('connected')
    expect(JSON.stringify(peer.channel.sent)).not.toMatch(/say exactly|rowboat_speech_id/i)

    await session.stop()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(audio.pause).toHaveBeenCalledOnce()
    expect(audio.remove).toHaveBeenCalledOnce()
  })

  it('delegates one exact function call and cancels it on voice barge-in', async () => {
    const onBargeIn = vi.fn()
    const onDelegate = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('interrupted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    }))
    const { session, peer } = harness({ onDelegate, onBargeIn })
    await session.connect()

    const functionResponse = {
      type: 'response.done',
      response: {
        id: 'response-tools-1',
        status: 'completed',
        output: [{
          type: 'function_call',
          name: 'rowboat_delegate',
          call_id: 'call-rowboat-1',
          arguments: JSON.stringify({ request: 'Open the project and run its tests.' }),
        }],
      },
    }
    peer.channel.message(functionResponse)
    peer.channel.message(functionResponse)
    expect(onDelegate).toHaveBeenCalledOnce()
    expect(onDelegate).toHaveBeenCalledWith(expect.objectContaining({
      callId: 'call-rowboat-1',
      request: 'Open the project and run its tests.',
      signal: expect.any(AbortSignal),
    }))

    peer.channel.message({ type: 'input_audio_buffer.speech_started' })
    await Promise.resolve()
    await Promise.resolve()
    expect(onBargeIn).toHaveBeenCalledOnce()
    const outputs = peer.channel.sent.filter((event) =>
      event.type === 'conversation.item.create'
      && event.item?.type === 'function_call_output')
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({
      item: { call_id: 'call-rowboat-1' },
    })
    expect(String(outputs[0].item.output)).toContain('"cancelled":true')
    expect(peer.channel.sent.map((event) => event.type)).not.toContain('input_audio_buffer.commit')
  })

  it('returns a completed Rowboat delegation to the same Realtime conversation', async () => {
    const onDelegate = vi.fn().mockResolvedValue('All tests passed.')
    const { session, peer } = harness({ onDelegate })
    await session.connect()
    peer.channel.message({
      type: 'response.done',
      response: {
        id: 'response-tools-2',
        status: 'completed',
        output: [{
          type: 'function_call',
          name: 'rowboat_delegate',
          call_id: 'call-rowboat-2',
          arguments: JSON.stringify({ request: 'Run the tests.' }),
        }],
      },
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(peer.channel.sent).toContainEqual(expect.objectContaining({
      type: 'conversation.item.create',
      item: expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call-rowboat-2',
      }),
    }))
    expect(peer.channel.sent.at(-1)).toMatchObject({ type: 'response.create' })
    expect(JSON.stringify(peer.channel.sent)).not.toMatch(/jarvis|pocket|gemini/i)
  })

  it('cancels a late prepare result without opening the microphone', async () => {
    let releasePrepare!: (value: Record<string, unknown>) => void
    const prepared = new Promise<Record<string, unknown>>((resolve) => {
      releasePrepare = resolve
    })
    const invoke = vi.fn((name: string) => {
      if (name === 'rowboatRealtimeVoice:prepare') return prepared
      return Promise.resolve({ ok: true })
    }) as unknown as typeof window.ipc.invoke
    const getUserMedia = vi.fn()
    const session = new RowboatRealtimeWebRtcSession({}, {
      invoke,
      mediaDevices: { getUserMedia } as unknown as MediaDevices,
    })

    const connecting = session.connect()
    await Promise.resolve()
    await session.stop()
    releasePrepare({
      ok: true,
      sessionId: '11b53142-c4c4-4f07-962b-43fa3c98fc70',
      generation: 9,
    })

    await expect(connecting).rejects.toMatchObject({ reason: 'cancelled' })
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('rowboatRealtimeVoice:stop', {
      sessionId: '11b53142-c4c4-4f07-962b-43fa3c98fc70',
      generation: 9,
    })
  })

  it('stops tracks acquired after cancellation during getUserMedia', async () => {
    let releaseMedia!: (value: MediaStream) => void
    const media = new Promise<MediaStream>((resolve) => {
      releaseMedia = resolve
    })
    const track = { enabled: true, stop: vi.fn() }
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream
    const invoke = vi.fn((name: string) => {
      if (name === 'rowboatRealtimeVoice:prepare') {
        return Promise.resolve({
          ok: true,
          sessionId: '21b53142-c4c4-4f07-962b-43fa3c98fc70',
          generation: 10,
        })
      }
      return Promise.resolve({ ok: true })
    }) as unknown as typeof window.ipc.invoke
    const session = new RowboatRealtimeWebRtcSession({}, {
      invoke,
      mediaDevices: { getUserMedia: vi.fn(() => media) } as unknown as MediaDevices,
    })

    const connecting = session.connect()
    await Promise.resolve()
    await Promise.resolve()
    await session.stop()
    releaseMedia(stream)

    await expect(connecting).rejects.toMatchObject({ reason: 'cancelled' })
    expect(track.stop).toHaveBeenCalledOnce()
  })
})
