import { useCallback, useEffect, useRef, useState } from 'react'

export type JarvisManagedVoiceStatus = {
  supported: boolean
  managed: boolean
  status: 'stopped' | 'starting' | 'listening' | 'thinking' | 'processing' | 'speaking' | 'error'
  active: boolean
  provider: 'gpt-realtime-2.1'
  authMode: 'chatgpt_oauth'
  output: 'pocket_tts'
  updatedAt: string
  error?: string
}

const idleStatus = (managed: boolean): JarvisManagedVoiceStatus => ({
  supported: false,
  managed,
  status: 'stopped',
  active: false,
  provider: 'gpt-realtime-2.1',
  authMode: 'chatgpt_oauth',
  output: 'pocket_tts',
  updatedAt: new Date(0).toISOString(),
})

export function useJarvisManagedVoice(managed: boolean) {
  const [voice, setVoice] = useState<JarvisManagedVoiceStatus>(() => idleStatus(managed))
  const mountedRef = useRef(true)
  const previousManagedRef = useRef(managed)
  const requestEpochRef = useRef(0)

  const refresh = useCallback(async () => {
    if (!managed) return idleStatus(false)
    const epoch = requestEpochRef.current
    try {
      const next = await window.ipc.invoke('jarvis:getManagedVoiceStatus', null)
      if (mountedRef.current && epoch === requestEpochRef.current) setVoice(next)
      return next
    } catch (error) {
      const failed: JarvisManagedVoiceStatus = {
        ...idleStatus(true),
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      }
      if (mountedRef.current && epoch === requestEpochRef.current) setVoice(failed)
      return failed
    }
  }, [managed])

  const request = useCallback(async (action: 'start' | 'stop') => {
    const requestEpoch = ++requestEpochRef.current
    try {
      const next = await window.ipc.invoke('jarvis:requestManagedVoice', { action })
      const normalized = !managed && action === 'stop'
        ? { ...next, managed: false, status: 'stopped' as const, active: false }
        : next
      if (mountedRef.current && requestEpoch === requestEpochRef.current) setVoice(normalized)
      return normalized
    } catch (error) {
      const failed = {
        ...idleStatus(managed),
        accepted: false,
        status: 'error' as const,
        error: error instanceof Error ? error.message : String(error),
      }
      if (mountedRef.current && requestEpoch === requestEpochRef.current) setVoice(failed)
      return failed
    }
  }, [managed])

  useEffect(() => {
    mountedRef.current = true
    if (!managed) {
      setVoice(idleStatus(false))
      return
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 750)
    return () => window.clearInterval(timer)
  }, [managed, refresh])

  useEffect(() => {
    const wasManaged = previousManagedRef.current
    previousManagedRef.current = managed
    if (wasManaged && !managed) void request('stop')
  }, [managed, request])

  useEffect(() => () => {
    mountedRef.current = false
  }, [])

  const start = useCallback(() => request('start'), [request])
  const stop = useCallback(() => request('stop'), [request])

  return {
    ...voice,
    refresh,
    start,
    stop,
  }
}
