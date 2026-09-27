import { describe, expect, it } from "vitest";
import { env, isTemporaryDir, platformDataDir, startupBanner } from "../src/config.js";

describe("isTemporaryDir", () => {
  const roots = ["/tmp", "/var/folders/xy/T"];
  it("flags folders inside a temp root", () => {
    expect(isTemporaryDir("/tmp/glade-lead", roots)).toBe(true);
    expect(isTemporaryDir("/tmp", roots)).toBe(true);
    expect(isTemporaryDir("/var/folders/xy/T/glade/data", roots)).toBe(true);
  });
  it("leaves normal folders alone", () => {
    expect(isTemporaryDir("/Users/me/Library/Application Support/Glade", roots)).toBe(false);
    expect(isTemporaryDir("/tmpfoo/data", roots)).toBe(false);
  });
});

describe("startupBanner", () => {
  const base = { url: "http://127.0.0.1:4317", dataDir: "/data", harness: "pi", kind: "dev" };
  it("shows url, data folder and harness", () => {
    const text = startupBanner({ ...base, temporary: false }).join("\n");
    expect(text).toContain("http://127.0.0.1:4317");
    expect(text).toContain("/data");
    expect(text).toContain("Harness:  pi");
    expect(text).not.toContain("⚠");
  });
  it("warns about temporary data folders, except in sandboxes", () => {
    expect(startupBanner({ ...base, temporary: true }).some((l) => l.startsWith("⚠"))).toBe(true);
    const sandbox = startupBanner({ ...base, temporary: true, sandbox: "tabs" });
    expect(sandbox.some((l) => l.startsWith("⚠"))).toBe(false);
    expect(sandbox[0]).toContain('sandbox "tabs"');
  });
});

describe("env (I-059: GLADE_* with PI_UI_* fallback)", () => {
  it("prefers GLADE_<name>", () => {
    expect(env("PORT", { GLADE_PORT: "1", PI_UI_PORT: "2" })).toBe("1");
  });
  it("falls back to the pre-rename PI_UI_<name>", () => {
    expect(env("DATA_DIR", { PI_UI_DATA_DIR: "/old" })).toBe("/old");
    expect(env("DATA_DIR", { GLADE_DATA_DIR: "", PI_UI_DATA_DIR: "/old" })).toBe("/old");
  });
  it("treats missing and empty values as unset", () => {
    expect(env("HOST", {})).toBeUndefined();
    expect(env("HOST", { GLADE_HOST: "", PI_UI_HOST: "" })).toBeUndefined();
  });
});

describe("platformDataDir", () => {
  it("is named Glade by default, with the old name on request", () => {
    expect(platformDataDir().endsWith("Glade")).toBe(true);
    expect(platformDataDir("pi-ui").endsWith("pi-ui")).toBe(true);
  });
});
