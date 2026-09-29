/**
 * Codex's approvals in Glade (I-177). Pure.
 *
 * - **Permission modes** are Codex's own presets (its `/permissions` picker), an approval policy
 *   plus a sandbox: Read only (asks before edits, commands and network), Auto (edits and runs
 *   commands in the workspace, asks for anything outside it or for network) and Full access (no
 *   sandbox, never asks; red). A new chat starts in the preset matching Codex's `config.toml`
 *   (`approval_policy` / `sandbox_mode`), else Auto; the mode is sent with every turn.
 * - **The card** is Codex's approval prompt, in its words: "Yes, proceed"; "Yes, and don't ask
 *   again for …" (commands starting with the prefix Codex proposes, else this command / these
 *   files for the session); "No, and tell Codex what to do differently" (cancels the turn, the
 *   composer gets the focus).
 */
import type { PermissionModeInfo, PermissionOption } from "@glade/protocol";
import type {
  AskForApproval,
  CodexConfig,
  CommandExecutionApprovalDecision,
  CommandExecutionRequestApprovalParams,
  FileChangeApprovalDecision,
  SandboxMode,
  SandboxPolicy,
} from "./protocol.js";

export type CodexPermissionMode = "read-only" | "auto" | "full-access";

interface Preset {
  info: PermissionModeInfo;
  approvalPolicy: AskForApproval;
  sandbox: SandboxMode;
}

const PRESETS: Record<CodexPermissionMode, Preset> = {
  "read-only": {
    info: { id: "read-only", label: "Read only", description: "Reads files; asks before edits, commands and network access" },
    approvalPolicy: "on-request",
    sandbox: "read-only",
  },
  auto: {
    info: { id: "auto", label: "Auto", description: "Edits and runs commands in the workspace; asks for anything outside it or network access" },
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  },
  "full-access": {
    info: { id: "full-access", label: "Full access", description: "Edits and runs anything, with network access, without asking", danger: true },
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  },
};

export const CODEX_DEFAULT_MODE: CodexPermissionMode = "auto";

export function isCodexPermissionMode(mode: unknown): mode is CodexPermissionMode {
  return typeof mode === "string" && Object.hasOwn(PRESETS, mode);
}

/** The modes, in Shift+Tab order. */
export function codexPermissionModes(): PermissionModeInfo[] {
  return (["read-only", "auto", "full-access"] as const).map((id) => ({ ...PRESETS[id].info }));
}

export function codexPermissionModeLabel(mode: string): string {
  return isCodexPermissionMode(mode) ? PRESETS[mode].info.label : mode;
}

/** `thread/start` / `thread/resume` fields for a mode. */
export function threadPermissions(mode: CodexPermissionMode): { approvalPolicy: AskForApproval; sandbox: SandboxMode } {
  return { approvalPolicy: PRESETS[mode].approvalPolicy, sandbox: PRESETS[mode].sandbox };
}

/** `turn/start` fields for a mode (the sandbox as a policy). */
export function turnPermissions(mode: CodexPermissionMode): { approvalPolicy: AskForApproval; sandboxPolicy: SandboxPolicy } {
  return { approvalPolicy: PRESETS[mode].approvalPolicy, sandboxPolicy: sandboxPolicy(PRESETS[mode].sandbox) };
}

export function sandboxPolicy(mode: SandboxMode): SandboxPolicy {
  switch (mode) {
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "workspace-write":
      return { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
  }
}

/** The preset matching Codex's configured approval policy and sandbox (a new chat's mode). */
export function modeFromConfig(config: CodexConfig | null | undefined): CodexPermissionMode {
  const sandbox = config?.sandbox_mode;
  const approval = config?.approval_policy;
  if (sandbox === "danger-full-access" && approval === "never") return "full-access";
  if (sandbox === "read-only") return "read-only";
  return CODEX_DEFAULT_MODE;
}

// The card ------------------------------------------------------------------------------------------

export const APPROVE = "accept";
export const APPROVE_ALWAYS = "accept_always";
export const REJECT = "cancel";

const REJECT_OPTION: PermissionOption = { id: REJECT, label: "No, and tell Codex what to do differently", kind: "reject_once", focusComposer: true };

/** Shell words joined back into a command line (quoted when needed). */
export function shellJoin(words: readonly string[]): string {
  return words.map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/** A command approval: title, detail line and options. */
export function commandApproval(params: CommandExecutionRequestApprovalParams): { title: string; message?: string; options: PermissionOption[] } {
  const host = params.networkApprovalContext?.host;
  const title =
    params.kind === "writeStdin"
      ? "Would you like to send input to the running command?"
      : host
        ? `Would you like to allow network access to ${host}?`
        : "Would you like to run the following command?";
  const lines = [params.command ? `$ ${params.command}` : "", params.reason ? `Reason: ${params.reason}` : ""].filter(Boolean);
  const prefix = params.proposedExecpolicyAmendment?.length ? shellJoin(params.proposedExecpolicyAmendment) : null;
  const always = prefix ? `Yes, and don't ask again for commands that start with \`${prefix}\`` : "Yes, and don't ask again for this command";
  return {
    title,
    ...(lines.length ? { message: lines.join("\n") } : {}),
    options: [
      { id: APPROVE, label: "Yes, proceed", kind: "allow_once" },
      ...(params.kind === "writeStdin" ? [] : [{ id: APPROVE_ALWAYS, label: always, kind: "allow_always" as const }]),
      REJECT_OPTION,
    ],
  };
}

export function commandDecision(value: string | null, params: CommandExecutionRequestApprovalParams): CommandExecutionApprovalDecision {
  if (value === APPROVE) return "accept";
  if (value === APPROVE_ALWAYS) {
    const amendment = params.proposedExecpolicyAmendment;
    return amendment?.length ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: [...amendment] } } : "acceptForSession";
  }
  return "cancel";
}

/** A file change approval: title, the files, options. */
export function fileChangeApproval(paths: readonly string[], reason?: string | null): { title: string; message?: string; options: PermissionOption[] } {
  const lines = [...paths, reason ? `Reason: ${reason}` : ""].filter(Boolean);
  return {
    title: "Would you like to make the following edits?",
    ...(lines.length ? { message: lines.join("\n") } : {}),
    options: [
      { id: APPROVE, label: "Yes, proceed", kind: "allow_once" },
      { id: APPROVE_ALWAYS, label: "Yes, and don't ask again for these files", kind: "allow_always" },
      REJECT_OPTION,
    ],
  };
}

export function fileChangeDecision(value: string | null): FileChangeApprovalDecision {
  if (value === APPROVE) return "accept";
  if (value === APPROVE_ALWAYS) return "acceptForSession";
  return "cancel";
}
