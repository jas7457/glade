/**
 * Small pure text helpers for tool rendering (harness-neutral: they only see protocol types).
 */
import type { DiffLine, ToolEdit } from "@glade/protocol";

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

const EXT_LANG: Record<string, string> = {
  ts: "ts", tsx: "tsx", mts: "ts", cts: "ts", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
  json: "json", jsonc: "jsonc", md: "md", mdx: "mdx", css: "css", scss: "scss", html: "html",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php", sh: "bash", bash: "bash",
  zsh: "bash", fish: "fish", yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql", xml: "xml",
  svg: "xml", vue: "vue", svelte: "svelte", lua: "lua", dockerfile: "dockerfile", graphql: "graphql",
};

/** Shiki language id for a file path, or "" (plain text). */
export function languageFromPath(path: string | undefined): string {
  if (!path) return "";
  const name = path.split("/").pop()!.toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  const dot = name.lastIndexOf(".");
  if (dot === -1) return "";
  return EXT_LANG[name.slice(dot + 1)] ?? "";
}

/** Diff lines built from an edit call's normalized edits (before a result with a real diff exists). */
export function diffFromEdits(edits: readonly ToolEdit[]): DiffLine[] {
  const out: DiffLine[] = [];
  edits.forEach((e, i) => {
    if (i > 0) out.push({ type: "gap", text: "" });
    for (const line of e.oldText.split("\n")) out.push({ type: "del", text: line });
    for (const line of e.newText.split("\n")) out.push({ type: "add", text: line });
  });
  return out;
}

/** Count added/removed lines. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === "add") added++;
    else if (l.type === "del") removed++;
  }
  return { added, removed };
}
