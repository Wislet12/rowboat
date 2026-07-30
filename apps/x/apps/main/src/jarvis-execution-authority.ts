import { getChatGPTStatus } from "@x/core/dist/auth/chatgpt-auth.js";
import { loadAppSettings, saveAppSettings } from "@x/core/dist/config/app_settings.js";
import container from "@x/core/dist/di/container.js";
import { listCodexModels } from "@x/core/dist/models/codex.js";
import { getModelCatalog } from "@x/core/dist/models/catalog.js";
import type { IModelConfigRepo } from "@x/core/dist/models/repo.js";

import { clearJarvisExecutionProfile } from "./jarvis-execution-profile.js";

export type JarvisExecutionAuthorityMode = "jarvis_oauth" | "rowboat_hosted";

export type JarvisExecutionAuthority = {
  mode: JarvisExecutionAuthorityMode;
  available: boolean;
  managed: boolean;
  textProvider: "codex_oauth" | "rowboat_configured";
  voiceProvider: "gpt-realtime-2.1" | "rowboat_configured";
  voiceAuthMode: "chatgpt_oauth" | "rowboat_configured";
  voiceOutput: "pocket_tts" | "rowboat_configured";
  rowboatBillingEnforced: boolean;
};

type AuthorityTurnConfig = {
  agent:
    | {
        agentId: string;
        overrides?: {
          model?: { provider: string; model: string };
          [key: string]: unknown;
        };
      }
    | {
        inline: {
          name: string;
          instructions: string;
          model?: { provider: string; model: string };
          [key: string]: unknown;
        };
      };
  [key: string]: unknown;
};

const jarvisOauthAvailable =
  process.env.ROWBOAT_JARVIS_OAUTH_AVAILABLE === "true"
  || (
    process.env.ROWBOAT_USE_CODEX_AUTH === "true"
    && process.env.ROWBOAT_JARVIS_CODEX_UNMETERED === "true"
  );

const savedMode = loadAppSettings().rowboatExecutionAuthorityMode;
let selectedMode: JarvisExecutionAuthorityMode =
  jarvisOauthAvailable && savedMode !== "rowboat_hosted"
    ? "jarvis_oauth"
    : "rowboat_hosted";
let cachedCodexModel = "";
const listeners = new Set<(authority: JarvisExecutionAuthority) => void>();

function applyRuntimeAuthority(mode: JarvisExecutionAuthorityMode): void {
  const managed = jarvisOauthAvailable && mode === "jarvis_oauth";
  // The core Codex provider reads this dynamically for every token/status
  // request, so changing authority is effective immediately and not merely a
  // renderer preference.
  process.env.ROWBOAT_USE_CODEX_AUTH = managed ? "true" : "false";
  process.env.ROWBOAT_JARVIS_CODEX_UNMETERED = managed ? "true" : "false";
}

function publish(): JarvisExecutionAuthority {
  const authority = getJarvisExecutionAuthority();
  for (const listener of listeners) listener(authority);
  return authority;
}

async function resolveCodexModel(): Promise<string> {
  if (cachedCodexModel) return cachedCodexModel;
  const catalog = await listCodexModels();
  cachedCodexModel = String(catalog.providers[0]?.models[0]?.id || "").trim();
  if (!cachedCodexModel) {
    throw new Error("The signed-in Codex OAuth account did not expose an available model.");
  }
  return cachedCodexModel;
}

async function alignAssistantModel(mode: JarvisExecutionAuthorityMode): Promise<void> {
  const repo = container.resolve<IModelConfigRepo>("modelConfigRepo");
  const config = await repo.getConfig().catch(() => null);
  if (mode === "jarvis_oauth") {
    const codexCatalog = await listCodexModels();
    const ids = codexCatalog.providers[0]?.models.map((model) => model.id) || [];
    const existing = config?.assistantModel?.provider === "codex"
      && ids.includes(config.assistantModel.model)
      ? config.assistantModel.model
      : "";
    const model = existing || ids[0] || await resolveCodexModel();
    cachedCodexModel = model;
    await repo.updateConfig({ assistantModel: { provider: "codex", model } });
    return;
  }

  clearJarvisExecutionProfile();
  if (config?.assistantModel?.provider !== "codex") return;
  const catalog = await getModelCatalog().catch(() => null);
  const rowboatModel = catalog?.providers
    .find((provider) => provider.id === "rowboat")
    ?.models[0]?.id;
  await repo.updateConfig({
    assistantModel: rowboatModel ? { provider: "rowboat", model: rowboatModel } : null,
  });
}

applyRuntimeAuthority(selectedMode);

export function getJarvisExecutionAuthority(): JarvisExecutionAuthority {
  const managed = jarvisOauthAvailable && selectedMode === "jarvis_oauth";
  return {
    mode: managed ? "jarvis_oauth" : "rowboat_hosted",
    available: jarvisOauthAvailable,
    managed,
    textProvider: managed ? "codex_oauth" : "rowboat_configured",
    voiceProvider: managed ? "gpt-realtime-2.1" : "rowboat_configured",
    voiceAuthMode: managed ? "chatgpt_oauth" : "rowboat_configured",
    voiceOutput: managed ? "pocket_tts" : "rowboat_configured",
    // This controls Rowboat's hosted-plan surfaces only. Real provider
    // transport errors remain visible as normal chat errors.
    rowboatBillingEnforced: !managed,
  };
}

export function subscribeJarvisExecutionAuthority(
  listener: (authority: JarvisExecutionAuthority) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function setJarvisExecutionAuthority(
  mode: JarvisExecutionAuthorityMode,
): Promise<JarvisExecutionAuthority> {
  if (mode === "jarvis_oauth" && !jarvisOauthAvailable) {
    throw new Error(
      "My JARVIS OAuth is unavailable in this launch. Open Rowboat from JARVIS or the managed Rowboat desktop shortcut.",
    );
  }
  if (mode === selectedMode) return getJarvisExecutionAuthority();

  const previousMode = selectedMode;
  selectedMode = mode;
  applyRuntimeAuthority(mode);
  try {
    if (mode === "jarvis_oauth") {
      const auth = await getChatGPTStatus();
      if (!auth.signedIn) {
        throw new Error("Codex is not signed in with the operator's ChatGPT OAuth subscription.");
      }
    }
    await alignAssistantModel(mode);
    saveAppSettings({ rowboatExecutionAuthorityMode: mode });
    return publish();
  } catch (error) {
    selectedMode = previousMode;
    applyRuntimeAuthority(previousMode);
    throw error;
  }
}

/**
 * A stale native tab may still carry Rowboat's hosted model after authority
 * changes. Replace only that hosted provider at the final main-process
 * boundary. Explicit BYOK/local providers remain optional and untouched.
 */
export async function enforceJarvisExecutionAuthority<T extends AuthorityTurnConfig>(
  config: T,
): Promise<T> {
  if (!getJarvisExecutionAuthority().managed) return config;
  const requested = "agentId" in config.agent
    ? config.agent.overrides?.model
    : config.agent.inline.model;
  if (!requested || requested.provider !== "rowboat") return config;

  const model = await resolveCodexModel();
  const agent = "agentId" in config.agent
    ? {
        ...config.agent,
        overrides: {
          ...(config.agent.overrides || {}),
          model: { provider: "codex", model },
        },
      }
    : {
        ...config.agent,
        inline: {
          ...config.agent.inline,
          model: { provider: "codex", model },
        },
      };
  return { ...config, agent } as T;
}
