export type JarvisReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type JarvisExecutionProfile = {
  provider: "codex";
  model: string;
  reasoningEffort: JarvisReasoningEffort;
  enforcedAtChatLevel: true;
  updatedAt: string;
};

type TurnConfig = {
  agent:
    | {
        agentId: string;
        overrides?: {
          model?: { provider: string; model: string };
          [key: string]: unknown;
        };
        [key: string]: unknown;
      }
    | {
        inline: {
          name: string;
          instructions: string;
          model?: { provider: string; model: string };
          [key: string]: unknown;
        };
        [key: string]: unknown;
      };
  reasoningEffort?: JarvisReasoningEffort;
  [key: string]: unknown;
};

let selectedProfile: JarvisExecutionProfile | null = null;

export function getJarvisExecutionProfile(): JarvisExecutionProfile | null {
  return selectedProfile ? { ...selectedProfile } : null;
}

export function setJarvisExecutionProfile(
  model: string,
  reasoningEffort: JarvisReasoningEffort,
): JarvisExecutionProfile {
  selectedProfile = {
    provider: "codex",
    model,
    reasoningEffort,
    enforcedAtChatLevel: true,
    updatedAt: new Date().toISOString(),
  };
  return { ...selectedProfile };
}

/**
 * The native Rowboat composer can retain a per-tab selection. When Rowboat is
 * incorporated by JARVIS, the JARVIS chrome is authoritative: stamp its model
 * and reasoning effort at the final main-process boundary before the session
 * runtime receives the turn. Standalone Rowboat has no bridge profile and
 * therefore preserves the upstream per-tab behavior unchanged.
 */
export function enforceJarvisExecutionProfile<T extends TurnConfig>(config: T): T {
  const profile = selectedProfile;
  if (!profile) return config;
  const model = { provider: profile.provider, model: profile.model };
  const agent = "agentId" in config.agent
    ? {
        ...config.agent,
        overrides: {
          ...(config.agent.overrides || {}),
          model,
        },
      }
    : {
        ...config.agent,
        inline: {
          ...config.agent.inline,
          model,
        },
      };
  return {
    ...config,
    agent,
    reasoningEffort: profile.reasoningEffort,
  } as T;
}
