import { beforeEach, describe, expect, it, vi } from "vitest";

const searchTools = vi.fn();
const executeAction = vi.fn();
const getAccount = vi.fn();

vi.mock("../../../composio/client.js", () => ({
    executeAction,
    isConfigured: vi.fn(async () => true),
    searchTools,
}));

vi.mock("../../../composio/repo.js", () => ({
    composioAccountsRepo: {
        getAccount,
        isConnected: vi.fn(() => true),
    },
}));

const { composioTools } = await import("./composio.js");

describe("Composio builtin tools", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAccount.mockReturnValue({ id: "connected-account", status: "ACTIVE" });
    });

    it("normalizes an upcoming Google Calendar query to constrained event discovery", async () => {
        searchTools.mockResolvedValue({ items: [] });

        await composioTools["composio-search-tools"].execute({
            query: "Google Calendar List Upcoming Events",
        });

        expect(searchTools).toHaveBeenCalledWith("list events", ["googlecalendar"]);
    });

    it("does not rewrite mutating Calendar discovery requests", async () => {
        searchTools.mockResolvedValue({ items: [] });

        await composioTools["composio-search-tools"].execute({
            query: "delete upcoming events",
            toolkitSlug: "googlecalendar",
        });

        expect(searchTools).toHaveBeenCalledWith("delete upcoming events", ["googlecalendar"]);
    });

    it("preserves both Composio identity fields when executing a connected action", async () => {
        executeAction.mockResolvedValue({ successful: true, data: { items: [] } });

        await composioTools["composio-execute-tool"].execute({
            toolSlug: "GOOGLECALENDAR_EVENTS_LIST",
            toolkitSlug: "googlecalendar",
            arguments: { calendarId: "primary" },
        });

        expect(executeAction).toHaveBeenCalledWith("GOOGLECALENDAR_EVENTS_LIST", {
            connected_account_id: "connected-account",
            user_id: "rowboat-user",
            version: "latest",
            arguments: { calendarId: "primary" },
        });
    });
});
