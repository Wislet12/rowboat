import { z } from "zod";
import type { JsonValue } from "@x/shared/dist/turns.js";
import { getToolPermissionMetadata } from "../../assembly/permission-metadata.js";
import { BuiltinTools } from "../../tools/catalog.js";
import type { BuiltinToolPermission } from "../../tools/types.js";
import type {
    IPermissionChecker,
    PermissionCheckAllowed,
    PermissionCheckInput,
    PermissionCheckRequired,
} from "../permission.js";

type BuiltinPolicy = z.infer<typeof BuiltinToolPermission>;

export interface RealPermissionCheckerDeps {
    getMetadata?: typeof getToolPermissionMetadata;
    getPolicy?: (name: string) => BuiltinPolicy | undefined;
}

const ComposioExecuteInput = z.object({
    toolkitSlug: z.string(),
    toolSlug: z.string(),
});

const McpExecuteInput = z.object({
    serverName: z.string(),
    toolName: z.string(),
});

// Composio uses descriptive action slugs rather than an explicit read/write
// capability bit. Keep this deterministic and fail closed: an action is
// considered read-only only when it contains a known read verb and contains
// no known side-effect verb. Mutation wins for mixed slugs such as
// GMAIL_GET_OR_CREATE_LABEL.
const COMPOSIO_READ_TOKENS = new Set([
    "COUNT",
    "DESCRIBE",
    "FETCH",
    "FIND",
    "GET",
    "INSPECT",
    "LIST",
    "LOOKUP",
    "QUERY",
    "READ",
    "RETRIEVE",
    "SEARCH",
    "VIEW",
]);

const COMPOSIO_MUTATION_TOKENS = new Set([
    "ACCEPT",
    "ADD",
    "APPROVE",
    "ARCHIVE",
    "ASSIGN",
    "BOOK",
    "CANCEL",
    "CLOSE",
    "CONNECT",
    "COPY",
    "CREATE",
    "DECLINE",
    "DELETE",
    "DISABLE",
    "DISCONNECT",
    "EDIT",
    "ENABLE",
    "EXECUTE",
    "FORWARD",
    "INVITE",
    "MARK",
    "MERGE",
    "MODIFY",
    "MOVE",
    "POST",
    "PUBLISH",
    "REJECT",
    "REMOVE",
    "REOPEN",
    "REPLY",
    "RESCHEDULE",
    "RUN",
    "SCHEDULE",
    "SEND",
    "SHARE",
    "SIGN",
    "STAR",
    "START",
    "STOP",
    "SUBSCRIBE",
    "TRASH",
    "TRIGGER",
    "UNASSIGN",
    "UNSHARE",
    "UNSTAR",
    "UNSUBSCRIBE",
    "UPDATE",
    "UPLOAD",
    "WRITE",
]);

export function isReadOnlyComposioToolSlug(toolSlug: string): boolean {
    const tokens = toolSlug
        .toUpperCase()
        .split(/[^A-Z0-9]+/)
        .filter(Boolean);
    if (tokens.some((token) => COMPOSIO_MUTATION_TOKENS.has(token))) {
        return false;
    }
    return tokens.some((token) => COMPOSIO_READ_TOKENS.has(token));
}

// Bridges the deterministic permission rules. Policy is declared per tool in
// the builtin catalog (tools/types.ts) and the checker FAILS CLOSED: any
// tool without a "none" declaration — undeclared builtins, mcp:* attachments
// on user agents, future toolId families — requires permission. Session
// grants are deferred, so the session grant inputs are always empty. A
// thrown metadata error propagates: the turn loop fails closed on checker
// errors.
export class RealPermissionChecker implements IPermissionChecker {
    private readonly getMetadata: typeof getToolPermissionMetadata;
    private readonly getPolicy: (name: string) => BuiltinPolicy | undefined;

    constructor(deps: RealPermissionCheckerDeps = {}) {
        this.getMetadata = deps.getMetadata ?? getToolPermissionMetadata;
        this.getPolicy =
            deps.getPolicy ?? ((name) => BuiltinTools[name]?.permission);
    }

    async check(
        input: PermissionCheckInput,
    ): Promise<PermissionCheckAllowed | PermissionCheckRequired> {
        if (!input.toolId.startsWith("builtin:")) {
            // mcp:<server>:<tool> attachments on user agents, and any future
            // toolId family: fail closed with a family-specific request.
            if (input.toolId.startsWith("mcp:")) {
                const serverName = input.toolId.split(":")[1];
                return {
                    required: true,
                    request: {
                        kind: "mcp",
                        ...(serverName ? { serverName } : {}),
                        toolName: input.toolName,
                    },
                };
            }
            return { required: true, request: genericRequest(input) };
        }

        const name = input.toolId.slice("builtin:".length);
        const policy = this.getPolicy(name);
        switch (policy) {
            case "none":
                return { required: false };
            case "prompt":
                return { required: true, request: genericRequest(input) };
            case "composio-execute": {
                const parsed = ComposioExecuteInput.safeParse(input.input);
                if (
                    parsed.success &&
                    isReadOnlyComposioToolSlug(parsed.data.toolSlug)
                ) {
                    return { required: false };
                }
                return {
                    required: true,
                    request: parsed.success
                        ? {
                              kind: "composio",
                              toolkitSlug: parsed.data.toolkitSlug,
                              toolSlug: parsed.data.toolSlug,
                          }
                        : genericRequest(input),
                };
            }
            case "mcp-execute": {
                const parsed = McpExecuteInput.safeParse(input.input);
                return {
                    required: true,
                    request: parsed.success
                        ? {
                              kind: "mcp",
                              serverName: parsed.data.serverName,
                              toolName: parsed.data.toolName,
                          }
                        : genericRequest(input),
                };
            }
            case "command-allowlist":
            case "file-boundary": {
                const metadata = await this.getMetadata(
                    {
                        type: "tool-call",
                        toolCallId: input.toolCallId,
                        toolName: input.toolName,
                        arguments: input.input,
                    },
                    { type: "builtin", name },
                    new Set<string>(), // session-scoped command grants: deferred
                    [], // session-scoped file grants: deferred
                );
                if (!metadata) {
                    return { required: false };
                }
                return { required: true, request: metadata as JsonValue };
            }
            case undefined:
                // Not in the catalog (or missing a declaration at runtime):
                // fail closed rather than silently executing.
                return { required: true, request: genericRequest(input) };
        }
    }
}

function genericRequest(input: PermissionCheckInput): JsonValue {
    return { kind: "tool", toolId: input.toolId, toolName: input.toolName };
}
