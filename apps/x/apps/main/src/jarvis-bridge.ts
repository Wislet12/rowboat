import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import { getChatGPTAuthSource, getChatGPTStatus } from "@x/core/dist/auth/chatgpt-auth.js";
import { getModelCatalog } from "@x/core/dist/models/catalog.js";
import { lastAssistantText } from "@x/core/dist/runtime/assembly/headless.js";
import type { ISessions } from "@x/core/dist/runtime/sessions/index.js";
import {
  deriveTurnStatus,
  outstandingPermissions,
  reduceTurn,
} from "@x/shared/dist/turns.js";
import {
  getJarvisExecutionProfile,
  setJarvisExecutionProfile,
  type JarvisReasoningEffort,
} from "./jarvis-execution-profile.js";
import {
  getJarvisExecutionAuthority,
  setJarvisExecutionAuthority,
} from "./jarvis-execution-authority.js";

const PROTOCOL = "jarvis.rowboat.v1";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_OBJECTIVE_CHARS = 24_000;
const MAX_CONTEXT_CHARS = 16_000;

type DelegationRecord = {
  id: string;
  sessionId: string;
  turnId: string;
  objective: string;
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  createdAt: string;
};

type JarvisBridgeOptions = {
  sessions: ISessions;
  focus: () => void;
  onExecutionProfile?: (profile: {
    provider: "codex";
    model: string;
    reasoningEffort: JarvisReasoningEffort;
    enforcedAtChatLevel: true;
    updatedAt: string;
  }) => Promise<void> | void;
  token?: string;
  discoveryFile?: string;
  windowSnapshot?: () => {
    nativeHandle: string;
    visible: boolean;
    docked: boolean;
  };
  setDocked?: (docked: boolean, visible: boolean) => void;
};

export type JarvisBridgeHandle = {
  endpoint: string;
  stop: () => Promise<void>;
};

function compact(value: unknown, max = 500): string {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function secureEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function bearerToken(request: IncomingMessage): string {
  const header = String(request.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.byteLength,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  response.end(payload);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

async function codexModels(): Promise<Array<{
  id: string;
  name: string;
  reasoning: boolean | null;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
}>> {
  const catalog = await getModelCatalog();
  const provider = catalog.providers.find((entry) => entry.id === "codex");
  return (provider?.models || []).map((model) => ({
    id: model.id,
    name: model.name || model.id,
    reasoning: typeof model.reasoning === "boolean" ? model.reasoning : null,
    defaultReasoningEffort: model.defaultReasoningEffort || "medium",
    supportedReasoningEfforts: model.supportedReasoningEfforts?.length
      ? model.supportedReasoningEfforts
      : ["low", "medium", "high"],
  }));
}

async function resolveCodexExecutionProfile(
  requestedModel: string,
  requestedReasoning: string,
): Promise<{
  model: string;
  reasoningEffort: JarvisReasoningEffort;
  models: Awaited<ReturnType<typeof codexModels>>;
}> {
  const models = await codexModels();
  const model = requestedModel || models[0]?.id || "gpt-5.6-sol";
  if (models.length > 0 && !models.some((entry) => entry.id === model)) {
    throw new Error(`Unsupported Codex model: ${compact(model, 120)}`);
  }
  const selectedModel = models.find((entry) => entry.id === model);
  const supportedReasoningEfforts = selectedModel?.supportedReasoningEfforts?.length
    ? selectedModel.supportedReasoningEfforts
    : ["low", "medium", "high"];
  const fallbackReasoningEffort = supportedReasoningEfforts.includes(selectedModel?.defaultReasoningEffort || "")
    ? selectedModel!.defaultReasoningEffort
    : supportedReasoningEfforts[0] || "medium";
  const reasoningEffort = (supportedReasoningEfforts.includes(requestedReasoning)
    ? requestedReasoning
    : fallbackReasoningEffort) as JarvisReasoningEffort;
  return { model, reasoningEffort, models };
}

function terminalError(state: ReturnType<typeof reduceTurn>): string {
  if (state.terminal?.type === "turn_failed") return compact(state.terminal.error, 2_000);
  if (state.terminal?.type === "turn_cancelled") return compact(state.terminal.reason, 2_000);
  const failedCall = [...state.modelCalls].reverse().find((call) => call.error);
  return compact(failedCall?.error, 2_000);
}

async function delegationSnapshot(
  sessions: ISessions,
  record: DelegationRecord,
): Promise<Record<string, unknown>> {
  const turn = await sessions.getTurn(record.turnId);
  const state = reduceTurn(turn.events);
  const durableStatus = deriveTurnStatus(state);
  const status = durableStatus === "idle" ? "running" : durableStatus;
  const permissions = outstandingPermissions(state).map((call) => ({
    toolCallId: call.toolCallId,
    toolName: call.toolName,
  }));
  return {
    protocol: PROTOCOL,
    id: record.id,
    sessionId: record.sessionId,
    turnId: record.turnId,
    objective: record.objective,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    status,
    output: lastAssistantText(state) || "",
    error: terminalError(state),
    pendingPermissions: permissions,
    requiresOperator: permissions.length > 0,
    createdAt: record.createdAt,
    updatedAt: new Date().toISOString(),
  };
}

async function writeDiscovery(filePath: string, endpoint: string): Promise<void> {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({
    protocol: PROTOCOL,
    endpoint,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, resolved);
}

export async function startJarvisBridge({
  sessions,
  focus,
  onExecutionProfile = () => undefined,
  token: tokenOverride,
  discoveryFile: discoveryFileOverride,
  windowSnapshot = () => ({ nativeHandle: "", visible: false, docked: false }),
  setDocked = () => undefined,
}: JarvisBridgeOptions): Promise<JarvisBridgeHandle | null> {
  const token = String(tokenOverride || process.env.ROWBOAT_JARVIS_BRIDGE_TOKEN || "").trim();
  const discoveryFile = String(discoveryFileOverride || process.env.ROWBOAT_JARVIS_BRIDGE_DISCOVERY_FILE || "").trim();
  if (!token || !discoveryFile) return null;
  if (token.length < 32) throw new Error("ROWBOAT_JARVIS_BRIDGE_TOKEN must contain at least 32 characters.");

  const delegations = new Map<string, DelegationRecord>();
  const server = http.createServer(async (request, response) => {
    try {
      if (!secureEqual(bearerToken(request), token)) {
        writeJson(response, 401, { protocol: PROTOCOL, error: "Unauthorized" });
        return;
      }
      const method = String(request.method || "GET").toUpperCase();
      const url = new URL(request.url || "/", "http://127.0.0.1");

      if (method === "GET" && url.pathname === "/v1/health") {
        writeJson(response, 200, { protocol: PROTOCOL, status: "ready", pid: process.pid });
        return;
      }
      if (method === "GET" && url.pathname === "/v1/status") {
        const executionAuthority = getJarvisExecutionAuthority();
        const [auth, authSource, models] = await Promise.all([
          getChatGPTStatus(),
          getChatGPTAuthSource(),
          executionAuthority.managed ? codexModels().catch(() => []) : Promise.resolve([]),
        ]);
        writeJson(response, 200, {
          protocol: PROTOCOL,
          status: "ready",
          pid: process.pid,
          auth: {
            signedIn: auth.signedIn,
            source: authSource,
            accountId: auth.accountId || "",
          },
          models,
          executionAuthority,
          executionProfile: getJarvisExecutionProfile(),
          plan: executionAuthority.managed
            ? {
                source: "jarvis_codex_oauth",
                label: "My OAuth",
                constrained: false,
                billingEnforced: false,
                detail: "Codex OAuth authorizes text, while Rowboat owns a separate ChatGPT OAuth GPT Realtime voice lane. Rowboat Hosted plan limits are not consulted; the OAuth account's own limits may still apply.",
              }
            : {
                source: "rowboat_hosted",
                label: "Rowboat hosted account",
                constrained: true,
                billingEnforced: true,
                detail: "Rowboat-hosted execution is selected explicitly, so its account plan and credit limits apply.",
              },
          features: [
            "local_markdown_knowledge_graph",
            "backlinked_brain",
            "email_prioritization",
            "context_aware_draft_replies",
            "gmail_calendar_drive",
            "project_workspaces",
            "durable_chats",
            "event_scheduled_window_agents",
            "live_notes",
            "isolated_browser",
            "web_research",
            "meeting_preparation",
            "meeting_transcription",
            "meeting_summaries",
            "calls_video_screen_share",
            "code_mode",
            "parallel_coding_agents",
            "mini_apps",
            "local_file_tools",
            "mcp_servers",
            "composio_integrations",
            "skills",
            "permission_aware_tools",
            "codex_oauth",
            "codex_model_selection",
            "codex_reasoning_effort_selection",
            "jarvis_codex_oauth_unmetered_by_rowboat",
            "execution_authority_toggle",
            "optional_provider_profiles",
            "local_models",
          ],
          window: windowSnapshot(),
          activeDelegations: [...delegations.values()].length,
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      if (method === "GET" && url.pathname === "/v1/models") {
        writeJson(response, 200, { protocol: PROTOCOL, provider: "codex", models: await codexModels() });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/execution-authority") {
        const body = await readJsonBody(request);
        const requestedMode = String(body.mode || "").trim().toLowerCase();
        if (requestedMode !== "jarvis_oauth" && requestedMode !== "rowboat_hosted") {
          writeJson(response, 400, { protocol: PROTOCOL, error: "Execution authority must be jarvis_oauth or rowboat_hosted." });
          return;
        }
        const executionAuthority = await setJarvisExecutionAuthority(requestedMode);
        writeJson(response, 200, {
          protocol: PROTOCOL,
          status: "enforced",
          executionAuthority,
        });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/execution-profile") {
        if (!getJarvisExecutionAuthority().managed) {
          writeJson(response, 409, {
            protocol: PROTOCOL,
            error: "Switch execution authority to My OAuth before enforcing a Codex model profile.",
          });
          return;
        }
        const body = await readJsonBody(request);
        const resolved = await resolveCodexExecutionProfile(
          String(body.model || "").trim(),
          String(body.reasoningEffort || "medium").trim().toLowerCase(),
        );
        const executionProfile = setJarvisExecutionProfile(resolved.model, resolved.reasoningEffort);
        await onExecutionProfile(executionProfile);
        writeJson(response, 200, {
          protocol: PROTOCOL,
          status: "enforced",
          executionProfile,
        });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/focus") {
        focus();
        writeJson(response, 200, { protocol: PROTOCOL, status: "focused" });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/window") {
        const body = await readJsonBody(request);
        const docked = body.docked === true;
        const visible = body.visible !== false;
        setDocked(docked, visible);
        writeJson(response, 200, {
          protocol: PROTOCOL,
          status: docked ? "docked" : (visible ? "standalone" : "hidden"),
          window: windowSnapshot(),
        });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/detach") {
        setDocked(false, false);
        writeJson(response, 200, { protocol: PROTOCOL, status: "detaching" });
        setImmediate(() => {
          server.close(() => undefined);
          void fs.rm(path.resolve(discoveryFile), { force: true }).catch(() => undefined);
        });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/delegations") {
        const body = await readJsonBody(request);
        const objective = String(body.objective || "").trim().slice(0, MAX_OBJECTIVE_CHARS);
        const context = String(body.context || "").trim().slice(0, MAX_CONTEXT_CHARS);
        const requestedModel = String(body.model || "").trim();
        const requestedReasoning = String(body.reasoningEffort || "medium").trim().toLowerCase();
        if (!objective) {
          writeJson(response, 400, { protocol: PROTOCOL, error: "A Rowboat objective is required." });
          return;
        }
        if (!getJarvisExecutionAuthority().managed) {
          writeJson(response, 409, {
            protocol: PROTOCOL,
            error: "Rowboat delegation through JARVIS requires the My OAuth authority toggle.",
          });
          return;
        }
        const auth = await getChatGPTStatus();
        if (!auth.signedIn) {
          writeJson(response, 409, { protocol: PROTOCOL, error: "Shared JARVIS/Codex ChatGPT sign-in is required." });
          return;
        }
        const resolved = await resolveCodexExecutionProfile(requestedModel, requestedReasoning);
        const { model, reasoningEffort } = resolved;
        const sessionId = await sessions.createSession({ title: `JARVIS · ${objective.slice(0, 90)}` });
        const input = context
          ? `${objective}\n\nJARVIS context:\n${context}`
          : objective;
        const { turnId } = await sessions.sendMessage(
          sessionId,
          { role: "user", content: input },
          {
            agent: {
              agentId: "copilot",
              overrides: { model: { provider: "codex", model } },
            },
            autoPermission: false,
            reasoningEffort,
          },
        );
        const record: DelegationRecord = {
          id: turnId,
          sessionId,
          turnId,
          objective,
          model,
          reasoningEffort,
          createdAt: new Date().toISOString(),
        };
        delegations.set(record.id, record);
        writeJson(response, 202, await delegationSnapshot(sessions, record));
        return;
      }

      const delegationMatch = url.pathname.match(/^\/v1\/delegations\/([^/]+)$/);
      if (delegationMatch) {
        const record = delegations.get(decodeURIComponent(delegationMatch[1]));
        if (!record) {
          writeJson(response, 404, { protocol: PROTOCOL, error: "Delegation not found." });
          return;
        }
        if (method === "GET") {
          writeJson(response, 200, await delegationSnapshot(sessions, record));
          return;
        }
        if (method === "DELETE") {
          await sessions.stopTurn(record.turnId, "Cancelled by JARVIS operator.");
          writeJson(response, 200, await delegationSnapshot(sessions, record));
          return;
        }
      }

      writeJson(response, 404, { protocol: PROTOCOL, error: "Not found" });
    } catch (error) {
      writeJson(response, 500, {
        protocol: PROTOCOL,
        error: compact(error instanceof Error ? error.message : error, 1_000) || "Rowboat bridge request failed.",
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Rowboat JARVIS bridge did not bind a loopback port.");
  }
  const endpoint = `http://127.0.0.1:${address.port}`;
  await writeDiscovery(discoveryFile, endpoint);
  console.log(`[JARVIS Bridge] Ready on loopback with protocol ${PROTOCOL}`);

  let stopped = false;
  return {
    endpoint,
    async stop() {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(path.resolve(discoveryFile), { force: true }).catch(() => undefined);
    },
  };
}
