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

/** Tools grouped under a namespace (the model sees them as `<namespace>` tools). */
export interface DynamicToolNamespaceSpec {
  type: "namespace";
  name: string;
  description: string;
  tools: DynamicToolSpec[];
}

export interface ThreadStartParams {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
  /** `config.toml` overrides for this thread (dotted keys, like `codex -c`). */
  config?: Record<string, JsonValue> | null;
  /** Experimental API: tools Codex calls back through `item/tool/call`; kept with the thread. */
  dynamicTools?: Array<DynamicToolSpec | DynamicToolNamespaceSpec> | null;
}

export interface ThreadResumeParams {
  threadId: string;
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  developerInstructions?: string | null;
  config?: Record<string, JsonValue> | null;
  /** Metadata only, no history (Glade has the transcript). */
  excludeTurns?: boolean;
}

/** A process a thread's commands left running (experimental `thread/backgroundTerminals/list`). */
export interface ThreadBackgroundTerminal {
  itemId: string;
  processId: string;
  command: string;
}

export interface ThreadBackgroundTerminalsListResponse {
  data: ThreadBackgroundTerminal[];
  nextCursor: string | null;
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

export interface ThreadResumeResponse extends ThreadStartResponse {
  /** The thread's collaboration mode (experimental), when it has one. */
  collaborationMode?: CollaborationMode | null;
}

// Collaboration modes (I-186, experimental) ----------------------------------------------------------

/** `ModeKind`: Codex's Plan mode or its Default. */
export type CollaborationModeKind = "plan" | "default";

/** `CollaborationMode` (turn/start's `collaborationMode`); `developer_instructions: null` = Codex's built-in ones. */
export interface CollaborationMode {
  mode: CollaborationModeKind;
  settings: { model: string; reasoning_effort: string | null; developer_instructions: string | null };
}

/** `collaborationMode/list`: Codex's presets (0.159.1: Plan with effort "medium", Default). */
export interface CollaborationModeListResponse {
  data: Array<{ name: string; mode: CollaborationModeKind | null; model: string | null; reasoning_effort: string | null }>;
}

export type UserInput =
  | { type: "text"; text: string; text_elements: unknown[] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  /** A skill the user invoked (`$name` in Codex's TUI): Codex adds its SKILL.md to the turn. */
  | { type: "skill"; name: string; path: string };

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  approvalPolicy?: AskForApproval | null;
  sandboxPolicy?: SandboxPolicy | null;
  model?: string | null;
  effort?: string | null;
  /** "auto" | "concise" | "detailed" | "none". */
  summary?: string | null;
  /** Experimental (I-186): Codex's Plan / Default mode for this and later turns. */
  collaborationMode?: CollaborationMode | null;
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

// Skills, review, commands (I-178) -------------------------------------------------------------------

export type SkillScope = "user" | "repo" | "system" | "admin";

export interface SkillMetadata {
  name: string;
  description: string;
  /** Legacy `short_description` of SKILL.md. */
  shortDescription?: string;
  interface?: { displayName?: string; shortDescription?: string; defaultPrompt?: string };
  path: string;
  scope: SkillScope;
  enabled: boolean;
  pluginId: string | null;
}

/** `skills/list` (`cwds` empty: the server's cwd; `forceReload` re-scans the disk). */
export interface SkillsListParams {
  cwds?: string[];
  forceReload?: boolean;
}

export interface SkillsListResponse {
  data: Array<{ cwd: string; skills: SkillMetadata[]; errors: Array<{ path: string; message: string }> }>;
}

export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title: string | null }
  | { type: "custom"; instructions: string };

/** `review/start`: Codex's /review as a turn of the thread (`inline`) or a new thread (`detached`, deprecated). */
export interface ReviewStartParams {
  threadId: string;
  target: ReviewTarget;
  delivery?: "inline" | "detached" | null;
}

export interface ReviewStartResponse {
  turn: Turn;
  reviewThreadId: string;
}

/**
 * `command/exec`: a standalone command (argv) in the server's sandbox, no thread or turn. With a
 * `processId` and `streamStdoutStderr` the output arrives as `command/exec/outputDelta`
 * notifications and the reply (after the process exits) has empty stdout/stderr.
 */
export interface CommandExecParams {
  command: string[];
  processId?: string | null;
  tty?: boolean;
  streamStdin?: boolean;
  streamStdoutStderr?: boolean;
  outputBytesCap?: number | null;
  disableOutputCap?: boolean;
  disableTimeout?: boolean;
  timeoutMs?: number | null;
  cwd?: string | null;
  env?: Record<string, string | null> | null;
  sandboxPolicy?: SandboxPolicy | null;
  permissionProfile?: string | null;
}

export interface CommandExecResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Connection-scoped (no thread id): routed by `processId`. */
export interface CommandExecOutputDeltaNotification {
  processId: string;
  stream: "stdout" | "stderr";
  deltaBase64: string;
  /** The last chunk of a stream cut by `outputBytesCap`. */
  capReached: boolean;
}

/** `thread/inject_items`: raw Responses API items appended to the thread's model-visible history. */
export interface ThreadInjectItemsParams {
  threadId: string;
  items: JsonValue[];
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
  | {
      type: "collabAgentToolCall";
      id: string;
      tool: string;
      status: string;
      prompt: string | null;
      /** Per sub-agent thread: its status and last message. */
      agentsStates?: Record<string, { status: string; message: string | null } | undefined> | null;
    }
  /** Codex's multi-agent v2 (GPT-6 models): a sub-agent started, finished, … (its own thread). */
  | { type: "subAgentActivity"; id: string; kind: "started" | "interacted" | "interrupted" | "completed"; agentThreadId: string; agentPath: string }
  | { type: "webSearch"; id: string; query: string; action: WebSearchAction | null }
  | { type: "imageView"; id: string; path: string }
  | { type: "enteredReviewMode"; id: string; review: string }
  | { type: "exitedReviewMode"; id: string; review: string }
  | { type: "contextCompaction"; id: string }
  | { type: "hookPrompt" | "functionCallOutput" | "sleep" | "imageGeneration"; id: string };

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
