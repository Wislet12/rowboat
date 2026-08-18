import {
  buildRowboatRealtimeInstructions,
  type RowboatRealtimeContextSnapshot,
} from '@x/shared/src/realtime-voice-context.js'

const CONNECT_TIMEOUT_MS = 20_000
const ICE_GATHER_TIMEOUT_MS = 5_000
const MAX_EVENT_BYTES = 64 * 1024
const MAX_TOOL_OUTPUT_CHARS = 32_000

export type RowboatRealtimeState =
  | 'stopped'
  | 'starting'
  | 'connected'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'delegating'
  | 'speaking'
  | 'error'

export type RowboatRealtimeFailureReason =
  | 'needs_sign_in'
  | 'secure_storage_unavailable'
  | 'oauth_realtime_not_authorized'
  | 'network_unavailable'
  | 'invalid_request'
  | 'stale_session'
  | 'mode_inactive'
  | 'forbidden_sender'
  | 'provider_unavailable'
  | 'cancelled'
  | 'microphone_denied'
  | 'webrtc_unavailable'

export type RowboatRealtimeTranscript = {
  id: string
  text: string
}

export type RowboatRealtimeDelegation = {
  callId: string
  request: string
  signal: AbortSignal
}

export class RowboatRealtimeSessionError extends Error {
  reason: RowboatRealtimeFailureReason

  constructor(message: string, reason: RowboatRealtimeFailureReason) {
    super(message)
    this.name = 'RowboatRealtimeSessionError'
    this.reason = reason
  }
}

type RealtimeSessionDependencies = {
  invoke?: typeof window.ipc.invoke
  mediaDevices?: MediaDevices
  createPeer?: () => RTCPeerConnection
  createAudio?: () => HTMLAudioElement
}

type RealtimeSessionCallbacks = {
  onState?: (state: RowboatRealtimeState) => void
  onTranscript?: (transcript: RowboatRealtimeTranscript) => void
  onInterimTranscript?: (text: string) => void
  onAssistantCaption?: (text: string) => void
  onAssistantTranscript?: (transcript: RowboatRealtimeTranscript) => void
  onBargeIn?: () => void
  onDelegate?: (delegation: RowboatRealtimeDelegation) => Promise<string>
  onGetContext?: () => Promise<RowboatRealtimeContextSnapshot | null | undefined>
  onError?: (error: RowboatRealtimeSessionError) => void
}

type FunctionCall = {
  callId: string
  name: string
  argumentsJson: string
}

function waitForIce(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer)
      peer.removeEventListener('icegatheringstatechange', onChange)
      resolve()
    }
    const onChange = () => {
      if (peer.iceGatheringState === 'complete') finish()
    }
    const timer = window.setTimeout(finish, ICE_GATHER_TIMEOUT_MS)
    peer.addEventListener('icegatheringstatechange', onChange)
  })
}

function waitForChannel(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === 'open') return Promise.resolve()
  if (channel.readyState === 'closing' || channel.readyState === 'closed') {
    return Promise.reject(new Error('GPT Realtime data channel closed before it opened.'))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      channel.removeEventListener('open', onOpen)
      channel.removeEventListener('error', onError)
      channel.removeEventListener('close', onClose)
      if (error) reject(error)
      else resolve()
    }
    const onOpen = () => finish()
    const onError = () => finish(new Error('GPT Realtime data channel failed to open.'))
    const onClose = () => finish(new Error('GPT Realtime data channel closed before it opened.'))
    const timer = window.setTimeout(
      () => finish(new Error('GPT Realtime data channel did not open before the connection deadline.')),
      CONNECT_TIMEOUT_MS,
    )
    channel.addEventListener('open', onOpen)
    channel.addEventListener('error', onError)
    channel.addEventListener('close', onClose)
  })
}

function boundedText(value: unknown, max = 24_000): string {
  return String(value ?? '').slice(0, max)
}

function functionCallsFromResponse(response: Record<string, any> | undefined): FunctionCall[] {
  if (!Array.isArray(response?.output)) return []
  return response.output
    .filter((item: Record<string, any>) => item?.type === 'function_call')
    .map((item: Record<string, any>) => ({
      callId: boundedText(item.call_id, 240),
      name: boundedText(item.name, 160),
      argumentsJson: boundedText(item.arguments, 24_000),
    }))
    .filter((item: FunctionCall) => Boolean(item.callId && item.name))
}

function cancelledError(message = 'The Rowboat delegation was interrupted.'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

/**
 * Rowboat-owned full-duplex media transport for the My OAuth voice lane.
 *
 * The Realtime model owns ordinary spoken conversation and streams its audio
 * directly over WebRTC. It receives one narrow function, rowboat_delegate,
 * which calls back into Rowboat's existing Codex/tool runtime for grounded or
 * durable work. No JARVIS process, hosted TTS engine, or text-readback queue is
 * involved in this session.
 */
export class RowboatRealtimeWebRtcSession {
  private invoke: typeof window.ipc.invoke
  private mediaDevices: MediaDevices
  private createPeer: () => RTCPeerConnection
  private createAudio: () => HTMLAudioElement
  private callbacks: RealtimeSessionCallbacks
  private peer: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private stream: MediaStream | null = null
  private audio: HTMLAudioElement | null = null
  private audioContext: AudioContext | null = null
  private audioAnalyser: AnalyserNode | null = null
  private audioLevelData: Uint8Array<ArrayBuffer> | null = null
  private sessionId = ''
  private generation = 0
  private epoch = 0
  private closed = false
  private userSpeaking = false
  private state: RowboatRealtimeState = 'stopped'
  private completedTranscripts = new Set<string>()
  private completedAssistantTranscripts = new Set<string>()
  private handledFunctionCalls = new Set<string>()
  private activeDelegations = new Map<string, AbortController>()
  private pendingFunctionCalls = new Set<string>()
  private handlingFunctionBatch = false
  private currentResponseId = ''
  private assistantCaption = ''
  private contextRevision = 0
  private inputTurnRevision = 0

  constructor(
    callbacks: RealtimeSessionCallbacks = {},
    dependencies: RealtimeSessionDependencies = {},
  ) {
    this.callbacks = callbacks
    this.invoke = dependencies.invoke ?? window.ipc.invoke
    this.mediaDevices = dependencies.mediaDevices ?? navigator.mediaDevices
    this.createPeer = dependencies.createPeer ?? (() => new RTCPeerConnection())
    this.createAudio = dependencies.createAudio ?? (() => document.createElement('audio'))
  }

  async connect(): Promise<void> {
    if (this.peer) return
    this.closed = false
    const epoch = ++this.epoch
    this.reportState('starting')

    const prepared = await this.invoke('rowboatRealtimeVoice:prepare', null)
    if (!prepared.ok) {
      throw new RowboatRealtimeSessionError(
        prepared.error || 'GPT Realtime OAuth voice could not start.',
        prepared.reason,
      )
    }
    if (this.closed || epoch !== this.epoch) {
      await this.invoke('rowboatRealtimeVoice:stop', {
        sessionId: prepared.sessionId,
        generation: prepared.generation,
      }).catch(() => undefined)
      throw new RowboatRealtimeSessionError('Voice start was cancelled.', 'cancelled')
    }
    this.sessionId = prepared.sessionId
    this.generation = prepared.generation

    let acquiredStream: MediaStream
    try {
      acquiredStream = await this.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
    } catch (error) {
      await this.stop()
      const denied = error instanceof DOMException
        && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      throw new RowboatRealtimeSessionError(
        denied ? 'Microphone permission is required for a Rowboat voice call.' : 'Rowboat could not open the microphone.',
        denied ? 'microphone_denied' : 'webrtc_unavailable',
      )
    }
    if (this.closed || epoch !== this.epoch) {
      for (const track of acquiredStream.getTracks()) track.stop()
      await this.invoke('rowboatRealtimeVoice:stop', {
        sessionId: prepared.sessionId,
        generation: prepared.generation,
      }).catch(() => undefined)
      throw new RowboatRealtimeSessionError('Voice start was cancelled.', 'cancelled')
    }
    this.stream = acquiredStream
    for (const track of acquiredStream.getAudioTracks()) track.enabled = true
    this.diagnostic('microphone', { continuous: true, enabled: true })

    const peer = this.createPeer()
    const channel = peer.createDataChannel('oai-events')
    const audio = this.createAudio()
    audio.autoplay = true
    audio.setAttribute('playsinline', 'true')
    this.peer = peer
    this.channel = channel
    this.audio = audio

    peer.ontrack = (event) => {
      if (this.peer !== peer || this.closed) return
      const remoteStream = event.streams[0] ?? new MediaStream([event.track])
      audio.srcObject = remoteStream
      this.diagnostic('remote_audio', { attached: true })
      this.attachAudioAnalyser(remoteStream)
      void audio.play().catch(() => {
        this.fail(new RowboatRealtimeSessionError(
          'Rowboat received GPT Realtime audio, but Windows blocked playback.',
          'webrtc_unavailable',
        ))
      })
    }
    channel.onmessage = (message) => this.handleProviderEvent(message.data)
    peer.onconnectionstatechange = () => {
      if (this.peer !== peer || this.closed) return
      if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
        this.fail(new RowboatRealtimeSessionError(
          'The Rowboat GPT Realtime voice connection was interrupted.',
          'network_unavailable',
        ))
      }
    }
    for (const track of acquiredStream.getAudioTracks()) peer.addTrack(track, acquiredStream)

    try {
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      await waitForIce(peer)
      if (this.closed || epoch !== this.epoch) throw cancelledError('Voice start was cancelled.')
      const sdp = peer.localDescription?.sdp || offer.sdp || ''
      const result = await this.invoke('rowboatRealtimeVoice:negotiate', {
        sessionId: this.sessionId,
        generation: this.generation,
        sdp,
      })
      if (!result.ok) {
        throw new RowboatRealtimeSessionError(
          result.error || 'GPT Realtime WebRTC signaling failed.',
          result.reason,
        )
      }
      if (this.closed || epoch !== this.epoch) throw cancelledError('Voice start was cancelled.')
      await peer.setRemoteDescription({ type: 'answer', sdp: result.answerSdp })
      await waitForChannel(channel)
      if (this.closed || epoch !== this.epoch) throw cancelledError('Voice start was cancelled.')
      await this.refreshContext()
      if (this.closed || epoch !== this.epoch) throw cancelledError('Voice start was cancelled.')
      this.reportState('connected')
    } catch (error) {
      await this.stop()
      if (error instanceof RowboatRealtimeSessionError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new RowboatRealtimeSessionError(error.message, 'cancelled')
      }
      throw new RowboatRealtimeSessionError(
        error instanceof Error ? error.message : 'GPT Realtime WebRTC connection failed.',
        'webrtc_unavailable',
      )
    }
  }

  /**
   * Retained for the shared call controls, but My OAuth no longer uses a
   * push-to-talk gate. The microphone stays live until mute or call teardown.
   */
  pttBegin(): void {
    this.setMuted(false)
  }

  pttEnd(): void {
    // VAD commits the turn. Rowboat creates the response after the current
    // permission-checked context snapshot has replaced the previous one.
  }

  pttCancel(): void {
    // Do not mute a continuous call just because a legacy PTT edge was seen.
  }

  setMuted(muted: boolean): void {
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted
    this.diagnostic('microphone', { continuous: true, enabled: !muted })
    if (muted) {
      this.send({ type: 'input_audio_buffer.clear' })
      this.userSpeaking = false
      this.callbacks.onInterimTranscript?.('')
      this.reportState('connected')
    }
  }

  cancelSpeech(): void {
    this.abortDelegations(true)
    if (this.currentResponseId) {
      this.send({ type: 'response.cancel', response_id: this.currentResponseId })
      this.send({ type: 'output_audio_buffer.clear' })
      this.currentResponseId = ''
    }
    this.assistantCaption = ''
    this.callbacks.onAssistantCaption?.('')
    if (!this.closed && !this.userSpeaking) this.reportState('connected')
  }

  getLevel(): number {
    if (!this.audioAnalyser || !this.audioLevelData) return this.state === 'speaking' ? 0.18 : 0
    this.audioAnalyser.getByteTimeDomainData(this.audioLevelData)
    let energy = 0
    for (const sample of this.audioLevelData) {
      const normalized = (sample - 128) / 128
      energy += normalized * normalized
    }
    return Math.min(1, Math.sqrt(energy / this.audioLevelData.length) * 3)
  }

  /**
   * Replace the provider's current note/page awareness without stacking it.
   * The revision guard prevents a slow Alpha capture from overwriting a newer
   * Beta capture when the user switches notes quickly.
   */
  async refreshContext(): Promise<boolean> {
    const revision = ++this.contextRevision
    let snapshot: RowboatRealtimeContextSnapshot | null | undefined
    try {
      snapshot = await this.callbacks.onGetContext?.()
    } catch {
      snapshot = null
    }
    if (this.closed || revision !== this.contextRevision) return false
    const context = snapshot ?? { kind: 'empty' as const, capturedAt: new Date().toISOString() }
    const sent = this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: buildRowboatRealtimeInstructions(context),
      },
    })
    this.diagnostic('context', {
      phase: sent ? 'replaced' : 'unavailable',
      kind: context.kind,
      contextId: context.kind === 'note'
        ? context.contextId
        : context.kind === 'browser'
          ? context.snapshotId || context.tabId || context.url
          : '',
      revision,
    })
    return sent
  }

  async stop(): Promise<void> {
    if (this.closed && !this.sessionId) return
    this.closed = true
    ++this.epoch
    const sessionId = this.sessionId
    const generation = this.generation
    this.sessionId = ''
    this.generation = 0
    this.abortDelegations(false)
    this.completedTranscripts.clear()
    this.completedAssistantTranscripts.clear()
    this.handledFunctionCalls.clear()
    this.pendingFunctionCalls.clear()
    this.currentResponseId = ''
    this.assistantCaption = ''
    this.userSpeaking = false
    ++this.contextRevision
    ++this.inputTurnRevision

    const channel = this.channel
    const peer = this.peer
    const stream = this.stream
    const audio = this.audio
    const audioContext = this.audioContext
    this.channel = null
    this.peer = null
    this.stream = null
    this.audio = null
    this.audioContext = null
    this.audioAnalyser = null
    this.audioLevelData = null

    if (channel) {
      channel.onmessage = null
      channel.close()
    }
    if (peer) {
      peer.ontrack = null
      peer.onconnectionstatechange = null
      peer.close()
    }
    for (const track of stream?.getTracks() ?? []) track.stop()
    if (stream) {
      this.diagnostic('microphone', {
        continuous: true,
        enabled: false,
        stopped: true,
      })
    }
    if (audio) {
      audio.pause()
      audio.srcObject = null
      audio.remove()
    }
    if (audioContext) await audioContext.close().catch(() => undefined)
    if (sessionId && generation) {
      await this.invoke('rowboatRealtimeVoice:stop', { sessionId, generation }).catch(() => undefined)
    }
    this.callbacks.onInterimTranscript?.('')
    this.callbacks.onAssistantCaption?.('')
    this.reportState('stopped')
  }

  private send(event: Record<string, unknown>): boolean {
    if (!this.channel || this.channel.readyState !== 'open') return false
    this.channel.send(JSON.stringify({
      event_id: `rowboat_${crypto.randomUUID()}`,
      ...event,
    }))
    this.diagnostic('client_event', { type: boundedText(event.type, 160) })
    return true
  }

  private handleProviderEvent(raw: unknown): void {
    const serialized = typeof raw === 'string' ? raw : String(raw ?? '')
    if (new TextEncoder().encode(serialized).byteLength > MAX_EVENT_BYTES) return
    let event: Record<string, any>
    try {
      event = JSON.parse(serialized) as Record<string, any>
    } catch {
      return
    }

    const type = boundedText(event.type, 160)
    this.diagnostic('provider_event', { type })
    if (type === 'input_audio_buffer.speech_started') {
      ++this.inputTurnRevision
      this.userSpeaking = true
      this.abortDelegations(true)
      this.currentResponseId = ''
      this.assistantCaption = ''
      this.callbacks.onAssistantCaption?.('')
      this.callbacks.onBargeIn?.()
      this.reportState('listening')
      return
    }
    if (type === 'input_audio_buffer.speech_stopped') {
      this.userSpeaking = false
      this.reportState('transcribing')
      return
    }
    if (type === 'conversation.item.input_audio_transcription.delta') {
      this.callbacks.onInterimTranscript?.(boundedText(event.delta))
      return
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = boundedText(event.transcript).trim()
      const identity = boundedText(event.item_id || event.event_id || transcript, 240)
      if (transcript && !this.completedTranscripts.has(identity)) {
        this.completedTranscripts.add(identity)
        this.trimSet(this.completedTranscripts)
        this.callbacks.onInterimTranscript?.('')
        this.callbacks.onTranscript?.({ id: identity, text: transcript })
        const turnRevision = this.inputTurnRevision
        void this.createResponseForTranscript(turnRevision)
      }
      return
    }
    if (type === 'conversation.item.input_audio_transcription.failed') {
      this.fail(new RowboatRealtimeSessionError(
        boundedText(event.error?.message, 700) || 'GPT Realtime could not transcribe that utterance.',
        'provider_unavailable',
      ))
      return
    }
    if (type === 'response.created') {
      this.currentResponseId = boundedText(event.response?.id, 160)
      this.assistantCaption = ''
      this.callbacks.onAssistantCaption?.('')
      this.reportState('thinking')
      return
    }
    if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
      this.reportState('speaking')
      return
    }
    if (
      type === 'response.output_audio_transcript.delta'
      || type === 'response.audio_transcript.delta'
    ) {
      const delta = boundedText(event.delta)
      if (delta) {
        this.assistantCaption = boundedText(this.assistantCaption + delta)
        this.callbacks.onAssistantCaption?.(this.assistantCaption)
        this.reportState('speaking')
      }
      return
    }
    if (
      type === 'response.output_audio_transcript.done'
      || type === 'response.audio_transcript.done'
    ) {
      const text = boundedText(event.transcript || this.assistantCaption).trim()
      const identity = boundedText(event.item_id || event.response_id || event.event_id || text, 240)
      if (text) {
        this.assistantCaption = text
        this.callbacks.onAssistantCaption?.(text)
        if (!this.completedAssistantTranscripts.has(identity)) {
          this.completedAssistantTranscripts.add(identity)
          this.trimSet(this.completedAssistantTranscripts)
          this.callbacks.onAssistantTranscript?.({ id: identity, text })
        }
      }
      return
    }
    if (type === 'response.done') {
      const calls = functionCallsFromResponse(event.response)
        .filter((call) => !this.handledFunctionCalls.has(call.callId))
      this.handlingFunctionBatch = true
      for (const call of calls) this.pendingFunctionCalls.add(call.callId)
      for (const call of calls) {
        this.handleFunctionCall(call)
      }
      this.handlingFunctionBatch = false
      if (calls.length > 0) this.maybeContinueAfterFunctions()
      const responseId = boundedText(event.response?.id, 160)
      if (!responseId || responseId === this.currentResponseId) this.currentResponseId = ''
      if (this.activeDelegations.size === 0 && this.pendingFunctionCalls.size === 0 && calls.length === 0) {
        this.reportState(this.userSpeaking ? 'listening' : 'connected')
      }
      return
    }
    if (type === 'error') {
      const message = boundedText(event.error?.message || event.message, 700)
      if (/no active response|not active|nothing to cancel|input audio buffer.*(?:empty|too small)/i.test(message)) {
        return
      }
      this.fail(new RowboatRealtimeSessionError(
        message || 'GPT Realtime voice reported an error.',
        'provider_unavailable',
      ))
    }
  }

  private async createResponseForTranscript(turnRevision: number): Promise<void> {
    await this.refreshContext()
    if (
      this.closed
      || this.userSpeaking
      || turnRevision !== this.inputTurnRevision
    ) return
    this.reportState('thinking')
    this.send({ type: 'response.create' })
  }

  private handleFunctionCall(call: FunctionCall): void {
    if (!call.callId || this.closed) return
    if (this.handledFunctionCalls.has(call.callId)) {
      this.pendingFunctionCalls.delete(call.callId)
      return
    }
    this.handledFunctionCalls.add(call.callId)
    this.trimSet(this.handledFunctionCalls)

    let request = ''
    try {
      const parsed = JSON.parse(call.argumentsJson || '{}') as { request?: unknown }
      request = boundedText(parsed.request).trim()
    } catch {
      // Normalized into a provider-safe function output below.
    }
    if (call.name !== 'rowboat_delegate' || !request) {
      this.pendingFunctionCalls.delete(call.callId)
      this.sendFunctionOutput(call.callId, {
        ok: false,
        error: call.name === 'rowboat_delegate'
          ? 'Rowboat delegation requires a non-empty request.'
          : `Unknown Rowboat function: ${call.name || 'unnamed'}.`,
      })
      this.maybeContinueAfterFunctions()
      return
    }
    if (!this.callbacks.onDelegate) {
      this.pendingFunctionCalls.delete(call.callId)
      this.sendFunctionOutput(call.callId, {
        ok: false,
        error: 'Rowboat’s delegation runtime is unavailable.',
      })
      this.maybeContinueAfterFunctions()
      return
    }

    const controller = new AbortController()
    this.activeDelegations.set(call.callId, controller)
    this.diagnostic('delegation', { phase: 'started', callId: call.callId })
    this.reportState('delegating')
    void this.callbacks.onDelegate({
      callId: call.callId,
      request,
      signal: controller.signal,
    }).then((result) => {
      if (this.closed || this.activeDelegations.get(call.callId) !== controller) return
      this.activeDelegations.delete(call.callId)
      this.pendingFunctionCalls.delete(call.callId)
      this.diagnostic('delegation', { phase: 'completed', callId: call.callId })
      this.sendFunctionOutput(call.callId, {
        ok: true,
        result: boundedText(result, MAX_TOOL_OUTPUT_CHARS),
      })
      this.maybeContinueAfterFunctions()
    }).catch((error) => {
      if (this.closed || this.activeDelegations.get(call.callId) !== controller) return
      this.activeDelegations.delete(call.callId)
      this.pendingFunctionCalls.delete(call.callId)
      const wasCancelled = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
      this.diagnostic('delegation', {
        phase: wasCancelled ? 'cancelled' : 'failed',
        callId: call.callId,
      })
      this.sendFunctionOutput(call.callId, {
        ok: false,
        cancelled: wasCancelled,
        error: wasCancelled
          ? 'The delegated Rowboat task was interrupted by the user.'
          : boundedText(error instanceof Error ? error.message : error, 1000),
      })
      this.maybeContinueAfterFunctions()
    })
  }

  private abortDelegations(sendOutput: boolean): void {
    for (const [callId, controller] of this.activeDelegations) {
      this.activeDelegations.delete(callId)
      this.pendingFunctionCalls.delete(callId)
      controller.abort(cancelledError())
      this.diagnostic('delegation', { phase: 'cancelled', callId })
      if (sendOutput) {
        this.sendFunctionOutput(callId, {
          ok: false,
          cancelled: true,
          error: 'The delegated Rowboat task was interrupted by the user.',
        })
      }
    }
  }

  private maybeContinueAfterFunctions(): void {
    if (
      this.closed
      || this.handlingFunctionBatch
      || this.userSpeaking
      || this.activeDelegations.size > 0
      || this.pendingFunctionCalls.size > 0
    ) return
    this.reportState('thinking')
    this.send({ type: 'response.create' })
  }

  private sendFunctionOutput(callId: string, output: Record<string, unknown>): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(output).slice(0, MAX_TOOL_OUTPUT_CHARS),
      },
    })
  }

  private trimSet(values: Set<string>): void {
    while (values.size > 128) {
      const oldest = values.values().next().value
      if (!oldest) break
      values.delete(oldest)
    }
  }

  private reportState(state: RowboatRealtimeState): void {
    this.state = state
    this.diagnostic('state', { state })
    this.callbacks.onState?.(state)
  }

  private diagnostic(kind: string, detail: Record<string, unknown>): void {
    try {
      window.dispatchEvent(new CustomEvent('rowboat-realtime-diagnostic', {
        detail: {
          kind,
          at: performance.now(),
          ...detail,
        },
      }))
    } catch {
      // Diagnostics are intentionally best-effort and contain no credentials.
    }
  }

  private attachAudioAnalyser(stream: MediaStream): void {
    if (this.audioContext || typeof window.AudioContext === 'undefined') return
    try {
      const context = new window.AudioContext()
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      context.createMediaStreamSource(stream).connect(analyser)
      this.audioContext = context
      this.audioAnalyser = analyser
      this.audioLevelData = new Uint8Array(new ArrayBuffer(analyser.fftSize))
      void context.resume().catch(() => undefined)
    } catch {
      this.audioContext = null
      this.audioAnalyser = null
      this.audioLevelData = null
    }
  }

  private fail(error: RowboatRealtimeSessionError): void {
    this.reportState('error')
    this.callbacks.onError?.(error)
  }
}
