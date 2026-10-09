/**
 * I-218: AgentDefsService against temp home / project / data folders: discovery of Claude Code,
 * Codex and pi agents, `extends`, one agent per name and customizations (I-220), switches, availability, saving, and
 * the tools cache.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyAgentDefFields, type AgentDef, type AgentDefSwitches } from "@glade/protocol";
import { AgentDefsService, type AgentDefsListContext } from "../src/services/agent-defs/service.js";
import { HttpError } from "../src/services/app/errors.js";

let root: string;
let home: string;
let cwd: string;
let dataDir: string;
let service: AgentDefsService;

const ALL: AgentDefsListContext = { switches: { disabled: [], projects: {} }, offeredHarnesses: ["pi", "claude", "codex"] };
const scope = () => ({ projectId: "p1", cwd });

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "glade-agent-defs-"));
  home = join(root, "home");
  cwd = join(root, "repo");
  dataDir = join(root, "data");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  service = new AgentDefsService({ dataDir, homeDir: home, env: {} });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const byId = (defs: AgentDef[], id: string) => {
  const def = defs.find((d) => d.id === id);
  if (!def) throw new Error(`${id} not listed: ${defs.map((d) => d.id).join(", ")}`);
  return def;
};

function claudeReviewer(dir: string, extra = ""): void {
  write(
    join(dir, ".claude", "agents", "code-reviewer.md"),
    [
      "---",
      "name: code-reviewer",
      "description: Reviews diffs. Use after edits.",
      "tools: Read, Grep, Glob",
      "model: sonnet",
      "effort: high",
      "color: pink",
      "permissionMode: plan",
      "maxTurns: 8",
      "hooks:",
      "  PreToolUse:",
      "    - matcher: Bash",
      extra,
      "---",
      "You review code.",
    ].join("\n"),
  );
}

describe("discovery", () => {
  it("lists Claude Code agents with Glade's fields and native settings", async () => {
    claudeReviewer(home);
    write(join(home, ".claude", "agents", "fixer.md"), "---\nname: fixer\ndescription: Fixes\nmodel: inherit\ncolor: blue\n---\nFix it.");
    const defs = await service.list(scope(), ALL);
    const reviewer = byId(defs, "claude:code-reviewer");
    expect(reviewer).toMatchObject({ source: "claude", path: "~/.claude/agents/code-reviewer.md", editable: false, enabled: true, available: true, problems: [], customizes: null, customizedBy: null });
    expect(reviewer.fields).toMatchObject({ harness: "claude", model: "anthropic/sonnet", thinking: "high", tools: ["Read", "Grep", "Glob"], permissionMode: "plan", color: "pink", prompt: "You review code." });
    expect(reviewer.effective).toEqual(reviewer.fields);
    const resolved = await service.resolve("code-reviewer", scope(), ALL);
    expect(resolved.native).toEqual({ claude: { maxTurns: 8, hooks: { PreToolUse: [{ matcher: "Bash" }] } } });
    // Claude's colours only map when Glade has the same name.
    expect(byId(defs, "claude:fixer").fields).toMatchObject({ color: null, model: "inherit" });
  });

  it("prefers the project's Claude agent over the personal one (one entry per source)", async () => {
    claudeReviewer(home);
    write(join(cwd, ".claude", "agents", "code-reviewer.md"), "---\nname: code-reviewer\ndescription: Project version\n---\nProject prompt.");
    const defs = await service.list(scope(), ALL);
    expect(defs.filter((d) => d.id === "claude:code-reviewer")).toHaveLength(1);
    expect(byId(defs, "claude:code-reviewer").fields.description).toBe("Project version");
    // Without a folder, only personal locations.
    const personal = await service.list({ projectId: null, cwd: null }, ALL);
    expect(byId(personal, "claude:code-reviewer").fields.description).toBe("Reviews diffs. Use after edits.");
  });

  it("lists Codex agents from TOML", async () => {
    write(
      join(home, ".codex", "agents", "reviewer.toml"),
      [
        'name = "reviewer"',
        'description = "Strict reviewer"',
        'developer_instructions = """',
        "Review strictly.",
        '"""',
        'model = "gpt-6"',
        'model_reasoning_effort = "none"',
        'sandbox_mode = "read-only"',
        'nickname_candidates = ["Rex", "Ria"]',
        "[mcp_servers.docs]",
        'command = "docs"',
      ].join("\n"),
    );
    write(join(cwd, ".codex", "agents", "broken.toml"), 'name = "broken');
    const defs = await service.list(scope(), ALL);
    const reviewer = byId(defs, "codex:reviewer");
    expect(reviewer.fields).toMatchObject({ harness: "codex", model: "codex/gpt-6", thinking: "off", sandbox: "read-only", nicknames: ["Rex", "Ria"], prompt: "Review strictly." });
    expect((await service.resolve("reviewer", scope(), ALL)).native).toEqual({ codex: { mcp_servers: { docs: { command: "docs" } } } });
    const broken = byId(defs, "codex:broken");
    expect(broken.available).toBe(false);
    expect(broken.problems[0]).toMatch(/can't read the file/);
  });

  it("lists pi agents: project, personal and packages (project wins)", async () => {
    const pkg = join(root, "kit");
    write(join(pkg, "agents", "worker.md"), "---\nname: worker\ndescription: Package worker\n---\nWork.");
    write(join(pkg, "agents", "scout.md"), "---\nname: scout\ndescription: Package scout\n---\nScout.");
    write(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: [pkg, "npm:missing"] }));
    write(join(home, ".pi", "agent", "agents", "scout.md"), "---\nname: scout\ndescription: Personal scout\nmodel: anthropic/claude-haiku-4-5\nthinking: low\ntools: read, bash\nrequires: npm:x\n---\nLook.");
    write(join(cwd, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: Project worker\n---\nWork here.");
    const defs = await service.list(scope(), ALL);
    expect(byId(defs, "pi:scout").fields).toMatchObject({ description: "Personal scout", harness: "pi", model: "anthropic/claude-haiku-4-5", thinking: "low", tools: ["read", "bash"] });
    expect(byId(defs, "pi:worker").fields.description).toBe("Project worker");
    expect((await service.resolve("scout", scope(), ALL)).native).toEqual({ pi: { requires: "npm:x" } });
  });
});

describe("the tools' folder variables", () => {
  it("reads personal agents from CLAUDE_CONFIG_DIR, CODEX_HOME and PI_CODING_AGENT_DIR", async () => {
    const claudeDir = join(root, "claude-config");
    write(join(claudeDir, "agents", "c.md"), "---\nname: c\n---\nFrom CLAUDE_CONFIG_DIR.");
    write(join(home, "codex-home", "agents", "x.toml"), 'name = "x"\ndeveloper_instructions = "From CODEX_HOME."');
    const piDir = join(root, "pi-agent");
    const pkg = join(root, "pkg");
    write(join(piDir, "agents", "p.md"), "---\nname: p\n---\nFrom PI_CODING_AGENT_DIR.");
    write(join(piDir, "settings.json"), JSON.stringify({ packages: [pkg] }));
    write(join(pkg, "agents", "q.md"), "---\nname: q\n---\nFrom a package.");
    // The default folders are ignored when a variable is set.
    write(join(home, ".claude", "agents", "old-claude.md"), "---\nname: old-claude\n---\n");
    write(join(home, ".codex", "agents", "old-codex.toml"), 'name = "old-codex"');
    write(join(home, ".pi", "agent", "agents", "old-pi.md"), "---\nname: old-pi\n---\n");
    const env = { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: "~/codex-home", PI_CODING_AGENT_DIR: piDir };
    const withEnv = new AgentDefsService({ dataDir, homeDir: home, env });
    const defs = await withEnv.list({ projectId: null, cwd: null }, ALL);
    expect(defs.map((d) => [d.id, d.effective.prompt])).toEqual([
      ["claude:c", "From CLAUDE_CONFIG_DIR."],
      ["codex:x", "From CODEX_HOME."],
      ["pi:p", "From PI_CODING_AGENT_DIR."],
      ["pi:q", "From a package."],
    ]);
    // `extends: claude:c` looks there too.
    write(join(dataDir, "agents", "e.md"), "---\nname: e\nextends: claude:c\n---\n");
    expect((await withEnv.resolve("e", { projectId: null, cwd: null }, ALL)).def.effective.prompt).toBe("From CLAUDE_CONFIG_DIR.");
    // Without the variables: the default folders.
    const defaults = await new AgentDefsService({ dataDir, homeDir: home, env: { CODEX_HOME: " " } }).list({ projectId: null, cwd: null }, ALL);
    expect(defaults.map((d) => d.id)).toEqual(["personal:e", "claude:old-claude", "codex:old-codex", "pi:old-pi"]);
  });
});

describe("one agent per name, switches and availability", () => {
  beforeEach(() => {
    write(join(dataDir, "agents", "code-reviewer.md"), "---\nname: code-reviewer\nharness: pi\n---\nPersonal Glade.");
  });

  it("agents with one name are all unavailable until resolved (no silent winner), with a problem each", async () => {
    claudeReviewer(home);
    write(join(home, ".pi", "agent", "agents", "code-reviewer.md"), "---\nname: code-reviewer\n---\npi version");
    write(join(home, ".codex", "agents", "code-reviewer.toml"), 'name = "code-reviewer"\ndeveloper_instructions = "codex version"');
    write(join(cwd, ".agents", "agents", "code-reviewer.md"), "---\nname: code-reviewer\nharness: pi\n---\nProject Glade.");
    const defs = await service.list(scope(), ALL);
    const same = defs.filter((d) => d.fields.name === "code-reviewer");
    expect(same.map((d) => d.id)).toEqual(["project:code-reviewer", "personal:code-reviewer", "claude:code-reviewer", "codex:code-reviewer", "pi:code-reviewer"]);
    for (const d of same) {
      expect(d.available, d.id).toBe(false);
      expect(d.problems, d.id).toContain("5 agents are named code-reviewer; rename all but one");
    }
    await expect(service.resolve("code-reviewer", scope(), ALL)).rejects.toThrow(/can't run: 5 agents are named code-reviewer/);
    await expect(service.resolve("claude:code-reviewer", scope(), ALL)).rejects.toThrow(/can't run/);
  });

  it("two agents named alike: 'Two agents are named scout; rename one' on both, usable again once one goes", async () => {
    write(join(dataDir, "agents", "scout.md"), "---\nname: scout\nharness: pi\n---\nGlade scout.");
    write(join(home, ".claude", "agents", "scout.md"), "---\nname: scout\n---\nClaude scout.");
    const defs = await service.list({ projectId: null, cwd: null }, ALL);
    for (const id of ["personal:scout", "claude:scout"]) expect(byId(defs, id)).toMatchObject({ available: false, problems: ["Two agents are named scout; rename one"] });
    rmSync(join(home, ".claude", "agents", "scout.md"));
    expect(byId(await service.list({ projectId: null, cwd: null }, ALL), "personal:scout")).toMatchObject({ available: true, problems: [] });
  });

  it("honours the switches: global off, project override", async () => {
    write(join(dataDir, "agents", "scout.md"), "---\nname: scout\n---\nScout.");
    const switches: AgentDefSwitches = { disabled: ["scout"], projects: { p1: { scout: true, "code-reviewer": false } } };
    const ctx = { ...ALL, switches };
    const inProject = await service.list(scope(), ctx);
    expect(byId(inProject, "personal:scout").enabled).toBe(true);
    expect(byId(inProject, "personal:code-reviewer").enabled).toBe(false);
    const elsewhere = await service.list({ projectId: "p2", cwd }, ctx);
    expect(byId(elsewhere, "personal:scout").enabled).toBe(false);
    await expect(service.resolve("code-reviewer", scope(), ctx)).rejects.toThrow(/turned off here\. Available agents: scout\./);
    await expect(service.resolve("scout", { projectId: null, cwd: null }, ctx)).rejects.toThrow(/turned off/);
  });

  it("explains unknown names and unavailable harnesses (HttpError 400)", async () => {
    const err = await service.resolve("nope", scope(), ALL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).message).toBe('Unknown agent "nope". Available agents: code-reviewer.');
    write(join(home, ".codex", "agents", "lint.toml"), 'name = "lint"\ndeveloper_instructions = "x"');
    const piOff = { ...ALL, offeredHarnesses: ["claude"] };
    const defs = await service.list(scope(), piOff);
    expect(byId(defs, "personal:code-reviewer")).toMatchObject({ available: false, problems: ["pi is turned off or not installed"] });
    expect(byId(defs, "codex:lint")).toMatchObject({ available: false, problems: ["Codex is turned off or not installed"] });
    await expect(service.resolve("code-reviewer", scope(), piOff)).rejects.toThrow(/can't run: pi is turned off or not installed\. No agents are available here\./);
  });

  it("flags invalid fields and fields that don't apply on the harness", async () => {
    write(join(dataDir, "agents", "a.md"), "---\nname: a\nmodel: anthropic/haiku\n---\n");
    write(join(dataDir, "agents", "b.md"), "---\nname: b\nharness: codex\ntools: read\npermissionMode: plan\nicon: nope\n---\n");
    write(join(dataDir, "agents", "c.md"), "---\nname: c\nharness: claude\nmodel: codex/gpt-6\n---\n");
    const defs = await service.list(scope(), ALL);
    expect(byId(defs, "personal:a")).toMatchObject({ available: false, problems: ['model "anthropic/haiku" needs a harness (harness: inherit)'] });
    expect(byId(defs, "personal:b")).toMatchObject({
      available: true,
      problems: ['unknown icon "nope"', "tools aren't used on Codex", "permissionMode only applies on Claude Code"],
    });
    expect(byId(defs, "personal:c")).toMatchObject({ available: false, problems: [`model "codex/gpt-6" isn't a Claude Code model`] });
  });
});

describe("extends", () => {
  beforeEach(() => claudeReviewer(home));

  it("overrides set fields, appends the body, takes the source's harness/model/thinking for inherit", async () => {
    write(join(dataDir, "agents", "brandon.md"), "---\nname: brandon\nextends: claude:code-reviewer\nnickname: Brandon\nicon: shield\ntools: []\n---\nAlso check tests.");
    const def = byId(await service.list(scope(), ALL), "personal:brandon");
    expect(def.available).toBe(true);
    expect(def.effective).toMatchObject({
      name: "brandon",
      description: "Reviews diffs. Use after edits.",
      harness: "claude",
      model: "anthropic/sonnet",
      thinking: "high",
      tools: ["Read", "Grep", "Glob"],
      permissionMode: "plan",
      nicknames: ["Brandon"],
      color: null,
      icon: "shield",
      prompt: "You review code.\n\nAlso check tests.",
    });
    expect(def.fields.harness).toBe("inherit");
    // `base`: the source alone, without this file's overrides (the editor's greyed values).
    expect(def.base).toMatchObject({ name: "code-reviewer", harness: "claude", nicknames: [], icon: null, prompt: "You review code." });
    expect(def.base).toEqual(byId(await service.list(scope(), ALL), "claude:code-reviewer").effective);
    const resolved = await service.resolve("brandon", scope(), ALL);
    expect(resolved.native.claude).toMatchObject({ maxTurns: 8 });
  });

  it("concrete values win; switching harness drops the source's harness-specific settings with warnings", async () => {
    write(join(dataDir, "agents", "x.md"), "---\nname: x\nextends: claude:code-reviewer\nharness: codex\ndescription: Mine\nthinking: low\n---\n");
    const def = byId(await service.list(scope(), ALL), "personal:x");
    expect(def.effective).toMatchObject({ harness: "codex", model: "inherit", thinking: "low", description: "Mine", tools: null, permissionMode: null, prompt: "You review code." });
    expect(def.available).toBe(true);
    expect(def.problems).toEqual(["claude:code-reviewer's model, tools, permissionMode not used on Codex", "Claude Code settings not used on Codex: maxTurns, hooks"]);
  });

  it("a missing source makes it unavailable", async () => {
    write(join(dataDir, "agents", "ghost.md"), "---\nname: ghost\nextends: claude:nobody\n---\n");
    expect(byId(await service.list(scope(), ALL), "personal:ghost")).toMatchObject({ available: false, problems: ["source not found: claude:nobody"], base: null });
    expect(byId(await service.list(scope(), ALL), "claude:code-reviewer").base).toBeNull();
  });

  it("extends a file by path (relative, ~) and refuses loops", async () => {
    write(join(dataDir, "agents", "base", "base.toml"), 'name = "base"\ndeveloper_instructions = "Base."\nmodel = "gpt-6"');
    write(join(dataDir, "agents", "rel.md"), "---\nname: rel\nextends: base/base.toml\n---\nMore.");
    write(join(home, "shared", "one.md"), "---\nname: one\nharness: pi\n---\nOne.");
    write(join(dataDir, "agents", "tilde.md"), "---\nname: tilde\nextends: ~/shared/one.md\n---\n");
    write(join(dataDir, "agents", "loop-a.md"), "---\nname: loop-a\nextends: ./loop-b.md\n---\n");
    write(join(dataDir, "agents", "loop-b.md"), "---\nname: loop-b\nextends: ./loop-a.md\n---\n");
    const defs = await service.list(scope(), ALL);
    expect(byId(defs, "personal:rel").effective).toMatchObject({ harness: "codex", model: "codex/gpt-6", prompt: "Base.\n\nMore." });
    expect(byId(defs, "personal:tilde").effective).toMatchObject({ harness: "pi", prompt: "One." });
    expect(byId(defs, "personal:loop-a").available).toBe(false);
    expect(byId(defs, "personal:loop-a").problems.join(" ")).toMatch(/loops back/);
  });

  it("reads the source fresh every time", async () => {
    write(join(dataDir, "agents", "b.md"), "---\nname: b\nextends: claude:code-reviewer\n---\n");
    expect((await service.resolve("b", scope(), ALL)).def.effective.prompt).toBe("You review code.");
    claudeReviewer(home);
    write(join(home, ".claude", "agents", "code-reviewer.md"), "---\nname: code-reviewer\n---\nEdited upstream.");
    expect((await service.resolve("b", scope(), ALL)).def.effective.prompt).toBe("Edited upstream.");
  });
});

describe("save and remove", () => {
  const fields = (over: Partial<ReturnType<typeof emptyAgentDefFields>>) => ({ ...emptyAgentDefFields(), ...over });

  it("creates, renames (keeping unknown keys) and deletes personal agents", async () => {
    const saved = await service.save({ scope: "personal", fields: fields({ name: "Scout Agent", harness: "claude", model: "anthropic/haiku", nicknames: ["Brandon"], prompt: "Look." }) }, null, ALL);
    expect(saved).toMatchObject({ id: "personal:scout-agent", editable: true, available: true });
    const path = join(dataDir, "agents", "scout-agent.md");
    expect(readFileSync(path, "utf8")).toBe("---\nname: scout-agent\nharness: claude\nmodel: anthropic/haiku\nnickname: Brandon\n---\nLook.\n");
    // Someone adds a key Glade doesn't know; a rename keeps it.
    writeFileSync(path, readFileSync(path, "utf8").replace("---\nLook.", "maxTurns: 3\n---\nLook."));
    const renamed = await service.save({ scope: "personal", previousName: "scout-agent", fields: fields({ name: "scout", harness: "claude", prompt: "Look harder." }) }, null, ALL);
    expect(renamed.id).toBe("personal:scout");
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(dataDir, "agents", "scout.md"), "utf8")).toBe("---\nname: scout\nharness: claude\nmaxTurns: 3\n---\nLook harder.\n");
    await service.remove("personal", "scout", null);
    expect(existsSync(join(dataDir, "agents", "scout.md"))).toBe(false);
    await expect(service.remove("personal", "scout", null)).rejects.toMatchObject({ status: 404 });
  });

  it("saves project agents in the project's .agents/agents", async () => {
    const saved = await service.save({ scope: "project", projectId: "p1", fields: fields({ name: "proj" }) }, cwd, ALL);
    expect(saved.id).toBe("project:proj");
    expect(existsSync(join(cwd, ".agents", "agents", "proj.md"))).toBe(true);
    await expect(service.save({ scope: "project", fields: fields({ name: "x" }) }, null, ALL)).rejects.toMatchObject({ status: 400 });
  });

  it("validates fields and refuses renaming onto an existing agent", async () => {
    const bad = [
      fields({ name: "" }),
      fields({ name: "a", model: "anthropic/haiku" }),
      fields({ name: "a", color: "red" as never }),
      fields({ name: "a", icon: "nope" as never }),
      fields({ name: "a", thinking: "turbo" as never }),
      fields({ name: "a", sandbox: "open" as never }),
      fields({ name: "a", nicknames: Array.from({ length: 13 }, (_, i) => `N${i}`) }),
    ];
    for (const f of bad) await expect(service.save({ scope: "personal", fields: f }, null, ALL), JSON.stringify(f)).rejects.toMatchObject({ status: 400 });
    await service.save({ scope: "personal", fields: fields({ name: "a" }) }, null, ALL);
    await service.save({ scope: "personal", fields: fields({ name: "b" }) }, null, ALL);
    await expect(service.save({ scope: "personal", previousName: "b", fields: fields({ name: "a" }) }, null, ALL)).rejects.toMatchObject({ status: 409 });
    // A model with `extends` and no harness is fine (the source's harness).
    await expect(service.save({ scope: "personal", fields: fields({ name: "c", extends: "claude:c", model: "anthropic/haiku" }) }, null, ALL)).resolves.toMatchObject({ id: "personal:c" });
  });
});

describe("customizations (I-220)", () => {
  const fields = (over: Partial<ReturnType<typeof emptyAgentDefFields>>) => ({ ...emptyAgentDefFields(), ...over });
  const custom = (over: Partial<ReturnType<typeof emptyAgentDefFields>> = {}) => fields({ name: "code-reviewer", extends: "claude:code-reviewer", nicknames: ["Rex"], ...over });
  const piScout = () => write(join(cwd, ".pi", "agents", "scout.md"), "---\nname: scout\ndescription: pi scout\nmodel: pi/tiny\n---\nScout it.");
  beforeEach(() => claudeReviewer(home));

  it("a same-named extends file is the source's customization, not a second agent or a clash", async () => {
    write(join(dataDir, "agents", "code-reviewer.md"), "---\nname: code-reviewer\nextends: claude:code-reviewer\nnickname: Rex\ndescription: Mine\n---\nAlso tests.");
    const defs = await service.list(scope(), ALL);
    expect(byId(defs, "claude:code-reviewer")).toMatchObject({ customizedBy: "personal:code-reviewer", customizes: null, available: true, problems: [] });
    expect(byId(defs, "personal:code-reviewer")).toMatchObject({ customizes: "claude:code-reviewer", customizedBy: null, available: true, problems: [] });
    // The customization carries the source's harness and the customized values.
    expect(byId(defs, "personal:code-reviewer").effective).toMatchObject({ harness: "claude", description: "Mine", nicknames: ["Rex"], prompt: "You review code.\n\nAlso tests." });
    // Chats get the customization, by name or by the source's id.
    expect((await service.resolve("code-reviewer", scope(), ALL)).def.id).toBe("personal:code-reviewer");
    expect((await service.resolve("claude:code-reviewer", scope(), ALL)).def.id).toBe("personal:code-reviewer");
    await expect(service.resolve("nope", scope(), ALL)).rejects.toThrow('Available agents: code-reviewer.');
    // The switch is by name: one for both.
    expect(byId(await service.list(scope(), { ...ALL, switches: { disabled: ["code-reviewer"], projects: {} } }), "personal:code-reviewer").enabled).toBe(false);
  });

  it("a project-level customization counts when it is the only one; both together is a problem on the row", async () => {
    write(join(cwd, ".agents", "agents", "code-reviewer.md"), "---\nname: code-reviewer\nextends: claude:code-reviewer\n---\n");
    let defs = await service.list(scope(), ALL);
    expect(byId(defs, "claude:code-reviewer")).toMatchObject({ customizedBy: "project:code-reviewer", available: true });
    write(join(dataDir, "agents", "code-reviewer.md"), "---\nname: code-reviewer\nextends: claude:code-reviewer\n---\n");
    defs = await service.list(scope(), ALL);
    for (const id of ["claude:code-reviewer", "project:code-reviewer", "personal:code-reviewer"]) {
      expect(byId(defs, id), id).toMatchObject({ available: false, problems: ["Customized in the project and your settings; reset one to the original"] });
    }
    // Resetting the project one leaves the personal one.
    await service.remove("project", "code-reviewer", cwd);
    expect(byId(await service.list(scope(), ALL), "claude:code-reviewer")).toMatchObject({ customizedBy: "personal:code-reviewer", available: true, problems: [] });
  });

  it("saves one customization per source (409 for a second, in any scope) and Reset deletes it", async () => {
    const saved = await service.save({ scope: "personal", fields: custom() }, null, ALL);
    expect(saved).toMatchObject({ id: "personal:code-reviewer", customizes: "claude:code-reviewer" });
    // Editing it is fine.
    await expect(service.save({ scope: "personal", previousName: "code-reviewer", fields: custom({ nicknames: ["Rex", "Ria"] }) }, null, ALL)).resolves.toMatchObject({ id: "personal:code-reviewer" });
    // A second one: in the project (seen from the project) or when the project one comes first.
    await expect(service.save({ scope: "project", projectId: "p1", fields: custom() }, cwd, ALL)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("already customized") });
    await service.remove("personal", "code-reviewer", null);
    await service.save({ scope: "project", projectId: "p1", fields: custom() }, cwd, ALL);
    await expect(service.save({ scope: "personal", projectId: "p1", fields: custom() }, null, ALL, cwd)).rejects.toMatchObject({ status: 409 });
    expect(byId(await service.list(scope(), ALL), "claude:code-reviewer").customizedBy).toBe("project:code-reviewer");
    // Reset to Original = delete the Glade file; the source is a plain agent again.
    await service.remove("project", "code-reviewer", cwd);
    expect(byId(await service.list(scope(), ALL), "claude:code-reviewer")).toMatchObject({ customizedBy: null, available: true });
  });

  it("a standalone agent can't overwrite a customization (it would claim the source's name)", async () => {
    await service.save({ scope: "personal", fields: custom() }, null, ALL);
    await expect(service.save({ scope: "personal", fields: fields({ name: "code-reviewer", harness: "pi", prompt: "x" }) }, null, ALL)).rejects.toMatchObject({
      status: 409,
      message: "Claude Code already has an agent named code-reviewer — customize it instead",
    });
  });

  it("a customization is always named like its source", async () => {
    await expect(service.save({ scope: "personal", fields: custom({ name: "rex" }) }, null, ALL)).rejects.toMatchObject({ status: 400, message: "A customization is named like its source: code-reviewer" });
  });

  it("refuses creating or renaming a Glade agent onto a name another listed agent has (409)", async () => {
    piScout();
    write(join(dataDir, "agents", "mine.md"), "---\nname: mine\n---\nMine.");
    const refused = (req: Parameters<typeof service.save>[0], dir: string | null = null) => expect(service.save(req, dir, ALL, cwd)).rejects.toMatchObject({ status: 409 });
    // Any source, any scope.
    await expect(service.save({ scope: "personal", projectId: "p1", fields: fields({ name: "scout", prompt: "x" }) }, null, ALL, cwd)).rejects.toMatchObject({
      status: 409,
      message: "pi already has an agent named scout — customize it instead",
    });
    await refused({ scope: "personal", projectId: "p1", fields: fields({ name: "code-reviewer" }) });
    await refused({ scope: "project", projectId: "p1", fields: fields({ name: "mine" }) }, cwd);
    await refused({ scope: "project", projectId: "p1", previousName: "other", fields: fields({ name: "scout" }) }, cwd);
    await expect(service.save({ scope: "personal", projectId: "p1", previousName: "mine", fields: fields({ name: "scout" }) }, null, ALL, cwd)).rejects.toMatchObject({ status: 409 });
    // The agent's own customization is allowed; naming a standalone agent like a customized one is not.
    await service.save({ scope: "personal", projectId: "p1", fields: fields({ name: "scout", extends: "pi:scout" }) }, null, ALL, cwd);
    await refused({ scope: "project", projectId: "p1", fields: fields({ name: "scout" }) }, cwd);
    // A customization of another source with the same name clashes with the first.
    write(join(home, ".claude", "agents", "scout.md"), "---\nname: scout\n---\nClaude scout.");
    const clash = await service.list(scope(), ALL);
    for (const id of ["pi:scout", "claude:scout", "personal:scout"]) expect(byId(clash, id).problems, id).toContain("Two agents are named scout; rename one");
    // Saving it unchanged while a clash exists is still possible (only new names are checked).
    await expect(service.save({ scope: "personal", projectId: "p1", previousName: "mine", fields: fields({ name: "mine", prompt: "Still mine." }) }, null, ALL, cwd)).resolves.toMatchObject({ id: "personal:mine" });
  });
});

describe("tools cache", () => {
  it("keeps the latest per harness + project, falls back to any project, and persists", () => {
    expect(service.tools("pi", "p1")).toEqual({ harness: "pi", tools: [], mcpServers: [], seenAt: null });
    service.recordTools("pi", "p1", ["read", "bash", "read"], []);
    service.recordTools("claude", "p2", ["Read"], ["github"]);
    expect(service.tools("pi", "p1")).toMatchObject({ tools: ["read", "bash"], mcpServers: [] });
    expect(service.tools("claude", "p1")).toMatchObject({ tools: ["Read"], mcpServers: ["github"] });
    service.flush();
    const again = new AgentDefsService({ dataDir, homeDir: home, env: {} });
    expect(again.tools("pi", "p1").tools).toEqual(["read", "bash"]);
    expect(again.tools("pi", "p1").seenAt).toEqual(expect.any(Number));
    expect(JSON.parse(readFileSync(join(dataDir, "agent-tools.json"), "utf8")).entries).toHaveLength(2);
  });
});
