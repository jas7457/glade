/**
 * The part of Codex's app-server protocol Glade uses (I-177): JSON-RPC 2.0 without the `jsonrpc`
 * field, one JSON object per line over the stdio of `codex app-server`.
 *
 * Vendored by hand from the generated bindings of **codex-cli 0.159.1**
 * (`codex app-server generate-ts --experimental --out <dir>`; ts-rs output, 700+ files), trimmed to
 * the requests, notifications and fields read or sent here. Unknown fields are ignored, so newer
 * Codex versions keep working as long as these stay. Regenerate with that command to compare when
 * Codex changes its protocol. `dynamicTools` (Glade's own tools) need the experimental API
 * (`capabilities.experimentalApi` in `initialize`).
 */

export type RequestId = string | number;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** A message on the wire (requests, responses, notifications in both directions). */
export interface RpcMessage {
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// Handshake ------------------------------------------------------------------------------------

export interface InitializeParams {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: { experimentalApi: boolean; requestAttestation?: boolean; optOutNotificationMethods?: string[] | null } | null;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

// Account and limits -------------------------------------------------------------------------------

export type PlanType = string;

export type Account = { type: "apiKey" } | { type: "chatgpt"; email: string | null; planType: PlanType } | { type: "amazonBedrock" };

export interface GetAccountResponse {
  account: Account | null;
  requiresOpenaiAuth: boolean;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  /** Unix seconds. */
  resetsAt: number | null;
}

export interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  planType: PlanType | null;
  rateLimitReachedType: string | null;
}

export interface GetAccountRateLimitsResponse {
  /** `false`: the included usage is used up (null = unknown). */
  ordinaryUsageAllowed?: boolean | null;
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot | undefined> | null;
}

// Config and models ----------------------------------------------------------------------------------

/** `config/read` → `{ config }` (only the keys Glade reads). */
export interface CodexConfig {
  model?: string | null;
  model_reasoning_effort?: string | null;
  approval_policy?: unknown;
  sandbox_mode?: string | null;
}

export interface ReasoningEffortOption {
  reasoningEffort: string;
  description: string;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort: string;
  inputModalities?: string[];
  isDefault: boolean;
}

export interface ModelListResponse {
  data: CodexModel[];
  nextCursor: string | null;
}

// Threads and turns --------------------------------------------------------------------------------

export type AskForApproval = "untrusted" | "on-request" | "never" | { granular: Record<string, boolean> };
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };

export interface DynamicToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: JsonValue;
}

export interface ThreadStartParams {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
  /** Experimental API: tools Codex calls back through `item/tool/call`; kept with the thread. */
  dynamicTools?: DynamicToolSpec[] | null;
}

export interface ThreadResumeParams {
  threadId: string;
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  developerInstructions?: string | null;
  /** Metadata only, no history (Glade has the transcript). */
  excludeTurns?: boolean;
}

export interface Thread {
  id: string;
  model?: string | null;
  reasoningEffort?: string | null;
  path?: string | null;
}

export interface ThreadStartResponse {
  thread: Thread;
  model: string;
  reasoningEffort: string | null;
  approvalPolicy: AskForApproval;
  sandbox: SandboxPolicy;
}

export type ThreadResumeResponse = ThreadStartResponse;

export type UserInput =
  | { type: "text"; text: string; text_elements: unknown[] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  approvalPolicy?: AskForApproval | null;
  sandboxPolicy?: SandboxPolicy | null;
  model?: string | null;
  effort?: string | null;
  /** "auto" | "concise" | "detailed" | "none". */
  summary?: string | null;
}

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

/** `codexErrorInfo`: a string code, or `{ <code>: {...} }`. */
export type CodexErrorInfo = string | Record<string, unknown>;

export interface TurnError {
  message: string;
  codexErrorInfo: CodexErrorInfo | null;
  additionalDetails: string | null;
}

export interface Turn {
  id: string;
  status: TurnStatus;
  error: TurnError | null;
}

export interface TurnStartResponse {
  turn: Turn;
}

// Items ---------------------------------------------------------------------------------------------

export type CommandAction =
  | { type: "read"; command: string; name: string; path: string }
  | { type: "listFiles"; command: string; path: string | null }
  | { type: "search"; command: string; query: string | null; path: string | null }
  | { type: "unknown"; command: string };

export interface FileUpdateChange {
  path: string;
  kind: { type: "add" } | { type: "delete" } | { type: "update"; move_path: string | null };
  diff: string;
}

export type WebSearchAction =
  | { type: "search"; query: string | null; queries: string[] | null }
  | { type: "openPage"; url: string | null }
  | { type: "findInPage"; url: string | null; pattern: string | null }
  | { type: "other" };

export type ThreadItem =
  | { type: "userMessage"; id: string }
  | { type: "agentMessage"; id: string; text: string }
  | { type: "plan"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      status: "inProgress" | "completed" | "failed" | "declined";
      commandActions: CommandAction[];
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs: number | null;
    }
  | { type: "fileChange"; id: string; changes: FileUpdateChange[]; status: "inProgress" | "completed" | "failed" | "declined" }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      status: "inProgress" | "completed" | "failed";
      arguments: JsonValue;
      result: { content: JsonValue[]; structuredContent: JsonValue | null } | null;
      error: { message: string } | null;
    }
  | {
      type: "dynamicToolCall";
      id: string;
      namespace: string | null;
      tool: string;
      arguments: JsonValue;
      status: "inProgress" | "completed" | "failed";
      contentItems: DynamicToolCallOutputContentItem[] | null;
      success: boolean | null;
    }
  | { type: "collabAgentToolCall"; id: string; tool: string; status: string; prompt: string | null }
  | { type: "webSearch"; id: string; query: string; action: WebSearchAction | null }
  | { type: "imageView"; id: string; path: string }
  | { type: "enteredReviewMode"; id: string; review: string }
  | { type: "exitedReviewMode"; id: string; review: string }
  | { type: "contextCompaction"; id: string }
  | { type: "hookPrompt" | "functionCallOutput" | "subAgentActivity" | "sleep" | "imageGeneration"; id: string };

export type DynamicToolCallOutputContentItem = { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string };

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface TurnPlanStep {
  step: string;
  status: "pending" | "inProgress" | "completed";
}

/** Server notifications Glade handles (`method` → params). */
export interface ServerNotifications {
  error: { error: TurnError; willRetry: boolean; threadId: string; turnId: string };
  warning: { threadId: string | null; message: string };
  "turn/started": { threadId: string; turn: Turn };
  "turn/completed": { threadId: string; turn: Turn };
  "turn/plan/updated": { threadId: string; turnId: string; explanation: string | null; plan: TurnPlanStep[] };
  "item/started": { threadId: string; turnId: string; item: ThreadItem };
  "item/completed": { threadId: string; turnId: string; item: ThreadItem };
  "item/agentMessage/delta": { threadId: string; turnId: string; itemId: string; delta: string };
  "item/plan/delta": { threadId: string; turnId: string; itemId: string; delta: string };
  "item/reasoning/summaryTextDelta": { threadId: string; turnId: string; itemId: string; delta: string; summaryIndex: number };
  "item/reasoning/summaryPartAdded": { threadId: string; turnId: string; itemId: string; summaryIndex: number };
  "item/reasoning/textDelta": { threadId: string; turnId: string; itemId: string; delta: string; contentIndex: number };
  "item/commandExecution/outputDelta": { threadId: string; turnId: string; itemId: string; delta: string };
  "item/fileChange/patchUpdated": { threadId: string; turnId: string; itemId: string; changes: FileUpdateChange[] };
  "thread/tokenUsage/updated": { threadId: string; turnId: string; tokenUsage: ThreadTokenUsage };
  "thread/status/changed": { threadId: string; status: { type: string } };
  "thread/closed": { threadId: string };
  "account/rateLimits/updated": { rateLimits: RateLimitSnapshot };
  "model/rerouted": { threadId: string; turnId: string; fromModel: string; toModel: string };
}

// Server requests (approvals, questions, Glade's tools) --------------------------------------------

export interface CommandExecutionRequestApprovalParams {
  kind?: "command" | "writeStdin";
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  commandActions?: CommandAction[] | null;
  /** A command prefix Codex proposes to allow from now on (`["npm", "test"]`). */
  proposedExecpolicyAmendment?: string[] | null;
  networkApprovalContext?: { host?: string; protocol?: string } | null;
}

export type CommandExecutionApprovalDecision =
  | "accept"
  | "acceptForSession"
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | "decline"
  | "cancel";

export interface FileChangeRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
}

export type FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface PermissionsRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  cwd: string;
  reason: string | null;
  permissions: { network: unknown; fileSystem: unknown };
}

export interface ToolRequestUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: Array<{ id: string; header: string; question: string; isOther: boolean; isSecret: boolean; options: Array<{ label: string; description: string }> | null }>;
}

export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: JsonValue;
}

export interface DynamicToolCallResponse {
  contentItems: DynamicToolCallOutputContentItem[];
  success: boolean;
}
