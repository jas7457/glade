/**
 * Which changed files this chat's agents edited (I-097's subtle marker): the paths of `edit` /
 * `write` tool calls in the workspace's loaded transcripts, as repository-relative paths. A hint
 * only; transcripts that aren't loaded (closed sub-agents, other tabs never opened) don't count.
 */
import type { Transcript } from "@glade/protocol";
import { homeOf, resolvePath } from "@/lib/paths";

/** Normalize `a/./b/../c` → `a/c`; `null` when it climbs above its start. */
function normalize(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/**
 * Repository-relative paths edited in `transcripts`. Tool paths are absolute, `~`-based or relative
 * to the workspace folder `cwd` (the worktree for worktree chats); `root` is the repository root
 * and `prefix` the folder inside it. Resolved like the tool rows show them (I-158).
 */
export function agentEditedPaths(transcripts: readonly Transcript[], cwd: string, root: string, prefix: string): Set<string> {
  const out = new Set<string>();
  const home = homeOf(cwd);
  const strip = (abs: string, base: string) => (base && abs.startsWith(`${base.replace(/\/$/, "")}/`) ? abs.slice(base.replace(/\/$/, "").length + 1) : null);
  for (const transcript of transcripts) {
    for (const message of transcript.messages) {
      if (message.role !== "assistant") continue;
      for (const block of message.content) {
        if (block.type !== "toolCall" || (block.kind !== "edit" && block.kind !== "write")) continue;
        const path = block.input?.path;
        if (!path) continue;
        const abs = resolvePath(path, cwd, home);
        let rel: string | null;
        if (abs.startsWith("/")) {
          const fromRoot = strip(abs, root);
          const fromCwd = strip(abs, cwd);
          rel = fromRoot !== null ? normalize(fromRoot) : fromCwd !== null ? normalize(prefix + fromCwd) : null;
        } else rel = normalize(prefix + path.replace(/^@/, ""));
        if (rel) out.add(rel);
      }
    }
  }
  return out;
}
