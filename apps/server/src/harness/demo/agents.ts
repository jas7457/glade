/**
 * The three agents the demo shows (I-209): pi, Claude Code and Codex, as demo harnesses with the
 * real harnesses' ids, labels and capabilities, and believable model lists, permission modes,
 * slash commands and usage limits. Only registered in demo sandboxes (`GLADE_HARNESS=demo`, see
 * `config.ts`); nothing here runs a real agent.
 */
import type { HarnessCapabilities, ModelInfo, PermissionModeInfo, SlashCommand, ThinkingLevel, UsageLimits } from "@glade/protocol";

export interface DemoAgent {
  id: "pi" | "claude" | "codex";
  label: string;
  capabilities: HarnessCapabilities;
  models: ModelInfo[];
  /** The agent's own default model (index into `models`). */
  defaultModel: number;
  defaultThinking: ThinkingLevel;
  permissionModes: PermissionModeInfo[];
  defaultPermissionMode: string | null;
  commands: SlashCommand[];
  /** Installed / newest version (Settings → Agents). */
  version: string;
  usage: (now: number) => UsageLimits;
  /** Tool names in this agent's own vocabulary. */
  tools: { read: string; edit: string; write: string; shell: string; search: string; list: string };
}

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const IMAGES = { maxWidth: 8000, maxHeight: 8000, maxBytes: 5 * 1024 * 1024, jpegQuality: 85 };
const CLAUDE_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];
const GPT_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];

const BASE: HarnessCapabilities = {
  compact: true,
  exportHtml: false,
  steering: true,
  uiRequests: true,
  usageLimits: true,
  commands: true,
  subagents: true,
  shell: false,
  sideQuestions: true,
  quickTasks: true,
};

/** A local model served by llama.cpp (Settings → Local Models loads it in the demo). */
export const DEMO_LOCAL_MODEL = "Qwen3.8-14B-Q5_K_M";

export const DEMO_AGENTS: Record<DemoAgent["id"], DemoAgent> = {
  pi: {
    id: "pi",
    label: "pi",
    capabilities: { ...BASE },
    models: [
      { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", thinkingLevels: CLAUDE_LEVELS, input: ["text", "image"], contextWindow: 400_000, imageLimits: IMAGES },
      { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", thinkingLevels: CLAUDE_LEVELS, input: ["text", "image"], contextWindow: 400_000, imageLimits: IMAGES },
      { provider: "anthropic", id: "claude-haiku-5", name: "Claude Haiku 5", thinkingLevels: ["off", "low", "medium", "high"], input: ["text", "image"], contextWindow: 200_000, imageLimits: IMAGES },
      { provider: "openai", id: "gpt-6-sol", name: "GPT-6-Sol", thinkingLevels: GPT_LEVELS, input: ["text", "image"], contextWindow: 400_000, imageLimits: IMAGES },
      { provider: "google", id: "gemini-3.5-pro", name: "Gemini 3.5 Pro", thinkingLevels: ["low", "medium", "high"], input: ["text", "image"], contextWindow: 400_000, imageLimits: IMAGES },
      { provider: "llama.cpp", id: DEMO_LOCAL_MODEL, name: DEMO_LOCAL_MODEL, thinkingLevels: ["off", "low", "medium", "high"], input: ["text"], contextWindow: 32_768 },
    ],
    defaultModel: 0,
    defaultThinking: "high",
    permissionModes: [],
    defaultPermissionMode: null,
    commands: [
      { name: "skill:release-notes", description: "Draft release notes from the commits since the last tag", source: "skill" },
      { name: "skill:frontend-design", description: "Design and build polished, accessible UI", source: "skill" },
      { name: "review", description: "Review the uncommitted changes like a senior engineer", source: "prompt" },
      { name: "explain", description: "Explain a file or function in plain words", source: "prompt" },
      { name: "agents", description: "List and manage the sub-agents of this chat", source: "extension" },
    ],
    version: "0.82.1",
    usage: (now) => ({
      source: "Claude subscription",
      provider: "anthropic",
      fetchedAt: now,
      stale: false,
      limits: [
        { id: "session", label: "Current session", percent: 34, resetsAt: iso(now + 2.6 * HOUR), severity: "normal", active: true },
        { id: "weekly", label: "This week", percent: 41, resetsAt: iso(now + 75 * HOUR), severity: "normal", active: false },
      ],
    }),
    tools: { read: "read", edit: "edit", write: "write", shell: "bash", search: "grep", list: "ls" },
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    capabilities: { ...BASE, models: true, permissionModes: true },
    models: [
      { provider: "anthropic", id: "default", name: "Default (recommended)", description: "Claude Opus 5.5 for complex work", group: "Claude Code", thinkingLevels: CLAUDE_LEVELS, input: ["text", "image"], contextWindow: 400_000, imageLimits: IMAGES },
      { provider: "anthropic", id: "opus", name: "Claude Opus 5.5", description: "Most capable for complex work", group: "Claude Code", thinkingLevels: CLAUDE_LEVELS, input: ["text", "image"], contextWindow: 400_000, imageLimits: IMAGES },
      { provider: "anthropic", id: "sonnet", name: "Claude Sonnet 5.5", description: "Best for everyday tasks", group: "Claude Code", thinkingLevels: CLAUDE_LEVELS, input: ["text", "image"], contextWindow: 400_000, imageLimits: IMAGES },
      { provider: "anthropic", id: "haiku", name: "Claude Haiku 5", description: "Fastest for quick answers", group: "Claude Code", thinkingLevels: ["off", "low", "medium", "high"], input: ["text", "image"], contextWindow: 200_000, imageLimits: IMAGES },
    ],
    defaultModel: 2,
    defaultThinking: "medium",
    permissionModes: [
      { id: "default", label: "Default", description: "Asks before edits and commands" },
      { id: "acceptEdits", label: "Accept edits", description: "Edits files without asking" },
      { id: "plan", label: "Plan mode", description: "Researches and plans without making changes" },
      { id: "auto", label: "Auto mode", description: "A reviewer model approves routine actions" },
      { id: "bypassPermissions", label: "Bypass permissions", description: "Runs everything without asking", danger: true },
    ],
    defaultPermissionMode: "acceptEdits",
    commands: [
      { name: "review", description: "Review a pull request", source: "extension" },
      { name: "security-review", description: "Complete a security review of the pending changes", source: "extension" },
      { name: "init", description: "Initialize a new CLAUDE.md file with codebase documentation", source: "extension" },
      { name: "pr-comments", description: "Get comments from a GitHub pull request", source: "extension" },
    ],
    version: "2.4.12",
    usage: (now) => ({
      source: "Claude subscription",
      provider: "anthropic",
      fetchedAt: now,
      stale: false,
      limits: [
        { id: "session", label: "Current session", percent: 34, resetsAt: iso(now + 2.6 * HOUR), severity: "normal", active: true },
        { id: "weekly", label: "This week", percent: 41, resetsAt: iso(now + 75 * HOUR), severity: "normal", active: false },
      ],
    }),
    tools: { read: "Read", edit: "Edit", write: "Write", shell: "Bash", search: "Grep", list: "Glob" },
  },
  codex: {
    id: "codex",
    label: "Codex",
    capabilities: { ...BASE, sideQuestions: false, quickTasks: false, models: true, permissionModes: true },
    models: [
      { provider: "codex", id: "gpt-6-sol", name: "GPT-6-Sol", description: "Frontier agentic coding model", thinkingLevels: GPT_LEVELS, input: ["text", "image"], contextWindow: 400_000, imageLimits: IMAGES },
      { provider: "codex", id: "gpt-6-sol-mini", name: "GPT-6-Sol mini", description: "Faster and cheaper for simple tasks", thinkingLevels: GPT_LEVELS, input: ["text", "image"], contextWindow: 400_000, imageLimits: IMAGES },
      { provider: "codex", id: "gpt-6-codex", name: "GPT-6-Codex", description: "Tuned for long-running coding tasks", thinkingLevels: GPT_LEVELS, input: ["text", "image"], contextWindow: 400_000, imageLimits: IMAGES },
    ],
    defaultModel: 0,
    defaultThinking: "medium",
    permissionModes: [
      { id: "read-only", label: "Read only", description: "Reads files; asks before edits, commands and network access" },
      { id: "auto", label: "Auto", description: "Edits and runs commands in the workspace; asks for anything outside it or network access" },
      { id: "full-access", label: "Full access", description: "Edits and runs anything, with network access, without asking", danger: true },
    ],
    defaultPermissionMode: "auto",
    commands: [
      { name: "review", description: "Review the current changes and find issues", source: "extension" },
      { name: "changelog", description: "Write a changelog entry for the staged changes", source: "skill" },
    ],
    version: "0.171.0",
    usage: (now) => ({
      source: "ChatGPT Pro",
      provider: "codex",
      fetchedAt: now,
      stale: false,
      limits: [
        { id: "primary", label: "5-hour limit", percent: 18, resetsAt: iso(now + 3.4 * HOUR), severity: "normal", active: true },
        { id: "secondary", label: "Weekly limit", percent: 27, resetsAt: iso(now + 101 * HOUR), severity: "normal", active: false },
      ],
    }),
    tools: { read: "shell", edit: "apply_patch", write: "apply_patch", shell: "shell", search: "shell", list: "shell" },
  },
};
