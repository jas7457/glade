/**
 * I-038: pi processes must not inherit the terminal multiplexer's (`CMUX_*`) or agent-teams'
 * (`PI_AGENT_TEAMS_*`) environment.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { piChildEnv } from "../src/harness/pi/child-env.js";
import { PiHarness } from "../src/harness/pi/pi-harness.js";

describe("piChildEnv", () => {
  it("drops CMUX_* and PI_AGENT_TEAMS_* and keeps everything else", () => {
    const env = piChildEnv({
      PATH: "/usr/bin",
      HOME: "/Users/me",
      CMUX_SURFACE_ID: "s1",
      CMUX_SOCKET_PATH: "/tmp/cmux.sock",
      PI_AGENT_TEAMS_PARENT: "x",
      PI_UI_DATA_DIR: "/tmp/d",
      MY_CMUX_THING: "kept (prefix only)",
      ANTHROPIC_API_KEY: "k",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/me",
      PI_UI_DATA_DIR: "/tmp/d",
      MY_CMUX_THING: "kept (prefix only)",
      ANTHROPIC_API_KEY: "k",
    });
  });

  it("does not modify the input", () => {
    const input = { CMUX_X: "1", A: "2" };
    piChildEnv(input);
    expect(input).toEqual({ CMUX_X: "1", A: "2" });
  });
});

/** A stand-in `pi` that records the variable names it was started with. */
const FAKE_PI = `#!/usr/bin/env node
const fs = require("fs");
const oneShot = process.argv.includes("-p");
fs.writeFileSync(process.cwd() + "/env-" + (oneShot ? "p" : "rpc") + ".json", JSON.stringify(Object.keys(process.env)));
if (oneShot) { console.log("A title"); process.exit(0); }
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    process.stdout.write(JSON.stringify({ type: "response", id: m.id, command: m.type, success: true, data: { models: [] } }) + "\\n");
  }
});
`;

describe("PiHarness child environment", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const vars = { CMUX_SURFACE_ID: "surface", PI_AGENT_TEAMS_ROLE: "child", PI_UI_TEST_KEEP: "yes" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-ui-env-"));
    writeFileSync(join(dir, "pi"), FAKE_PI);
    chmodSync(join(dir, "pi"), 0o755);
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });

  afterEach(() => {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const harness = () =>
    new PiHarness({
      config: () => ({ piPath: join(dir, "pi"), extraArgs: [], autoCompaction: true, autoRetry: true }),
      utilityCwd: dir,
    });
  const recorded = (name: string) => JSON.parse(readFileSync(join(dir, `env-${name}.json`), "utf8")) as string[];

  it("strips them from `pi --mode rpc` processes", async () => {
    await harness().listModels();
    const keys = recorded("rpc");
    expect(keys).toContain("PI_UI_TEST_KEEP");
    expect(keys.filter((k) => k.startsWith("CMUX_") || k.startsWith("PI_AGENT_TEAMS_"))).toEqual([]);
  });

  it("strips them from one-shot title processes", async () => {
    expect(await harness().generateTitle({ firstMessage: "hi", cwd: dir, model: null })).toBe("A title");
    const keys = recorded("p");
    expect(keys).toContain("PI_UI_TEST_KEEP");
    expect(keys.filter((k) => k.startsWith("CMUX_") || k.startsWith("PI_AGENT_TEAMS_"))).toEqual([]);
  });
});
