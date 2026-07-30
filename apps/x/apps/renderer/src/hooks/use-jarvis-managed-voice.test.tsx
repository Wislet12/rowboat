import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useJarvisManagedVoice } from './use-jarvis-managed-voice'

const stopped = {
  supported: true,
  managed: true,
  status: 'stopped' as const,
  active: false,
  provider: 'gpt-realtime-2.1' as const,
  authMode: 'chatgpt_oauth' as const,
  output: 'pocket_tts' as const,
  updatedAt: '2026-07-30T12:00:00.000Z',
}

let requestedActions: string[] = []

;(window as unknown as { ipc: unknown }).ipc = {
  on: () => () => undefined,
  invoke: async (channel: string, args: { action?: 'start' | 'stop' } | null) => {
    if (channel === 'jarvis:getManagedVoiceStatus') return stopped
    if (channel === 'jarvis:requestManagedVoice') {
      const action = args?.action || 'stop'
      requestedActions.push(action)
      return {
        ...stopped,
        accepted: true,
        status: action === 'start' ? 'starting' : 'stopped',
        active: action === 'start',
        updatedAt: '2026-07-30T12:00:01.000Z',
      }
    }
    throw new Error(`Unexpected IPC channel ${channel}`)
  },
}

beforeEach(() => {
  requestedActions = []
})

describe('useJarvisManagedVoice', () => {
  it('exposes the OAuth voice host independently of Rowboat hosted voice configuration', async () => {
    const { result } = renderHook(() => useJarvisManagedVoice(true))

    await waitFor(() => expect(result.current.supported).toBe(true))
    expect(result.current.provider).toBe('gpt-realtime-2.1')
    expect(result.current.authMode).toBe('chatgpt_oauth')
    expect(result.current.output).toBe('pocket_tts')

    await act(async () => {
      const response = await result.current.start()
      expect(response.accepted).toBe(true)
    })

    expect(requestedActions).toEqual(['start'])
    expect(result.current.active).toBe(true)
    expect(result.current.status).toBe('starting')
  })

  it('stops an active managed lane when the operator switches to Rowboat Hosted', async () => {
    const { result, rerender } = renderHook(
      ({ managed }) => useJarvisManagedVoice(managed),
      { initialProps: { managed: true } },
    )
    await waitFor(() => expect(result.current.supported).toBe(true))

    rerender({ managed: false })

    await waitFor(() => expect(requestedActions).toContain('stop'))
    expect(result.current.managed).toBe(false)
    expect(result.current.active).toBe(false)
  })
})
