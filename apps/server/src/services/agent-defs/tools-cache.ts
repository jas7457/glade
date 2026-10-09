/**
 * The tools each harness last showed (I-218), per harness + project, for the agent editor's tool
 * pickers: pi's registered tools (extensions, MCP), Claude Code's init `tools` / MCP servers.
 * Kept in memory and in `<dataDir>/agent-tools.json` (written atomically, debounced; merged with
 * what another server on the data folder wrote, newest entry wins), read once on first use.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentDefToolsResponse } from "@glade/protocol";

export const AGENT_TOOLS_FILE = "agent-tools.json";
const WRITE_DELAY_MS = 1_000;
const MAX_TOOLS = 1_000;

interface Entry {
  harness: string;
  projectId: string | null;
  tools: string[];
  mcpServers: string[];
  seenAt: number;
}

const keyOf = (harness: string, projectId: string | null) => `${harness}\u0000${projectId ?? ""}`;

export class ToolsCache {
  private entries: Map<string, Entry> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly path: string,
    private readonly log?: (msg: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  static inDataDir(dataDir: string, log?: (msg: string) => void): ToolsCache {
    return new ToolsCache(join(dataDir, AGENT_TOOLS_FILE), log);
  }

  record(harness: string, projectId: string | null, tools: string[], mcpServers: string[]): void {
    const clean = (list: string[]) => [...new Set(list.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()))].slice(0, MAX_TOOLS);
    const entry: Entry = { harness, projectId, tools: clean(tools), mcpServers: clean(mcpServers), seenAt: this.now() };
    const entries = this.load();
    const previous = entries.get(keyOf(harness, projectId));
    entries.set(keyOf(harness, projectId), entry);
    // Same lists as before: nothing new to write (sessions report on every start).
    if (previous && same(previous.tools, entry.tools) && same(previous.mcpServers, entry.mcpServers) && this.timer === null) return;
    this.schedule();
  }

  /** The latest for `harness` in `projectId`, else that harness's latest anywhere. */
  get(harness: string, projectId: string | null): AgentDefToolsResponse {
    const entries = this.load();
    let entry = entries.get(keyOf(harness, projectId));
    if (!entry) {
      for (const e of entries.values()) if (e.harness === harness && (!entry || e.seenAt > entry.seenAt)) entry = e;
    }
    return entry ? { harness, tools: entry.tools, mcpServers: entry.mcpServers, seenAt: entry.seenAt } : { harness, tools: [], mcpServers: [], seenAt: null };
  }

  /** Write now (also at shutdown and in tests). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.entries) return;
    try {
      // Another server may have recorded tools too: keep the newer of each.
      for (const e of readEntries(this.path)) {
        const mine = this.entries.get(keyOf(e.harness, e.projectId));
        if (!mine || mine.seenAt < e.seenAt) this.entries.set(keyOf(e.harness, e.projectId), e);
      }
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, entries: [...this.entries.values()] }, null, 2)}\n`);
      renameSync(tmp, this.path);
    } catch (err) {
      this.log?.(`agent-tools.json: ${(err as Error).message}`);
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), WRITE_DELAY_MS);
    this.timer.unref?.();
  }

  private load(): Map<string, Entry> {
    if (!this.entries) {
      this.entries = new Map();
      for (const e of readEntries(this.path)) this.entries.set(keyOf(e.harness, e.projectId), e);
    }
    return this.entries;
  }
}

function readEntries(path: string): Entry[] {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const list = (data as { entries?: unknown })?.entries;
  if (!Array.isArray(list)) return [];
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
  return list.flatMap((e: Record<string, unknown> | null) =>
    e && typeof e.harness === "string" && typeof e.seenAt === "number"
      ? [{ harness: e.harness, projectId: typeof e.projectId === "string" ? e.projectId : null, tools: strings(e.tools), mcpServers: strings(e.mcpServers), seenAt: e.seenAt }]
      : [],
  );
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
