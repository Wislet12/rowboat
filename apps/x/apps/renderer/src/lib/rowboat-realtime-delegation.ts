import type { z } from 'zod'
import type { UserMessage } from '@x/shared/src/message.js'
import type { RequestedAgent, TurnState } from '@x/shared/src/turns.js'
import { ipcSessionsClient, type SessionsClient } from '@/lib/session-chat/client'
import { stripVoiceTags } from '@/lib/session-chat/turn-view'
import { followTurn } from '@/lib/turn-follower'
import { subscribeTurnFeed } from '@/lib/turn-feed'

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const MAX_RESULT_CHARS = 32_000

export type RowboatDelegationInput = {
  callId: string
  sessionId: string
  input: z.infer<typeof UserMessage>
  config: {
    agent: z.infer<typeof RequestedAgent>
    autoPermission?: boolean
    maxModelCalls?: number
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
  }
  signal: AbortSignal
  onTurnId?: (turnId: string) => void
  timeoutMs?: number
}

type DelegationDependencies = {
  client?: SessionsClient
  subscribe?: typeof subscribeTurnFeed
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function assistantText(state: TurnState): string {
  if (state.terminal?.type !== 'turn_completed') return ''
  const content = state.terminal.output.content
  const text = typeof content === 'string'
    ? content
    : content.map((part) => part.type === 'text' ? part.text : '').join('')
  return stripVoiceTags(text).trim().slice(0, MAX_RESULT_CHARS)
}

/**
 * Runs one exact Rowboat turn for a Realtime function call and follows that
 * exact turn to its terminal event. Abort stops only this foreground delegated
 * turn; unrelated Rowboat background work is never targeted.
 */
export async function runRowboatRealtimeDelegation(
  input: RowboatDelegationInput,
  dependencies: DelegationDependencies = {},
): Promise<string> {
  const client = dependencies.client ?? ipcSessionsClient
  const subscribe = dependencies.subscribe ?? subscribeTurnFeed
  if (input.signal.aborted) throw abortError('The Rowboat delegation was interrupted.')

  const { turnId } = await client.sendMessage(input.sessionId, input.input, input.config)
  input.onTurnId?.(turnId)
  if (input.signal.aborted) {
    await Promise.resolve(client.stopTurn(turnId, 'Interrupted by voice barge-in')).catch(() => undefined)
    throw abortError('The Rowboat delegation was interrupted.')
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let stopFollowing: () => void = () => undefined
    const finish = (error?: Error, result?: string) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      input.signal.removeEventListener('abort', onAbort)
      stopFollowing()
      if (error) reject(error)
      else resolve(result || 'Rowboat completed the delegated task.')
    }
    const onAbort = () => {
      void Promise.resolve(client.stopTurn(turnId, 'Interrupted by voice barge-in')).finally(() => {
        finish(abortError('The Rowboat delegation was interrupted.'))
      })
    }
    const timer = window.setTimeout(() => {
      void Promise.resolve(client.stopTurn(turnId, 'Voice delegation timed out')).finally(() => {
        finish(new Error('The Rowboat delegation timed out before it completed.'))
      })
    }, timeoutMs)

    input.signal.addEventListener('abort', onAbort, { once: true })
    stopFollowing = followTurn(turnId, {
      fetchTurn: (id) => client.getTurn(id),
      subscribe,
      onState: (state) => {
        const terminal = state.terminal
        if (!terminal) return
        if (terminal.type === 'turn_completed') {
          finish(undefined, assistantText(state) || 'Rowboat completed the delegated task.')
        } else if (terminal.type === 'turn_cancelled') {
          finish(abortError(terminal.reason || 'The Rowboat delegation was cancelled.'))
        } else {
          finish(new Error(terminal.error || 'The Rowboat delegation failed.'))
        }
      },
      onError: (message) => finish(new Error(message)),
      onSnapshotFailed: (message) => finish(new Error(`Rowboat could not follow the delegated turn: ${message}`)),
    })
  })
}
