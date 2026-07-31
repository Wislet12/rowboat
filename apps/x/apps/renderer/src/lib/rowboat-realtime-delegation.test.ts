import { describe, expect, it, vi } from 'vitest'
import type { SessionsClient } from '@/lib/session-chat/client'
import { completedTurnLog } from '@/lib/session-chat/test-fixtures'
import { runRowboatRealtimeDelegation } from './rowboat-realtime-delegation'

const SESSION = 'voice-session'
const TURN = 'voice-turn'

function client(overrides: Partial<SessionsClient> = {}): SessionsClient {
  return {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    getTurn: vi.fn(async () => ({
      turnId: TURN,
      events: completedTurnLog(TURN, SESSION, 'Run tests', '<voice>All tests passed.</voice>'),
    })),
    sendMessage: vi.fn(async () => ({ turnId: TURN })),
    respondToPermission: vi.fn(),
    respondToAskHuman: vi.fn(),
    stopTurn: vi.fn(),
    resumeTurn: vi.fn(),
    setTitle: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  } as SessionsClient
}

const baseInput = {
  callId: 'realtime-call-1',
  sessionId: SESSION,
  input: { role: 'user' as const, content: 'Run tests' },
  config: { agent: { agentId: 'copilot' } },
}

describe('runRowboatRealtimeDelegation', () => {
  it('follows the exact Rowboat turn and returns bounded speakable output', async () => {
    const fake = client()
    const controller = new AbortController()
    const onTurnId = vi.fn()
    const result = await runRowboatRealtimeDelegation({
      ...baseInput,
      signal: controller.signal,
      onTurnId,
    }, {
      client: fake,
      subscribe: () => () => undefined,
    })

    expect(result).toBe('All tests passed.')
    expect(fake.sendMessage).toHaveBeenCalledWith(
      SESSION,
      baseInput.input,
      baseInput.config,
    )
    expect(onTurnId).toHaveBeenCalledWith(TURN)
    expect(fake.stopTurn).not.toHaveBeenCalled()
  })

  it('stops only its exact foreground turn when voice barge-in aborts', async () => {
    const never = new Promise<never>(() => undefined)
    const fake = client({
      getTurn: vi.fn(() => never),
    })
    const controller = new AbortController()
    const running = runRowboatRealtimeDelegation({
      ...baseInput,
      signal: controller.signal,
    }, {
      client: fake,
      subscribe: () => () => undefined,
    })
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()

    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(fake.stopTurn).toHaveBeenCalledOnce()
    expect(fake.stopTurn).toHaveBeenCalledWith(TURN, 'Interrupted by voice barge-in')
  })
})
