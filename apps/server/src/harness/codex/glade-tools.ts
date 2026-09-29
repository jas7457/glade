/**
 * Glade's own sub-agent and chat tools for Codex (I-037, I-116, I-177): the same tools pi and
 * Claude Code get (`../claude/glade-tools.ts`: same specs, agent-API client and result texts),
 * offered to a thread as Codex *dynamic tools* (`thread/start`'s `dynamicTools`, experimental
 * API). Codex calls them back with `item/tool/call`; they run inside the Glade server with the
 * session's agent-API identity, which never reaches the Codex process.
 */
import { gladeToolSpecs, type GladeToolsOptions } from "../claude/glade-tools.js";
import type { CodexGladeTool } from "./codex-session.js";
import type { JsonValue } from "./protocol.js";

export function codexGladeTools(options: GladeToolsOptions): CodexGladeTool[] {
  return gladeToolSpecs(options).map((tool) => ({
    // A plain JSON copy of the schema (TypeBox objects carry symbols).
    spec: { type: "function", name: tool.name, description: tool.description, inputSchema: JSON.parse(JSON.stringify(tool.parameters)) as JsonValue },
    async run(args) {
      const result = await tool.handler(args);
      return { text: result.content.map((c) => c.text).join("\n"), ...(result.isError ? { isError: true } : {}) };
    },
  }));
}
