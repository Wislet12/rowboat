import { useEffect, useState } from "react"

export type JarvisExecutionAuthority = {
  managed: boolean
  textProvider: "codex_oauth" | "rowboat_configured"
  voiceProvider: "gpt-realtime-2.1" | "rowboat_configured"
  voiceAuthMode: "chatgpt_oauth" | "rowboat_configured"
  voiceOutput: "pocket_tts" | "rowboat_configured"
  rowboatBillingEnforced: boolean
}

let authorityRequest: Promise<JarvisExecutionAuthority> | null = null

function loadAuthority() {
  if (!authorityRequest) {
    authorityRequest = window.ipc
      .invoke("jarvis:getExecutionAuthority", null)
      .catch((error) => {
        authorityRequest = null
        throw error
      })
  }
  return authorityRequest
}

/**
 * One process-wide, deduplicated policy read. The main process is authoritative
 * because renderer code cannot safely infer launch environment or billing
 * authority from whichever Rowboat account happens to be connected.
 */
export function useJarvisExecutionAuthority() {
  const [authority, setAuthority] = useState<JarvisExecutionAuthority | null>(null)

  useEffect(() => {
    let active = true
    void loadAuthority()
      .then((value) => {
        if (active) setAuthority(value)
      })
      .catch((error) => {
        console.error("Failed to read JARVIS execution authority:", error)
      })
    return () => {
      active = false
    }
  }, [])

  return authority
}
