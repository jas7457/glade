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
      GLADE_DATA_DIR: "/tmp/d",
      MY_CMUX_THING: "kept (prefix only)",
      ANTHROPIC_API_KEY: "k",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/me",
      GLADE_DATA_DIR: "/tmp/d",
      MY_CMUX_THING: "kept (prefix only)",
      ANTHROPIC_API_KEY: "k",
    });
  });

  it("drops the server's own listening config but keeps the data folder (I-058)", () => {
    const env = piChildEnv({
      GLADE_PORT: "54253",
      GLADE_HOST: "127.0.0.1",
      GLADE_STATIC_DIR: "/Applications/Glade.app/Contents/Resources/app/web",
      GLADE_EXIT_ON_STDIN_CLOSE: "1",
      GLADE_SERVER_KIND: "desktop",
      GLADE_DATA_DIR: "/tmp/sandbox",
      PATH: "/usr/bin",
    });
    expect(env).toEqual({ GLADE_DATA_DIR: "/tmp/sandbox", PATH: "/usr/bin" });
  });

  it("strips the pre-rename PI_UI_* names too, keeping PI_UI_DATA_DIR (I-059)", () => {
    const env = piChildEnv({
      PI_UI_PORT: "54253",
      PI_UI_HOST: "127.0.0.1",
      PI_UI_STATIC_DIR: "/Applications/pi-ui.app/Contents/Resources/app/web",
      PI_UI_EXIT_ON_STDIN_CLOSE: "1",
      PI_UI_SERVER_KIND: "desktop",
      PI_UI_URL: "u",
      PI_UI_TOKEN: "t",
      PI_UI_SESSION_ID: "s",
      PI_UI_AGENT_NAME: "n",
      PI_UI_DATA_DIR: "/tmp/sandbox",
      PATH: "/usr/bin",
    });
    expect(env).toEqual({ PI_UI_DATA_DIR: "/tmp/sandbox", PATH: "/usr/bin" });
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
  const vars = { CMUX_SURFACE_ID: "surface", PI_AGENT_TEAMS_ROLE: "child", GLADE_TEST_KEEP: "yes" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "glade-env-"));
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
      command: join(dir, "pi"),
      utilityCwd: dir,
    });
  const recorded = (name: string) => JSON.parse(readFileSync(join(dir, `env-${name}.json`), "utf8")) as string[];

  it("strips them from `pi --mode rpc` processes", async () => {
    await harness().listModels();
    const keys = recorded("rpc");
    expect(keys).toContain("GLADE_TEST_KEEP");
    expect(keys.filter((k) => k.startsWith("CMUX_") || k.startsWith("PI_AGENT_TEAMS_"))).toEqual([]);
  });

  it("strips them from one-shot title processes", async () => {
    expect(await harness().complete({ prompt: "hi", cwd: dir, model: null })).toBe("A title");
    const keys = recorded("p");
    expect(keys).toContain("GLADE_TEST_KEEP");
    expect(keys.filter((k) => k.startsWith("CMUX_") || k.startsWith("PI_AGENT_TEAMS_"))).toEqual([]);
  });
});

describe("PiHarness extra env and model refresh (I-196)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "glade-env-"));
    writeFileSync(join(dir, "pi"), FAKE_PI);
    chmodSync(join(dir, "pi"), 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const recorded = (name: string) => JSON.parse(readFileSync(join(dir, `env-${name}.json`), "utf8")) as string[];

  it("passes the harness env (LLAMA_BASE_URL) to rpc and one-shot processes", async () => {
    const harness = new PiHarness({ command: join(dir, "pi"), utilityCwd: dir, env: () => ({ LLAMA_BASE_URL: "http://127.0.0.1:8080" }) });
    await harness.listModels();
    expect(recorded("rpc")).toContain("LLAMA_BASE_URL");
    await harness.complete({ prompt: "hi", cwd: dir, model: null });
    expect(recorded("p")).toContain("LLAMA_BASE_URL");
  });

  it("a forced refresh asks again after pi's background catalog refresh", async () => {
    // Answers get_available_models with one more model each time it's asked.
    writeFileSync(
      join(dir, "pi"),
      `#!/usr/bin/env node
let buf = "", n = 0;
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    const models = m.type === "get_available_models" ? Array.from({ length: ++n }, (_, k) => ({ id: "m" + k, name: "m" + k, provider: "llama.cpp" })) : [];
    process.stdout.write(JSON.stringify({ type: "response", id: m.id, command: m.type, success: true, data: { models } }) + "\\n");
  }
});
`,
    );
    const harness = new PiHarness({ command: join(dir, "pi"), utilityCwd: dir, modelsSettleMs: 10 });
    expect((await harness.listModels()).map((m) => m.id)).toEqual(["m0"]);
    expect((await harness.listModels(true)).map((m) => m.id)).toEqual(["m0", "m1"]);
  });
});
