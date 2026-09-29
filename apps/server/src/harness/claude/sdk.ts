/**
 * The slice of the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) the Claude Code harness
 * uses (I-173), behind an injectable seam so every test runs against a scripted fake and never
 * the real CLI:
 *
 *   const sdk = realClaudeSdk();                          // lazy `import()` of the SDK
 *   const q = await sdk.query({ prompt: input, options }); // one Claude Code process
 *   for await (const message of q) …              // SDK messages (loosely typed: ClaudeWire)
 *
 * Wire messages are handled as loose JSON (`ClaudeWire`), like pi's RPC events, so the
 * translator's fixtures stay small and a newer SDK adding fields never breaks the build. Options
 * use the SDK's own `Options` type (type-only import; nothing is loaded until a query starts).
 */
import type { CanUseTool, McpServerConfig, Options, PermissionMode, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

export type { CanUseTool, McpServerConfig, Options as ClaudeOptions, PermissionMode, PermissionResult };

/** Any SDK message (`SDKMessage`), read field by field. */
export type ClaudeWire = Record<string, unknown> & { type: string; subtype?: string };

/** A user message written to Claude Code's input stream (`SDKUserMessage`). */
export interface ClaudeUserInput {
  type: "user";
  message: { role: "user"; content: string | Array<Record<string, unknown>> };
  parent_tool_use_id: null;
  priority?: "now" | "next" | "later";
}

/** `SlashCommand` of the SDK. */
export interface ClaudeSlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

/** `ModelInfo` of the SDK. */
export interface ClaudeModelInfo {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: Array<"low" | "medium" | "high" | "xhigh" | "max">;
  supportsAdaptiveThinking?: boolean;
  /** The model can run in auto mode (I-174). */
  supportsAutoMode?: boolean;
}

/** What `initializationResult()` answers (the fields we read). */
export interface ClaudeInitResult {
  commands: ClaudeSlashCommand[];
  models: ClaudeModelInfo[];
  account?: Record<string, unknown>;
}

/** The methods of the SDK's `Query` we use. */
export interface ClaudeQuery extends AsyncIterable<ClaudeWire> {
  interrupt(): Promise<unknown>;
  setModel(model?: string): Promise<void>;
  /** Switch the permission mode of the running session (I-174). */
  setPermissionMode(mode: PermissionMode): Promise<void>;
  initializationResult(): Promise<ClaudeInitResult>;
  supportedCommands(): Promise<ClaudeSlashCommand[]>;
  close(): void;
}

export interface ClaudeQueryParams {
  prompt: string | AsyncIterable<ClaudeUserInput>;
  options: Options;
}

/** A tool of an in-process MCP server (built with the SDK's `tool()`). */
export interface ClaudeMcpToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments (objects of strings/numbers/booleans). */
  parameters: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
}

export interface ClaudeSdk {
  /** Start a Claude Code process (the SDK is loaded on first use). */
  query(params: ClaudeQueryParams): Promise<ClaudeQuery>;
  /** Remove a persisted session (`~/.claude/projects/…/<id>.jsonl`; all project folders without `dir`). */
  deleteSession(sessionId: string, dir?: string): Promise<void>;
  /** Whether Claude Code has a persisted session with this id in `dir` (so it can be resumed). */
  hasSession(sessionId: string, dir: string): Promise<boolean>;
  /** An in-process MCP server (`createSdkMcpServer`) with these tools. */
  mcpServer(name: string, tools: ClaudeMcpToolSpec[]): Promise<McpServerConfig>;
}

type SdkModule = typeof import("@anthropic-ai/claude-agent-sdk");

let loading: Promise<SdkModule> | null = null;
function load(): Promise<SdkModule> {
  loading ??= import("@anthropic-ai/claude-agent-sdk");
  return loading;
}

/** The real SDK, imported on first use (it's large and most servers never start Claude Code). */
export function realClaudeSdk(): ClaudeSdk {
  return {
    async query(params) {
      const sdk = await load();
      return sdk.query(params as Parameters<SdkModule["query"]>[0]) as unknown as ClaudeQuery;
    },
    async deleteSession(sessionId, dir) {
      const sdk = await load();
      await sdk.deleteSession(sessionId, dir ? { dir } : undefined);
    },
    async hasSession(sessionId, dir) {
      const sdk = await load();
      return (await sdk.getSessionInfo(sessionId, { dir }).catch(() => undefined)) !== undefined;
    },
    async mcpServer(name, tools) {
      const sdk = await load();
      const { jsonSchemaShape } = await import("./json-schema-zod.js");
      return sdk.createSdkMcpServer({
        name,
        version: "1.0.0",
        tools: tools.map((t) => sdk.tool(t.name, t.description, jsonSchemaShape(t.parameters), (args) => t.handler(args as Record<string, unknown>))),
      });
    },
  };
}
