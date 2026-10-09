/**
 * REST + WebSocket contract between the web client and the Glade server.
 */
import type { AgentEvent, SessionState, UiResponse } from "./events.js";
import type { ModelInfo, ModelRef, ThinkingLevel } from "./models.js";
import type { ToolResult, Transcript } from "./transcript.js";
import type { ChatStatus } from "./status.js";
import type { SessionAgentState, SpawnedAgentRef } from "./agents.js";
import type { ClientSyncMessage, MessagePatch, SessionLiveState, SyncTag, TranscriptPage } from "./sync.js";
import type { EnvironmentInfo } from "./environments.js";
import type { PendingPairing } from "./auth.js";
import type { Folder } from "./folders.js";
import type { Bookmark } from "./bookmarks.js";
import type { TerminalTab } from "./terminal.js";

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  /**
   * Absolute folder path on disk. Chats in this project run with this as cwd. `null` = a **group
   * project** (I-213): just a name, no folder of its own; each of its chats picks its own folder at
   * creation (`CreateWorkspaceRequest.folder`, stored as `Workspace.cwd`, never changed after).
   */
  path: string | null;
  /** Manual position in the sidebar (ascending). New projects get the lowest value (top). */
  sortOrder: number;
  createdAt: number;
  /** Updated whenever one of its chats has activity. Not used for ordering. */
  lastActivityAt: number;
  /**
   * The environment (machine) whose files this project is (I-123). Set at creation, never changed;
   * projects from before I-123 are filled in with the local server's id. Optional on the wire so
   * old servers' projects still parse; a client treats a missing value as "the environment it
   * came from".
   */
  environmentId?: string;
  // `folderId` (I-165) is gone since I-202: projects are always top level, folders never hold
  // projects. Stores migrate it away; clients ignore it in data from an older server.
}

/**
 * One sidebar row (I-035): a titled container of agent sessions running in one folder (a
 * project's, or the scratch folder for standalone workspaces). Workspaces are independent of each
 * other, even in the same project. Ordering, pinning and project membership live here; everything
 * about a conversation lives on its {@link Session}s.
 */
export interface Workspace {
  id: string;
  /** `null` for standalone workspaces (they run in the scratch folder). */
  projectId: string | null;
  title: string;
  /** `auto` titles follow the first main session's title; `user` titles never change on their own. */
  titleSource: "auto" | "user";
  /** Working directory every session of this workspace runs in. */
  cwd: string;
  pinned: boolean;
  /** Position among the pinned workspaces of the same list (ascending). Only meaningful when pinned. */
  pinOrder?: number;
  /**
   * Manual position in its container (I-202, ascending; see `chat-order.ts`): the top level of its
   * list (a project's, or the standalone Chats section), where it shares one number space with
   * that list's folders, or the folder it's in. Pinned workspaces keep theirs for when they're
   * unpinned. Absent (records from an older server): above everything that has one, newest first.
   */
  sortOrder?: number;
  createdAt: number;
  /** Latest activity in any of its sessions. Not used for ordering. */
  lastActivityAt: number;
  /** Saved tab/pane layout (I-036). `null` until the UI stores one; the server treats it as opaque. */
  layout: WorkspaceLayout | null;
  /**
   * Set when the workspace works in its own git worktree (I-096, opt-in at creation): `cwd` is then
   * the worktree folder. Absent for workspaces working in the project folder itself.
   */
  worktree?: WorkspaceWorktree;
  /**
   * The folder it's in (I-165): a Chats-section folder (`Folder.projectId` null) for standalone
   * workspaces, a folder of its own project otherwise. Absent/`null` = not in a folder.
   */
  folderId?: string | null;
}

/** A workspace's own git worktree (I-096). */
export interface WorkspaceWorktree {
  /** Absolute path of the worktree folder (same as `Workspace.cwd`). */
  path: string;
  /** Branch checked out in the worktree, e.g. `glade/sidebar-polish`. */
  branch: string;
  /** Branch (or commit) it was created from, e.g. `main`. */
  baseRef: string;
  /** The repository's main work tree (the project folder). */
  repoRoot: string;
}

/**
 * Saved layout of a workspace's tabs. Placeholder for I-036: the server stores and returns it
 * without interpreting it (unknown session ids are the client's to ignore).
 */
export interface WorkspaceLayout {
  /**
   * Main tabs in display order: session ids and terminal ids (I-187). Sessions missing here go
   * after, by `createdAt`; terminals missing here go last.
   */
  mainOrder?: string[];
  /** Terminal tabs (I-187). The shells themselves live in the server that started them. */
  terminals?: TerminalTab[];
  /** The focused main tab is this terminal (I-187); `activeMainSessionId` stays the last focused conversation. */
  activeTerminalId?: string | null;
  /** Focused main tab. */
  activeMainSessionId?: string | null;
  /** Focused sub-agent tab per main session id. */
  activeSubagentSessionId?: Record<string, string>;
  /** Width of the sub-agent pane as a fraction of the content area (0..1). */
  subagentPaneSize?: number;
  /** The sub-agent pane is open (I-080). Closed by default; opened by clicking an agent in the strip. */
  subagentPaneOpen?: boolean;
  /** The changes panel is open (I-097). It takes the right pane's place while open. */
  changesPanelOpen?: boolean;
}

/** `main`: a tab in the main area. `subagent`: spawned by another session of the workspace (I-037). */
export type SessionKind = "main" | "subagent";

/**
 * One agent conversation (one harness session file) inside a workspace. Sessions never get their
 * own sidebar rows. All per-conversation state (transcript, live process, model, unread,
 * interrupted runs, …) is keyed by the session id.
 */
export interface Session {
  id: string;
  workspaceId: string;
  kind: SessionKind;
  /** The session that spawned this one (`subagent` only; `null` for main sessions). */
  parentSessionId: string | null;
  /** Agent name shown on a sub-agent's tab (`subagent` only). */
  agentName: string | null;
  /**
   * Fun human display name assigned at spawn, e.g. "Maya" (I-084; `subagent` only). Display-only:
   * `agentName` stays the id used by message_agent/close_agent. Absent for older agents.
   */
  agentDisplayName?: string;
  /** Colour key assigned at spawn (I-084), one of `AGENT_COLORS`; unique among active siblings. */
  agentColor?: string;
  /** Icon from the agent definition (I-218), one of `AGENT_ICONS`. */
  agentIcon?: string;
  /** Tab title. */
  title: string;
  /** `auto` titles may be replaced by generated ones; `user` titles never are. */
  titleSource: "auto" | "user";
  /** Which harness owns this session (e.g. "pi"). */
  harness: string;
  /** Harness specific reference to the persisted session (for pi: the session .jsonl path). */
  sessionRef: string | null;
  /** A run finished while the session wasn't being viewed, or the user marked it unread. */
  unread: boolean;
  /**
   * The user marked it unread ("Mark as Unread", I-073). Such a mark is only cleared by a new
   * view (opening the chat), never because the chat happens to be on screen somewhere.
   */
  markedUnread?: boolean;
  /** The most recent run ended with an error or the agent crashed. Cleared when a new run starts. */
  lastRunFailed?: boolean;
  /** Server-internal: a run started and hasn't finished yet (survives restarts; see I-025). */
  runInProgress?: boolean;
  /** The last run was cut off (app quit, crash, agent died). Cleared by any new prompt or dismissal. */
  interrupted?: boolean;
  createdAt: number;
  lastActivityAt: number;
  /** Last model / thinking level used, so re-opening restores them. */
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | null;
  /** The chat's permission mode (I-174), so a resume keeps it. Absent: the harness's default. */
  permissionMode?: string | null;
}

/** Session plus runtime state that isn't persisted. */
export interface SessionSummary extends Session {
  /**
   * The environment it belongs to (I-123). Filled in by the *client* when it receives the item
   * (servers don't send it); a missing value means the local environment.
   */
  environmentId?: string;
  running: boolean;
  /** Open agent dialogs waiting for the user. */
  pendingInputs: number;
  /** Derived with `deriveChatStatus` - the single field the UI should use for indicators. */
  status: ChatStatus;
  /** Sub-agent state (`subagent` sessions spawned via the agent API; absent otherwise). */
  agent?: SessionAgentState;
  /**
   * Sub-agents this session spawned (`main` sessions with any; I-084), oldest first, including
   * closed ones whose tab is gone: links the transcript's spawn cards to their agents' names and
   * colours after the agent closed.
   */
  spawnedAgents?: SpawnedAgentRef[];
  /**
   * I-062: another Glade server sharing this data folder is running this session's agent right
   * now (working or waiting for input). This server shows it read-only: prompts answer 409 until
   * it's idle there (then this server takes it over on the next prompt).
   */
  activeElsewhere?: ActiveElsewhere;
  /**
   * A short line for system notifications (I-135): the open question while it waits for input,
   * the error of a failed run, or the last sentence of the last reply. Only while this server has
   * the session's agent loaded; absent otherwise (and on older servers).
   */
  attentionLine?: string;
}

/** Where a session is active when it isn't this server (see `SessionSummary.activeElsewhere`). */
export interface ActiveElsewhere {
  /** The other server's kind: `"dev"` (pnpm dev) or `"desktop"` (the installed app), or another label. */
  serverKind: string;
  /** When that server took the session (ms since epoch). */
  since: number;
}

/** Human label for a server kind ("Glade (dev)", "Glade"). */
export function serverKindLabel(kind: string): string {
  return kind === "desktop" ? "Glade" : `Glade (${kind})`;
}

/** The 409 message for a session that is active in another server. */
export function activeElsewhereMessage(elsewhere: Pick<ActiveElsewhere, "serverKind">): string {
  return `Running in ${serverKindLabel(elsewhere.serverKind)} — open it there or wait until it's idle`;
}

/** Workspace plus state rolled up from all of its sessions (see `rollupWorkspace`). */
export interface WorkspaceSummary extends Workspace {
  /**
   * The environment it belongs to (I-123). Filled in by the *client* when it receives the item
   * (servers don't send it); a missing value means the local environment.
   */
  environmentId?: string;
  /** Most urgent session status (blocked > working > unread > idle). */
  status: ChatStatus;
  /** Any session is running. */
  running: boolean;
  /** Open dialogs across all sessions. */
  pendingInputs: number;
  /** Any session has an unread finished run. */
  unread: boolean;
  /** Any session's last run failed. */
  lastRunFailed: boolean;
  /** Any session's last run was interrupted. */
  interrupted: boolean;
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

/** The quick-tasks model (I-198): which agent runs quick tasks, and with which of its models. */
export interface QuickTasksModel {
  /** Harness id; it must support one-shot completion (`HarnessCapabilities`/`complete`). */
  harness: string;
  model: ModelRef;
}

/** One agent's model settings (I-198), `Settings.models.agents.<harnessId>`. */
export interface AgentModelSettings {
  /** Model for new chats with this agent. `null` = the agent's own default. */
  defaultModel: ModelRef | null;
  /** Thinking level for new chats with this agent (clamped to the model's levels). */
  defaultThinkingLevel: ThinkingLevel;
  /** Model for sub-agents of this agent's chats (I-078). `null` = the parent chat's model. */
  subagentModel: ModelRef | null;
  /** Thinking level for sub-agents (I-078). `null` = the parent chat's level. */
  subagentThinkingLevel: ThinkingLevel | null;
  /** Model for side questions in this agent's chats (`/btw`, I-140). `null` = the chat's model. */
  sideQuestionModel: ModelRef | null;
  /** Model keys (`provider/id`) hidden from this agent's pickers. */
  hiddenModels: string[];
}

export const DEFAULT_AGENT_MODEL_SETTINGS: Readonly<AgentModelSettings> = Object.freeze({
  defaultModel: null,
  defaultThinkingLevel: "medium",
  subagentModel: null,
  subagentThinkingLevel: null,
  sideQuestionModel: null,
  hiddenModels: [],
});

/**
 * The global model fields from before I-198. Servers migrate stored settings; clients still meet
 * them in settings sent by an older server (another Mac that hasn't updated), where
 * {@link agentModelSettings} reads them as the default agent's.
 */
export interface LegacyModelSettings {
  defaultModel?: ModelRef | null;
  defaultThinkingLevel?: ThinkingLevel;
  smallModel?: ModelRef | null;
  subagentModel?: ModelRef | null;
  sideQuestionModel?: ModelRef | null;
  subagentThinkingLevel?: ThinkingLevel | null;
  hiddenModels?: string[];
}

/**
 * Agent `harnessId`'s model settings with defaults filled in. `legacyOwner` is the agent the old
 * global fields belong to (the default agent): settings from an older server, without
 * `models.agents`, are read as that agent's.
 */
export function agentModelSettings(settings: Pick<Settings, "models">, harnessId: string, legacyOwner?: string | null): AgentModelSettings {
  const models = settings.models as Settings["models"] & LegacyModelSettings;
  const own = models.agents?.[harnessId];
  if (!models.agents && legacyOwner === harnessId) {
    const legacy: Partial<AgentModelSettings> = {};
    for (const key of ["defaultModel", "defaultThinkingLevel", "subagentModel", "subagentThinkingLevel", "sideQuestionModel", "hiddenModels"] as const) {
      if (models[key] !== undefined) (legacy as Record<string, unknown>)[key] = models[key];
    }
    return { ...DEFAULT_AGENT_MODEL_SETTINGS, hiddenModels: [], ...legacy };
  }
  return { ...DEFAULT_AGENT_MODEL_SETTINGS, hiddenModels: [], ...(own ?? {}) } as AgentModelSettings;
}

/** The quick-tasks model, also from an older server's `smallModel` (run by `legacyOwner`). */
export function quickTasksModel(settings: Pick<Settings, "models">, legacyOwner?: string | null): QuickTasksModel | null {
  const models = settings.models as Settings["models"] & LegacyModelSettings;
  if (models.quickTasks !== undefined) return models.quickTasks;
  return models.smallModel && legacyOwner ? { harness: legacyOwner, model: models.smallModel } : null;
}

export interface Settings {
  general: {
    // `sendKey` and `busyBehavior` were removed in I-153: ↩ sends/steers, ⌘↩ sends a follow-up.
    /** Generate a title for new chats with a model (a quick title is always set first). */
    generateTitles: boolean;
    /**
     * Generate a one-line summary of each chat with the small model after its runs (I-046).
     * Summaries help the chat finder (⌘K "Ask") match paraphrased requests.
     */
    generateSummaries: boolean;
  };
  /**
   * Models (I-198): one Glade-wide quick-tasks model, everything else per agent. Before I-198 these
   * were global (`defaultModel`, `defaultThinkingLevel`, `smallModel`, `subagentModel`,
   * `sideQuestionModel`, `subagentThinkingLevel`, `hiddenModels`); the server moves stored values to
   * the default agent's entry and `smallModel` to `quickTasks` (see `LegacyModelSettings`).
   */
  models: {
    /**
     * Quick tasks for every chat whatever its agent: chat titles, `/name`, chat summaries, search,
     * commit messages (I-074, I-097). `null` = automatic: the default agent, with Claude Haiku 4.5
     * when it lists it, else (titles) the chat's model / the agent's default.
     */
    quickTasks: QuickTasksModel | null;
    /**
     * Per agent, keyed by harness id (`pi`, `claude`, `codex`). A missing agent or field means the
     * default: read through {@link agentModelSettings}.
     */
    agents: Record<string, Partial<AgentModelSettings>>;
  };
  appearance: {
    theme: "system" | "light" | "dark";
    // `fontSize` (Text size) was removed in I-161: the app uses the default size.
  };
  /** Harness-independent agent settings. */
  agent: {
    // `maxIdleProcesses` was removed in I-159: the live pool keeps at most 5 idle agent processes.
    /**
     * Harness id new chats use (I-064). `null` (or an id that isn't installed) = the server's
     * default harness (`GLADE_HARNESS`, else pi).
     */
    defaultHarness: string | null;
    /**
     * Let agents start sub-agents (I-116): Glade's pi extension registers `spawn_agent`,
     * `message_agent`, `close_agent` and `list_agents` only when on, and the agent API refuses
     * spawns (403) when off. Applies to agent processes started afterwards (new chats, restarts).
     */
    subagents: boolean;
  };
  /**
   * Agents this device offers (I-155), keyed by harness id: `enabled: false` turns one off (it's
   * then not offered to new chats, sub-agents or other devices). Absent = on when installed.
   * I-201: `advanced` + `command` run the agent through a custom command (`agent-command.ts`).
   */
  agents: import("./agent-catalog.js").AgentSwitches;
  /**
   * Per-harness settings (I-066), keyed by harness id. pi's (`piPath`, `extraArgs`,
   * `autoCompaction`, `autoRetry`) were removed in I-159; pi starts with auto-compaction and
   * auto-retry on. Its command is `pi` on the PATH unless `agents.pi.advanced` + `command` say
   * otherwise (I-201).
   */
  harnesses: {
    /**
     * ACP agents the user added (I-119). Since I-159 they are kept here but hidden and never
     * offered (F-026 may bring them back); their old chats stay readable.
     */
    acp: import("./acp.js").AcpHarnessSettings;
  };
  /** Slash menu (I-048). */
  slashCommands: {
    /**
     * Commands hidden from the slash menu, as `<source>:<name>` keys (e.g. `builtin:compact`,
     * `extension:powerline`, `skill:skill:web-design`). Hidden commands still run when typed in
     * full. Unknown keys are ignored.
     */
    hidden: string[];
  };
  /** Saved prompts (I-098): global and per project, in their manual order. See `prompts.ts`. */
  prompts: import("./prompts.js").SavedPrompt[];
  /** Glade agents switched on/off, globally and per project (I-218, `agent-defs.ts`). */
  agentDefs: import("./agent-defs.js").AgentDefSwitches;
  /** Keeping the Mac awake (I-147, `power.ts`). Only the Mac app holds the assertion. */
  power: {
    /** "Keep this Mac awake while a chat is working" (General). */
    whileWorking: boolean;
    /** "Keep this device awake while it's shared" with a device connected, on AC power (Remote Access). */
    whileShared: boolean;
    /** Also on battery power (Remote Access). */
    whileSharedOnBattery: boolean;
  };
  /** Local model server on this Mac (I-196, `local-models.ts`). */
  localModels: {
    /** llama-server router's base URL. Also passed to pi as `LLAMA_BASE_URL`. */
    url: string;
  };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

export function defaultSettings(): Settings {
  return {
    general: {
      generateTitles: true,
      generateSummaries: true,
    },
    models: {
      quickTasks: null,
      agents: {},
    },
    appearance: {
      theme: "system",
    },
    agent: {
      defaultHarness: null,
      subagents: true,
    },
    agents: {},
    harnesses: {
      // No ACP agent by default: nothing is started until the user adds one (I-119).
      acp: { agents: [] },
    },
    slashCommands: {
      hidden: [],
    },
    prompts: [],
    agentDefs: { disabled: [], projects: {} },
    power: { whileWorking: true, whileShared: true, whileSharedOnBattery: false },
    localModels: { url: "http://127.0.0.1:8080" },
  };
}

// ---------------------------------------------------------------------------------------------
// REST payloads
// ---------------------------------------------------------------------------------------------

export interface CreateProjectRequest {
  /** The project's folder. Absent/null = a group project (I-213); `name` is then required (400). */
  path?: string | null;
  name?: string;
}

export interface UpdateProjectRequest {
  name?: string;
  // `folderId` was removed in I-202 (projects are always top level): 400 when sent.
}

/**
 * `PUT /api/projects/order`: the full list of project ids in their new order. Folder ids (sent by
 * clients from before I-202, when top-level folders shared this order) are ignored.
 */
export interface ReorderProjectsRequest {
  ids: string[];
}

/**
 * `PUT /api/workspaces/order` (I-202): the new order of one container of a chat list, i.e. the
 * top level of a project (`folderId` null) or of the standalone Chats section (`projectId` null),
 * or one folder. `ids` must list every unpinned chat now in that container and, at the top level,
 * every folder of the list (400 otherwise), in the new order; it may also list chats of the same
 * list from another container (pinned or not), which move into this one. Each listed item gets
 * `sortOrder` = its index; listed chats get `folderId` = `folderId`. Chats never leave their list
 * (another project's chat, or a project chat in the Chats section, is a 400); folders can't nest.
 */
export interface ReorderChatListRequest {
  projectId: string | null;
  folderId: string | null;
  ids: string[];
}

/** `PUT /api/workspaces/order` → the container's chats and folders after the change (in order). */
export interface ReorderChatListResponse {
  workspaces: WorkspaceSummary[];
  folders: Folder[];
}

/** `PUT /api/workspaces/pin-order`: the pinned workspaces of one list (a project, or standalone = null) in order. */
export interface ReorderPinnedWorkspacesRequest {
  projectId: string | null;
  ids: string[];
}

/** Apps a project folder can be opened in (`POST /api/projects/:id/open`). */
export type OpenTarget = "vscode";

export interface OpenProjectRequest {
  app: OpenTarget;
}

/** `POST /api/workspaces/:id/open`: open the chat's folder (`Workspace.cwd`, the worktree for worktree chats; I-106). */
export interface OpenWorkspaceRequest {
  app: OpenTarget;
}

/** `POST /api/workspaces`: a new workspace with its first main session. */
export interface CreateWorkspaceRequest {
  projectId: string | null;
  /** Optional first prompt; sent right after the session starts. */
  prompt?: string;
  images?: PromptImage[];
  model?: ModelRef | null;
  thinkingLevel?: ThinkingLevel | null;
  /**
   * Work in a new git worktree on its own branch (I-096; see `worktrees.ts`). Only for projects
   * whose folder is a git repository (400 otherwise, and for standalone chats).
   */
  worktree?: boolean;
  /** With `worktree`: the local branch it starts from (default: the project's current branch; I-105). */
  baseRef?: string;
  /** With `worktree`: the new branch's name (default `glade/<slug>`; 400 invalid, 409 exists; I-105). */
  branch?: string;
  /**
   * With `worktree`: bring the project folder's uncommitted changes (tracked changes and untracked,
   * non-ignored files) into the new worktree; the folder keeps its copy (I-117). Only when the
   * worktree starts from the folder's current branch (400 otherwise).
   */
  carryChanges?: boolean;
  /** Harness the chat runs in (`HarnessInfo.id`, I-119); default: the default harness. 400 if not installed. */
  harness?: string;
  /**
   * The permission mode the chat starts in (I-184; harnesses with the `permissionModes`
   * capability, one of `FolderPermissionModes.modes`' ids). Absent: the agent's own default.
   * Ignored by harnesses without modes; a mode the harness doesn't know falls back to its default.
   */
  permissionMode?: string | null;
  /**
   * The chat's folder (I-213): an absolute path to an existing directory inside the folder
   * browser's roots (home, `/Volumes`). Required when `projectId` is a group project (`path: null`),
   * 400 for any other project or a standalone chat, and 400 together with `worktree`. Becomes
   * `Workspace.cwd` for good; the chat's title defaults to the folder's name (`titleSource: "user"`).
   */
  folder?: string;
}

export interface UpdateWorkspaceRequest {
  title?: string;
  pinned?: boolean;
  /** Replace the saved layout (`null` clears it). */
  layout?: WorkspaceLayout | null;
  /**
   * Move into a folder (I-165): a Chats-section one for standalone chats, one of its project's
   * otherwise (it goes to the folder's top); `null` moves it out (right after the folder).
   */
  folderId?: string | null;
}

/** `POST /api/workspaces/:id/sessions`: a new main session (tab) in the workspace. */
export interface CreateSessionRequest {
  prompt?: string;
  images?: PromptImage[];
  model?: ModelRef | null;
  thinkingLevel?: ThinkingLevel | null;
  /** Harness the session runs in (I-119); default: the default harness. 400 if not installed. */
  harness?: string;
  /** See `CreateWorkspaceRequest.permissionMode` (I-184). */
  permissionMode?: string | null;
}

export interface UpdateSessionRequest {
  title?: string;
  unread?: boolean;
  /** Only `false` is accepted: dismiss the "interrupted" banner. */
  interrupted?: false;
}

/**
 * `POST /sessions/:id/title/generate` (I-074, `/name` without a title): the title the small model
 * gave the conversation, applied like a rename (`titleSource: "user"`; while the session is its
 * workspace's only main tab the workspace is renamed too).
 */
export interface GenerateTitleResponse {
  title: string;
  session: SessionSummary;
}

export interface PromptImage {
  mimeType: string;
  /** Base64 data (no data: prefix). */
  data: string;
  /**
   * Instead of `data` (I-157): an image already stored in the environment (`<sessionId>/<name>`,
   * I-163, or a legacy `sha256:<hex>`; e.g. one from the transcript), with `data` empty. The
   * server reads it back into `data` before handing it to the harness, so harnesses always get
   * real image data.
   */
  blob?: string;
}

export interface PromptRequest {
  text: string;
  images?: PromptImage[];
  /** While the agent is running: steer (default) or follow-up (⌘↩, I-153). */
  behavior?: "steer" | "followUp";
}

/** `POST /api/sessions/:id/shell` (I-076): run a command in the chat's folder. */
export interface ShellRequest {
  command: string;
  /** `!cmd` = true (the agent sees it with the next prompt), `!!cmd` = false. */
  shareWithAgent: boolean;
}

/** Answer to {@link ShellRequest}: sent once it started; output arrives as `shell_*` events. */
export interface ShellResponse {
  /** Id of the `ShellMessage` / `shell_*` events. */
  id: string;
}

/** A session with its live state (`GET /api/sessions/:id`; starts the agent if needed). */
export interface SessionDetail {
  session: SessionSummary;
  transcript: Transcript;
  state: SessionState;
  pendingUiRequests: import("./events.js").UiRequest[];
  /**
   * Shown from the session file: the agent isn't running in this server (another Glade server
   * holds it, or it's a closed sub-agent), so the state is partial (no context usage). Clients
   * load it again when the session changes (I-102).
   */
  offline?: boolean;
  /** The event log's seq this detail includes (I-122): subscribe to the session after it. */
  seq?: number;
}

/** `GET /api/sessions/:id/transcript?before=&turns=`: earlier turns of a transcript (I-122). */
export type TranscriptPageResponse = TranscriptPage;

/** `GET /api/workspaces/:id`: the workspace and all of its sessions (doesn't start agents). */
export interface WorkspaceDetail {
  workspace: WorkspaceSummary;
  /** Main sessions first (by `createdAt`), then sub-agents (by `createdAt`). */
  sessions: SessionSummary[];
}

/** `POST /api/workspaces`: the new workspace, its sessions, and the first session's live state. */
export interface CreateWorkspaceResponse extends WorkspaceDetail {
  session: SessionDetail;
}

export interface ApiError {
  error: string;
}

export type { UiResponse, ModelInfo };

// ---------------------------------------------------------------------------------------------
// WebSocket (server -> client push)
// ---------------------------------------------------------------------------------------------

/** The shell scope's snapshot (I-122): everything the sidebar and settings show. */
export interface ShellSnapshot {
  projects: Project[];
  workspaces: WorkspaceSummary[];
  sessions: SessionSummary[];
  settings: Settings;
  /** The server's environment (I-123; missing on older servers). */
  environment?: EnvironmentInfo;
  /** Folders in the chat list (I-165; missing on older servers). */
  folders?: Folder[];
  /** Bookmarked messages of every chat (I-203; missing on older servers). */
  bookmarks?: Bookmark[];
}

/**
 * Server -> client pushes. Protocol 2 clients (I-122, see `sync.ts`) subscribe to scopes and
 * receive them in `batch`es, tagged with `seq` / `prev`; older clients get every push untagged.
 */
export type ServerMessage = (
  | {
      type: "hello";
      version: string;
      /** WebSocket protocol version (2 = sequenced sync, I-122). */
      protocol?: number;
      /** The server's permanent environment id (I-123; missing on older servers). */
      environmentId?: string;
    }
  /** This environment's info changed (renamed, I-123). Shell scope, committed. */
  | { type: "environment"; environment: EnvironmentInfo }
  /** A live agent event of one session. */
  | { type: "session_event"; sessionId: string; workspaceId: string; event: AgentEvent }
  | { type: "session_upsert"; session: SessionSummary }
  | { type: "session_removed"; sessionId: string; workspaceId: string }
  /** Sent after every change to the workspace or any of its sessions (rolled-up status). */
  | { type: "workspace_upsert"; workspace: WorkspaceSummary }
  /** Its sessions are gone too (no separate `session_removed`s are sent). */
  | { type: "workspace_removed"; workspaceId: string }
  | { type: "project_upsert"; project: Project }
  | { type: "project_removed"; projectId: string }
  /** A folder in the chat list was created, renamed or reordered (I-165). */
  | { type: "folder_upsert"; folder: Folder }
  /** A folder was deleted; its members were moved out (their own upserts follow). */
  | { type: "folder_removed"; folderId: string }
  /** A message was bookmarked, or its bookmark renamed (I-203). */
  | { type: "bookmark_upsert"; bookmark: Bookmark }
  /** A bookmark was removed (also when its chat was deleted). */
  | { type: "bookmark_removed"; bookmarkId: string }
  | { type: "settings"; settings: Settings }
  | { type: "models"; models: ModelInfo[] }
  /**
   * Subscription usage limits. `entries` (I-191): one per offered agent that reports limits, the
   * default agent first; empty/absent = none (feature hidden). `usage` is the default agent's
   * (for older clients), `null` when it has none.
   */
  | { type: "usage_limits"; usage: UsageLimits | null; entries?: HarnessUsageLimits[] }
  /** An agent asked to show this chat (`open_chat`, I-091): windows navigate to it like a ⌘K pick. */
  | { type: "open_chat"; workspaceId: string; sessionId: string; sessionKind: "main" | "subagent" }
  /**
   * Pairings waiting for the host's Allow/Deny (I-126): the full current list after every change
   * (new, answered, expired), and once on connect when not empty. Local-owner sockets only; not
   * sequenced (sent as is, in either socket mode).
   */
  | { type: "pairing_pending"; pending: PendingPairing[] }
  /** Why the Mac is kept awake (I-147), after every change. Local-owner sockets only; not sequenced. */
  | { type: "power"; power: import("./power.js").PowerStatus }
  /** The local model server's state (I-196), after every change (load/unload progress, models found). Not sequenced. */
  | { type: "local_models"; state: import("./local-models.js").LocalModelsState }
  /** The Update Now job (I-154), after every change (throttled). Local-owner sockets only; not sequenced. */
  | { type: "update"; update: import("./version.js").UpdateJobStatus }
  /**
   * The version status (I-197), when it changes: a check finished, or a new build was installed
   * into this app's bundle (`installed`). Local-owner sockets only; not sequenced.
   */
  | { type: "version"; version: import("./version.js").VersionStatus }
  /** Agent versions and updates (I-198), after every change (throttled while an update runs). Local-owner sockets only; not sequenced. */
  | { type: "agent_versions"; status: import("./agent-versions.js").AgentVersionsStatus }
  // Sequenced sync (I-122) ---------------------------------------------------------------------
  /** Several pushes at once (sent every ~50 ms). */
  | { type: "batch"; messages: ServerMessage[] }
  | { type: "snapshot"; scope: "shell"; seq: number; shell: ShellSnapshot }
  | ({ type: "snapshot"; scope: "session"; sessionId: string; seq: number; page: TranscriptPage } & SessionLiveState)
  /** Caught up: live pushes follow. `check`: every id the server has (drop the others; missing ones mean resubscribe). */
  | { type: "live"; scope: "shell"; seq: number; check: { projects: string[]; workspaces: string[]; sessions: string[]; folders?: string[]; bookmarks?: string[] } }
  | ({ type: "live"; scope: "session"; sessionId: string; seq: number } & SessionLiveState)
  /** Changed messages / tool results of a session's transcript (replay, or written by another server). */
  | { type: "transcript_patch"; sessionId: string; messages: MessagePatch[]; toolResults: ToolResult[] }
  /** The transcript as streamed so far equals the event log at `seq` (the content came as `session_event`s). */
  | { type: "session_sync"; sessionId: string }
  | { type: "subscribe_error"; scope: "session"; sessionId: string; error: string }
  | { type: "ping"; t: number }
  | { type: "pong"; t: number }
) &
  SyncTag;

/**
 * Client -> server messages over the WebSocket. `viewing` lists every session currently on
 * screen (in a visible window), replacing the previous list; finished runs there aren't marked
 * unread. The rest is sequenced sync (I-122, `sync.ts`).
 */
export type ClientMessage = { type: "viewing"; sessionIds: string[] } | ClientSyncMessage;

/** Result of `POST /api/fs/pick-folder` (native folder dialog on the server's machine). */
export type PickFolderResponse = { path: string } | { cancelled: true };

// ---------------------------------------------------------------------------------------------
// Slash commands (I-016)
// ---------------------------------------------------------------------------------------------

/** `saved`: the user's saved prompts (I-098, web only; picking one inserts its text). */
export type SlashCommandSource = "builtin" | "extension" | "prompt" | "skill" | "saved";

export interface SlashCommand {
  /** Without the leading slash, e.g. "compact" or "skill:web-design". */
  name: string;
  description?: string;
  source: SlashCommandSource;
  /** Short usage hint for arguments, e.g. "[instructions]". */
  argsHint?: string;
}

export interface CompactResult {
  tokensBefore: number;
  /** Estimate; `null` if unknown. */
  tokensAfter: number | null;
}

// ---------------------------------------------------------------------------------------------
// Subscription usage limits (I-015)
// ---------------------------------------------------------------------------------------------

export interface UsageLimit {
  /** Stable id, e.g. "session", "weekly_all", "weekly_scoped:Fable". */
  id: string;
  /** Display label, e.g. "Current session", "This week", "Fable this week". */
  label: string;
  /** 0-100. */
  percent: number;
  /** ISO timestamp, or null if unknown. */
  resetsAt: string | null;
  severity: "normal" | "warning" | "critical";
  /** This is the limit currently constraining usage. */
  active: boolean;
  /**
   * Set when the limit only applies to one model family (a per-model scope), e.g. "Fable": the
   * model's display name/id fragment. The UI highlights it when the chat's model matches.
   */
  model?: string;
}

export interface UsageLimits {
  /** Which account/provider these limits belong to, e.g. "Claude subscription". */
  source: string;
  /**
   * Model provider these limits apply to (matches `ModelRef.provider`, e.g. "anthropic"). The
   * chat shows them only when its model belongs to this provider.
   */
  provider: string;
  limits: UsageLimit[];
  /** When the numbers were fetched (ms epoch). */
  fetchedAt: number;
  /** True when the last refresh failed/was skipped and these are older values. */
  stale: boolean;
}

/** One agent's usage limits (I-191): which harness reported them (when: `usage.fetchedAt`). */
export interface HarnessUsageLimits {
  harnessId: string;
  /** The harness's display name, e.g. "Codex". */
  label: string;
  usage: UsageLimits;
}
