import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => {
  const instances: Array<{
    connect: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
  }> = []
  let releaseConnect: (() => void) | null = null
  return {
    instances,
    deferConnect() {
      return new Promise<void>((resolve) => {
        releaseConnect = resolve
      })
    },
    release() {
      releaseConnect?.()
      releaseConnect = null
    },
    reset() {
      instances.length = 0
      releaseConnect = null
    },
  }
})

vi.mock('@/lib/rowboat-realtime-webrtc', () => {
  class RowboatRealtimeSessionError extends Error {
    reason: string
    constructor(message: string, reason: string) {
      super(message)
      this.reason = reason
    }
  }
  class RowboatRealtimeWebRtcSession {
    connect = vi.fn(() => transport.deferConnect())
    stop = vi.fn().mockResolvedValue(undefined)
    pttBegin = vi.fn()
    pttEnd = vi.fn()
    pttCancel = vi.fn()
    speak = vi.fn()
    cancelSpeech = vi.fn()
    setMuted = vi.fn()
    getLevel = vi.fn(() => 0)
    refreshContext = vi.fn().mockResolvedValue(true)
    constructor() {
      transport.instances.push(this)
    }
  }
  return { RowboatRealtimeSessionError, RowboatRealtimeWebRtcSession }
})

import { useRowboatRealtimeVoice } from './use-rowboat-realtime-voice'

describe('useRowboatRealtimeVoice', () => {
  beforeEach(() => {
    transport.reset()
    Object.defineProperty(globalThis, 'RTCPeerConnection', {
      configurable: true,
      value: class {},
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    })
    Object.defineProperty(window, 'ipc', {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'rowboatRealtimeVoice:getAuthStatus') {
            return {
              signedIn: true,
              storageReady: true,
              provider: 'gpt-realtime-2.1',
              authMode: 'chatgpt_oauth',
              owner: 'rowboat',
              transport: 'webrtc',
              output: 'gpt_realtime_audio',
            }
          }
          return { success: true }
        }),
        on: vi.fn(() => () => undefined),
      },
    })
  })

  it('invalidates a pending connect when My OAuth is switched off', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useRowboatRealtimeVoice(enabled, { onTranscript: vi.fn() }),
      { initialProps: { enabled: true } },
    )
    await act(async () => {
      await Promise.resolve()
    })

    let starting!: Promise<{ ok: boolean; reason?: string; error?: string }>
    await act(async () => {
      starting = result.current.start()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(transport.instances).toHaveLength(1)

    rerender({ enabled: false })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(transport.instances[0].stop).toHaveBeenCalled()

    transport.release()
    await expect(starting).resolves.toMatchObject({ ok: false, reason: 'cancelled' })
    expect(result.current.active).toBe(false)
    expect(window.ipc.invoke).toHaveBeenCalledWith('rowboatRealtimeVoice:cancelSignIn', null)
  })
})
