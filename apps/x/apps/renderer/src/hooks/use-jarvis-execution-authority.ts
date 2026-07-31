import { useEffect, useState } from "react"

export type JarvisExecutionAuthorityMode = "jarvis_oauth" | "rowboat_hosted"

export type JarvisExecutionAuthority = {
  mode: JarvisExecutionAuthorityMode
  available: boolean
  managed: boolean
  textProvider: "codex_oauth" | "rowboat_configured"
  voiceProvider: "gpt-realtime-2.1" | "rowboat_configured"
  voiceAuthMode: "chatgpt_oauth" | "rowboat_configured"
  voiceOutput: "gpt_realtime_audio" | "rowboat_configured"
  rowboatBillingEnforced: boolean
}

let authorityCache: JarvisExecutionAuthority | null = null
let authorityRequest: Promise<JarvisExecutionAuthority> | null = null
let ipcSubscription: (() => void) | null = null
const subscribers = new Set<(authority: JarvisExecutionAuthority) => void>()

function publish(authority: JarvisExecutionAuthority) {
  authorityCache = authority
  for (const subscriber of subscribers) subscriber(authority)
  return authority
}

function ensureIpcSubscription() {
  if (ipcSubscription) return
  ipcSubscription = window.ipc.on("jarvis:executionAuthorityChanged", publish)
}

function loadAuthority() {
  ensureIpcSubscription()
  if (authorityCache) return Promise.resolve(authorityCache)
  if (!authorityRequest) {
    authorityRequest = window.ipc
      .invoke("jarvis:getExecutionAuthority", null)
      .then(publish)
      .catch((error) => {
        authorityRequest = null
        throw error
      })
  }
  return authorityRequest
}

export async function setJarvisExecutionAuthority(
  mode: JarvisExecutionAuthorityMode,
): Promise<JarvisExecutionAuthority> {
  ensureIpcSubscription()
  return publish(await window.ipc.invoke("jarvis:setExecutionAuthority", { mode }))
}

/**
 * One process-wide policy store. The main process is authoritative because
 * renderer code cannot safely infer launch environment, OAuth provenance, or
 * billing authority from whichever Rowboat account happens to be connected.
 */
export function useJarvisExecutionAuthority() {
  const [authority, setAuthority] = useState<JarvisExecutionAuthority | null>(authorityCache)

  useEffect(() => {
    let active = true
    const subscriber = (next: JarvisExecutionAuthority) => {
      if (active) setAuthority(next)
    }
    subscribers.add(subscriber)
    void loadAuthority()
      .then(subscriber)
      .catch((error) => {
        console.error("Failed to read JARVIS execution authority:", error)
      })
    return () => {
      active = false
      subscribers.delete(subscriber)
    }
  }, [])

  return authority
}
