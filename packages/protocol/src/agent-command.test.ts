import { describe, expect, it } from "vitest";
import {
  agentCommandError,
  agentUpdateCommand,
  CommandLineError,
  customAgentCommand,
  effectiveAgentCommand,
  formatCommandLine,
  splitCommandLine,
} from "./agent-command.js";

describe("splitCommandLine (I-201)", () => {
  it("splits on whitespace and respects quotes", () => {
    expect(splitCommandLine("mywrapper pi --offline")).toEqual(["mywrapper", "pi", "--offline"]);
    expect(splitCommandLine(`  my\twrapper   "a b" 'c d' e\\ f  `)).toEqual(["my", "wrapper", "a b", "c d", "e f"]);
    expect(splitCommandLine(`--skill="/my skills"x 'it'"'"'s'`)).toEqual(["--skill=/my skillsx", "it's"]);
    expect(splitCommandLine(`"say \\"hi\\"" 'no \\escape' ""`)).toEqual([`say "hi"`, "no \\escape", ""]);
  });

  it("never expands anything", () => {
    expect(splitCommandLine("~/bin/wrap *.ts '$HOME'")).toEqual(["~/bin/wrap", "*.ts", "$HOME"]);
    expect(splitCommandLine(`"$HOME"`)).toEqual(["$HOME"]);
  });

  it("refuses open quotes and shell syntax", () => {
    expect(() => splitCommandLine(`pi "oops`)).toThrow(CommandLineError);
    expect(() => splitCommandLine(`pi 'oops`)).toThrow(/isn't closed/);
    for (const bad of ["pi | tee log", "pi; rm x", "pi > out", "pi && echo", "pi $HOME", "pi `x`", "pi (a)"]) {
      expect(() => splitCommandLine(bad), bad).toThrow(CommandLineError);
    }
    // Quoted, they're plain characters.
    expect(splitCommandLine(`pi "a|b" 'c;d'`)).toEqual(["pi", "a|b", "c;d"]);
  });

  it("formatCommandLine quotes what a shell would split differently", () => {
    const words = ["mywrapper", "pi", "a b", "it's", "", "--x=1"];
    const line = formatCommandLine(words);
    expect(line).toBe(`mywrapper pi 'a b' 'it'\\''s' '' --x=1`);
    expect(splitCommandLine(line)).toEqual(words);
  });
});

describe("agentCommandError (I-201)", () => {
  it("accepts wrappers and harmless flags; empty means the built-in command", () => {
    expect(agentCommandError("pi", "")).toBeNull();
    expect(agentCommandError("pi", "   ")).toBeNull();
    expect(agentCommandError("pi", "mywrapper pi --offline --skill ~/s -e ./ext.ts")).toBeNull();
    expect(agentCommandError("codex", "codex -c model_reasoning_effort=high")).toBeNull();
    expect(agentCommandError("claude", "mywrapper claude --add-dir /tmp")).toBeNull();
  });

  it("refuses Glade's own flags, also as --flag=value", () => {
    expect(agentCommandError("pi", "mywrapper pi --mode json")).toBe("`--mode` is set by Glade: remove it from the command.");
    expect(agentCommandError("pi", "pi --model=anthropic/x")).toMatch(/`--model` is set by Glade/);
    expect(agentCommandError("pi", "pi -p")).toMatch(/`-p`/);
    expect(agentCommandError("pi", "pi --no-session")).toMatch(/`--no-session`/);
    expect(agentCommandError("codex", "mywrapper codex app-server")).toMatch(/`app-server`/);
    expect(agentCommandError("claude", "claude --output-format text")).toMatch(/`--output-format`/);
    expect(agentCommandError("claude", "claude --permission-mode=plan")).toMatch(/`--permission-mode`/);
  });

  it("explains parse errors, env assignments and unknown agents", () => {
    expect(agentCommandError("pi", `pi "x`)).toMatch(/isn't closed/);
    expect(agentCommandError("pi", "FOO=1 pi")).toMatch(/environment variables/);
    expect(agentCommandError("acp-x", "x")).toMatch(/Only pi, Claude Code and Codex/);
    expect(agentCommandError("pi", `pi ${"a".repeat(2001)}`)).toMatch(/too long/);
  });
});

describe("customAgentCommand / effectiveAgentCommand (I-201)", () => {
  const settings = (entry: Record<string, unknown>) => ({ agents: { pi: entry } });

  it("uses the saved command only while Advanced is on", () => {
    expect(customAgentCommand(settings({ advanced: true, command: "mywrapper pi --offline" }), "pi")).toEqual({ program: "mywrapper", args: ["pi", "--offline"] });
    // Off: Glade's own, even with a command saved.
    expect(customAgentCommand(settings({ advanced: false, command: "mywrapper pi" }), "pi")).toBeNull();
    expect(customAgentCommand(settings({ command: "mywrapper pi" }), "pi")).toBeNull();
    expect(effectiveAgentCommand(settings({ advanced: false, command: "mywrapper pi" }), "pi")).toEqual({ program: "pi", args: [], custom: false });
    expect(effectiveAgentCommand(settings({ advanced: true, command: "mywrapper pi" }), "pi")).toEqual({ program: "mywrapper", args: ["pi"], custom: true });
  });

  it("falls back to the built-in command when none (or an invalid one) is saved", () => {
    expect(customAgentCommand(settings({ advanced: true, command: null }), "pi")).toBeNull();
    expect(customAgentCommand(settings({ advanced: true, command: "  " }), "pi")).toBeNull();
    expect(customAgentCommand(settings({ advanced: true, command: "pi --mode json" }), "pi")).toBeNull();
    expect(customAgentCommand({}, "pi")).toBeNull();
    expect(effectiveAgentCommand({}, "codex")).toEqual({ program: "codex", args: [], custom: false });
    expect(effectiveAgentCommand(null, "claude")).toEqual({ program: "claude", args: [], custom: false });
  });
});

describe("agentUpdateCommand (I-201)", () => {
  it("runs the agent's updater through the custom command", () => {
    expect(agentUpdateCommand("pi", null)).toBe("pi update self");
    expect(agentUpdateCommand("pi", { program: "mywrapper", args: ["pi"] })).toBe("mywrapper pi update self");
    expect(agentUpdateCommand("claude", { program: "/opt/my tools/claude-wrap", args: [] })).toBe("'/opt/my tools/claude-wrap' update");
    expect(agentUpdateCommand("codex", { program: "mywrapper", args: ["codex"] })).toBe("mywrapper codex update");
    expect(agentUpdateCommand("acp-x", { program: "x", args: [] })).toBeNull();
  });
});
