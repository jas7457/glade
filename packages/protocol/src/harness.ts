/**
 * Harness descriptions for the web (I-065).
 */
/**
 * What a harness can do (I-065). The web hides controls for missing capabilities instead of
 * failing at runtime. `GET /api/harnesses` → `HarnessInfo[]` (the default harness first).
 */
export interface HarnessCapabilities {
  /** `/compact` and the context meter's compaction. */
  compact: boolean;
  /** `/export` (HTML export of the session). */
  exportHtml: boolean;
  /** Messages sent while running can steer or queue as a follow-up (busy behaviour setting). */
  steering: boolean;
  /** The agent can ask blocking questions (select/confirm/input dialogs). */
  uiRequests: boolean;
  /** Subscription usage limits (the usage gauge). */
  usageLimits: boolean;
  /** Harness slash commands (extensions, skills, prompt templates). */
  commands: boolean;
  /** Glade sub-agents (spawn_agent & co). */
  subagents: boolean;
  /** `!cmd` / `!!cmd` in the composer: run a shell command in the chat's folder (I-076). */
  shell: boolean;
  /**
   * Side questions (`/btw`, Ask Aside; I-140): a one-off answer over the chat's context, no tools,
   * without touching the running session. Absent = false.
   */
  sideQuestions?: boolean;
  /**
   * The model and thinking pickers apply to this harness (`GET /api/models` lists its models).
   * Absent = true. ACP agents (I-119) choose their own model, so the pickers are hidden.
   */
  models?: boolean;
  /**
   * Permission modes (I-174, Claude Code's Default / Accept edits / Plan …): the session state's
   * `permissionMode` / `permissionModes`, switched with `PUT /sessions/:id/permission-mode`.
   * Absent = false.
   */
  permissionModes?: boolean;
}

export interface HarnessInfo {
  /** Stable id persisted on sessions (e.g. "pi"). */
  id: string;
  /** Display name used in copy ("Ask pi to work on…"). */
  label: string;
  /** True for the harness new chats use. */
  isDefault: boolean;
  capabilities: HarnessCapabilities;
}
