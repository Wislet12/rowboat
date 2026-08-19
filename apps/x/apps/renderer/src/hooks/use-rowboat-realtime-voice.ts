import { useCallback, useEffect, useRef, useState } from 'react'
import {
  RowboatRealtimeSessionError,
  RowboatRealtimeWebRtcSession,
  type RowboatRealtimeDelegation,
  type RowboatRealtimeFailureReason,
  type RowboatRealtimeState,
  type RowboatRealtimeTranscript,
} from '@/lib/rowboat-realtime-webrtc'
import type { RowboatRealtimeContextSnapshot } from '@x/shared/src/realtime-voice-context.js'

type HookCallbacks = {
  onTranscript: (transcript: RowboatRealtimeTranscript) => void
  onInterimTranscript?: (text: string) => void
  onAssistantCaption?: (text: string) => void
  onAssistantTranscript?: (transcript: RowboatRealtimeTranscript) => void
  onBargeIn?: () => void
  onDelegate?: (delegation: RowboatRealtimeDelegation) => Promise<string>
  onGetContext?: (query?: string) => Promise<RowboatRealtimeContextSnapshot | null | undefined>
  onError?: (error: RowboatRealtimeSessionError) => void
}

type AuthStatus = {
  signedIn: boolean
  storageReady: boolean
  provider: 'gpt-realtime-2.1'
  authMode: 'chatgpt_oauth'
  owner: 'rowboat'
  transport: 'webrtc'
  output: 'gpt_realtime_audio'
  voice: 'cedar'
}

const signedOutStatus: AuthStatus = {
  signedIn: false,
  storageReady: true,
  provider: 'gpt-realtime-2.1',
  authMode: 'chatgpt_oauth',
  owner: 'rowboat',
  transport: 'webrtc',
  output: 'gpt_realtime_audio',
  voice: 'cedar',
}

export function useRowboatRealtimeVoice(enabled: boolean, callbacks: HookCallbacks) {
  const [auth, setAuth] = useState<AuthStatus>(signedOutStatus)
  const [state, setState] = useState<RowboatRealtimeState>('stopped')
  const [active, setActive] = useState(false)
  const [error, setError] = useState('')
  const [failureReason, setFailureReason] = useState<RowboatRealtimeFailureReason | null>(null)
  const sessionRef = useRef<RowboatRealtimeWebRtcSession | null>(null)
  const startPromiseRef = useRef<Promise<{ ok: boolean; reason?: RowboatRealtimeFailureReason; error?: string }> | null>(null)
  const operationEpochRef = useRef(0)
  const mountedRef = useRef(true)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  const supported =
    typeof RTCPeerConnection !== 'undefined'
    && typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia

  const refreshAuth = useCallback(async () => {
    try {
      const next = await window.ipc.invoke('rowboatRealtimeVoice:getAuthStatus', null)
      if (mountedRef.current) setAuth(next)
      return next
    } catch {
      if (mountedRef.current) setAuth(signedOutStatus)
      return signedOutStatus
    }
  }, [])

  const stopSession = useCallback(async () => {
    const session = sessionRef.current
    sessionRef.current = null
    if (session) await session.stop()
    if (mountedRef.current) {
      setActive(false)
      setState('stopped')
    }
  }, [])

  const stop = useCallback(async () => {
    ++operationEpochRef.current
    await window.ipc.invoke('rowboatRealtimeVoice:cancelSignIn', null).catch(() => undefined)
    await stopSession()
  }, [stopSession])

  const signIn = useCallback(async () => {
    try {
      const result = await window.ipc.invoke('rowboatRealtimeVoice:signIn', null)
      await refreshAuth()
      return result
    } catch (caught) {
      return {
        signedIn: false,
        error: caught instanceof Error ? caught.message : 'GPT Realtime voice sign-in failed.',
      }
    }
  }, [refreshAuth])

  const signOut = useCallback(async () => {
    await stop()
    await window.ipc.invoke('rowboatRealtimeVoice:signOut', null)
    await refreshAuth()
  }, [refreshAuth, stop])

  const start = useCallback(() => {
    if (startPromiseRef.current) return startPromiseRef.current
    const operation = (async () => {
      const operationEpoch = ++operationEpochRef.current
      const isCurrent = () =>
        mountedRef.current
        && enabledRef.current
        && operationEpochRef.current === operationEpoch
      setError('')
      setFailureReason(null)
      if (!enabledRef.current) {
        return { ok: false, reason: 'invalid_request' as const, error: 'Switch on My OAuth to use GPT Realtime voice.' }
      }
      if (!supported) {
        return { ok: false, reason: 'webrtc_unavailable' as const, error: 'WebRTC microphone support is unavailable.' }
      }
      await stopSession()
      if (!isCurrent()) {
        return { ok: false, reason: 'cancelled' as const, error: 'Voice start was cancelled.' }
      }
      let currentAuth = await refreshAuth()
      if (!isCurrent()) {
        return { ok: false, reason: 'cancelled' as const, error: 'Voice start was cancelled.' }
      }
      if (!currentAuth.storageReady) {
        return {
          ok: false,
          reason: 'secure_storage_unavailable' as const,
          error: 'Secure Windows credential storage is unavailable for GPT Realtime OAuth.',
        }
      }
      if (!currentAuth.signedIn) {
        const result = await signIn()
        if (!isCurrent()) {
          return { ok: false, reason: 'cancelled' as const, error: 'Voice start was cancelled.' }
        }
        if (!result.signedIn) {
          return {
            ok: false,
            reason: 'needs_sign_in' as const,
            error: result.error || (result.cancelled ? 'Voice sign-in was cancelled.' : 'Sign in for GPT Realtime voice.'),
          }
        }
        currentAuth = await refreshAuth()
        if (!isCurrent()) {
          return { ok: false, reason: 'cancelled' as const, error: 'Voice start was cancelled.' }
        }
      }
      if (!currentAuth.signedIn) {
        return { ok: false, reason: 'needs_sign_in' as const, error: 'Sign in for GPT Realtime voice.' }
      }
      const session = new RowboatRealtimeWebRtcSession({
        onState: (next) => {
          if (!mountedRef.current || sessionRef.current !== session) return
          setState(next)
          setActive(next !== 'stopped' && next !== 'error')
        },
        onTranscript: (transcript) => callbacksRef.current.onTranscript(transcript),
        onInterimTranscript: (text) => callbacksRef.current.onInterimTranscript?.(text),
        onAssistantCaption: (text) => callbacksRef.current.onAssistantCaption?.(text),
        onAssistantTranscript: (transcript) => callbacksRef.current.onAssistantTranscript?.(transcript),
        onBargeIn: () => callbacksRef.current.onBargeIn?.(),
        onDelegate: (delegation) => {
          const callback = callbacksRef.current.onDelegate
          if (!callback) return Promise.reject(new Error('Rowboat’s delegation runtime is unavailable.'))
          return callback(delegation)
        },
        onGetContext: async (query) => (
          callbacksRef.current.onGetContext
            ? await callbacksRef.current.onGetContext(query)
            : null
        ),
        onError: (nextError) => {
          if (!mountedRef.current || sessionRef.current !== session) return
          setError(nextError.message)
          setFailureReason(nextError.reason)
          setState('error')
          setActive(false)
          callbacksRef.current.onError?.(nextError)
          sessionRef.current = null
          void session.stop()
        },
      })
      sessionRef.current = session
      try {
        await session.connect()
        if (!isCurrent() || sessionRef.current !== session) {
          await session.stop()
          return { ok: false, reason: 'cancelled' as const, error: 'Voice start was cancelled.' }
        }
        setActive(true)
        return { ok: true }
      } catch (caught) {
        if (sessionRef.current === session) sessionRef.current = null
        await session.stop()
        const nextError = caught instanceof RowboatRealtimeSessionError
          ? caught
          : new RowboatRealtimeSessionError(
              caught instanceof Error ? caught.message : 'GPT Realtime voice could not start.',
              'provider_unavailable',
            )
        if (mountedRef.current) {
          setError(nextError.message)
          setFailureReason(nextError.reason)
          setState('error')
          setActive(false)
        }
        callbacksRef.current.onError?.(nextError)
        return { ok: false, reason: nextError.reason, error: nextError.message }
      }
    })().finally(() => {
      startPromiseRef.current = null
    })
    startPromiseRef.current = operation
    return operation
  }, [refreshAuth, signIn, stopSession, supported])

  const pttBegin = useCallback(() => sessionRef.current?.pttBegin(), [])
  const pttEnd = useCallback(() => sessionRef.current?.pttEnd(), [])
  const pttCancel = useCallback(() => sessionRef.current?.pttCancel(), [])
  const cancelSpeech = useCallback(() => sessionRef.current?.cancelSpeech(), [])
  const setMuted = useCallback((muted: boolean) => sessionRef.current?.setMuted(muted), [])
  const getLevel = useCallback(() => sessionRef.current?.getLevel() ?? 0, [])
  const refreshContext = useCallback(() => sessionRef.current?.refreshContext() ?? Promise.resolve(false), [])

  useEffect(() => {
    mountedRef.current = true
    void refreshAuth()
  }, [refreshAuth])

  useEffect(() => {
    if (!enabled) void stop()
  }, [enabled, stop])

  useEffect(() => window.ipc.on('rowboatRealtimeVoice:revoked', () => {
    void stop()
  }), [stop])

  useEffect(() => () => {
    mountedRef.current = false
    ++operationEpochRef.current
    void sessionRef.current?.stop()
    sessionRef.current = null
  }, [])

  return {
    ...auth,
    supported,
    state,
    active,
    error,
    failureReason,
    refreshAuth,
    signIn,
    signOut,
    start,
    stop,
    pttBegin,
    pttEnd,
    pttCancel,
    cancelSpeech,
    setMuted,
    getLevel,
    refreshContext,
  }
}
