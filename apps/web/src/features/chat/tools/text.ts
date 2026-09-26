/**
 * Small pure text helpers for tool rendering.
 */

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

export type DiffLine = { kind: "add" | "del" | "ctx" | "gap"; text: string; oldNo?: number; newNo?: number };

/**
 * Parse pi's edit diff (`details.diff`): lines are `+NN text`, `-NN text`, ` NN text` or
 * ` <pad> ...` for skipped context.
 */
export function parsePiDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const raw of diff.split("\n")) {
    if (raw === "") continue;
    const sign = raw[0];
    const rest = raw.slice(1);
    const m = /^(\s*)(\d*) ?(.*)$/.exec(rest);
    if (!m) continue;
    const [, , num, text = ""] = m;
    if (!num && text.trim() === "...") {
      out.push({ kind: "gap", text: "" });
      continue;
    }
    const n = num ? Number(num) : undefined;
    if (sign === "+") out.push({ kind: "add", text, newNo: n });
    else if (sign === "-") out.push({ kind: "del", text, oldNo: n });
    else out.push({ kind: "ctx", text, oldNo: n });
  }
  return out;
}

/** Diff lines built from edit args alone (before a result with a real diff exists). */
export function diffFromEdits(edits: Array<{ oldText: string; newText: string }>): DiffLine[] {
  const out: DiffLine[] = [];
  edits.forEach((e, i) => {
    if (i > 0) out.push({ kind: "gap", text: "" });
    for (const line of e.oldText.split("\n")) out.push({ kind: "del", text: line });
    for (const line of e.newText.split("\n")) out.push({ kind: "add", text: line });
  });
  return out;
}

/** Normalize pi edit args: `{edits:[...]}`, `{oldText,newText}` or edits as a JSON string. */
export function editsFromArgs(args: Record<string, unknown> | undefined): Array<{ oldText: string; newText: string }> {
  if (!args) return [];
  const isEdit = (v: unknown): v is { oldText: string; newText: string } =>
    !!v && typeof v === "object" && typeof (v as { oldText?: unknown }).oldText === "string" && typeof (v as { newText?: unknown }).newText === "string";
  let edits: unknown = args.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      edits = undefined;
    }
  }
  if (Array.isArray(edits)) return edits.filter(isEdit);
  if (isEdit(edits)) return [edits];
  if (isEdit(args)) return [{ oldText: args.oldText, newText: args.newText }];
  return [];
}

/** Count added/removed lines. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "add") added++;
    else if (l.kind === "del") removed++;
  }
  return { added, removed };
}
