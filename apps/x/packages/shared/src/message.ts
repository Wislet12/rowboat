import { z } from "zod";

export const ProviderOptions = z.record(z.string(), z.record(z.string(), z.json()));

export const TextPart = z.object({
    type: z.literal("text"),
    text: z.string(),
    providerOptions: ProviderOptions.optional(),
});

export const ReasoningPart = z.object({
    type: z.literal("reasoning"),
    text: z.string(),
    providerOptions: ProviderOptions.optional(),
});

export const ToolCallPart = z.object({
    type: z.literal("tool-call"),
    toolCallId: z.string(),
    toolName: z.string(),
    arguments: z.any(),
    providerOptions: ProviderOptions.optional(),
});

export const AssistantContentPart = z.union([
    TextPart,
    ReasoningPart,
    ToolCallPart,
]);

// A piece of user-typed text within a content array
export const UserTextPart = z.object({
    type: z.literal("text"),
    text: z.string(),
});

// An attachment within a content array
export const UserAttachmentPart = z.object({
    type: z.literal("attachment"),
    path: z.string(),                    // absolute file path
    filename: z.string(),                // display name ("photo.png")
    mimeType: z.string(),                // MIME type ("image/png", "text/plain")
    size: z.number().optional(),         // bytes
    lineNumber: z.number().int().min(1).optional(),  // 1-indexed line in source file (for editor-context references)
});

// An inline image within a content array (e.g. a live webcam frame from
// video mode). Unlike attachments, image parts carry their data inline as
// base64 and are sent to the model as real multimodal image parts rather
// than a file-path reference.
export const UserImagePart = z.object({
    type: z.literal("image"),
    data: z.string(),                    // base64-encoded image bytes (no data: prefix)
    mediaType: z.string(),               // MIME type ("image/jpeg")
    source: z.enum(["camera", "screen", "clipboard"]).optional(),
    capturedAt: z.string().optional(),   // ISO timestamp of capture
});

// Any single part of a user message (text, attachment, or inline image)
export const UserContentPart = z.union([UserTextPart, UserAttachmentPart, UserImagePart]);

// Named type for user message content — used everywhere instead of repeating the union
export const UserMessageContent = z.union([z.string(), z.array(UserContentPart)]);

export const UserMessageContext = z.object({
    currentDateTime: z.string().optional(),
    // Set on the first message after a screen share stops: history keeps the
    // captured frames inline forever (pruning would bust prefix caching), so
    // the model must be told they show the past, not the current screen.
    screenShareEnded: z.boolean().optional(),
    middlePane: z.discriminatedUnion("kind", [
        z.object({
            kind: z.literal("empty"),
        }),
        z.object({
            kind: z.literal("note"),
            path: z.string(),
            content: z.string(),
            // Optional fields keep older clients/API payloads compatible while
            // giving chat and voice a stable, explicit active-note snapshot.
            contextId: z.string().optional(),
            title: z.string().optional(),
            noteType: z.enum(["meeting", "brain"]).optional(),
            metadata: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
        }),
        z.object({
            kind: z.literal("notebook"),
            path: z.string(),
            contextId: z.string(),
            title: z.string(),
            description: z.string().optional(),
            retrievalProfile: z.enum(['fast', 'balanced', 'precise']).optional(),
            query: z.string().optional(),
            sources: z.array(z.object({
                id: z.string(),
                path: z.string(),
                title: z.string(),
                content: z.string(),
                truncated: z.boolean(),
                contextMode: z.enum(['overview', 'full']),
            })),
            selectedSourceCount: z.number().int().nonnegative(),
            unavailableSources: z.array(z.object({
                path: z.string(),
                title: z.string(),
            })),
            retrievalEvidence: z.object({
                queryTermCount: z.number().int().nonnegative(),
                candidateChunkCount: z.number().int().nonnegative(),
                selectedChunkCount: z.number().int().nonnegative(),
                readableSourceCount: z.number().int().nonnegative(),
            }).optional(),
            capturedAt: z.string().optional(),
        }),
        z.object({
            kind: z.literal("mindspace"),
            contextId: z.string(),
            title: z.string(),
            selectedKind: z.enum(["map", "brainstorm", "notes"]).optional(),
            selectedId: z.string().optional(),
            content: z.string(),
            capturedAt: z.string(),
        }),
        z.object({
            kind: z.literal("browser"),
            url: z.string(),
            title: z.string(),
            tabId: z.string().optional(),
            snapshotId: z.string().optional(),
            text: z.string().optional(),
            selectedText: z.string().optional(),
            capturedAt: z.string().optional(),
            metadata: z.object({
                description: z.string().optional(),
                headings: z.array(z.string()).optional(),
                language: z.string().optional(),
            }).optional(),
            untrusted: z.boolean().optional(),
        }),
        // A .pptx open in the slide editor. Content is deliberately absent —
        // a deck's content is what deck-review reads; carrying it on every
        // message would bloat the turn. slideNumber is 1-BASED so it lines up
        // with the deck tools' own slideNumber argument (the renderer does the
        // +1 from its 0-based index).
        z.object({
            kind: z.literal("deck"),
            path: z.string(),
            slideNumber: z.number().int().min(1),
            slideCount: z.number().int().min(1),
        }),
    ]).optional(),
});

export const UserMessage = z.object({
    role: z.literal("user"),
    content: UserMessageContent,
    userMessageContext: UserMessageContext.optional(),
    providerOptions: ProviderOptions.optional(),
});

export const AssistantMessage = z.object({
    role: z.literal("assistant"),
    content: z.union([
        z.string(),
        z.array(AssistantContentPart),
    ]),
    providerOptions: ProviderOptions.optional(),
});

export const SystemMessage = z.object({
    role: z.literal("system"),
    content: z.string(),
    providerOptions: ProviderOptions.optional(),
});

export const ToolMessage = z.object({
    role: z.literal("tool"),
    content: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    providerOptions: ProviderOptions.optional(),
});

export const Message = z.discriminatedUnion("role", [
    AssistantMessage,
    SystemMessage,
    ToolMessage,
    UserMessage,
]);

export const MessageList = z.array(Message);
