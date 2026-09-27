import { describe, expect, it } from "vitest";
import { isTemporaryDir, startupBanner } from "../src/config.js";

describe("isTemporaryDir", () => {
  const roots = ["/tmp", "/var/folders/xy/T"];
  it("flags folders inside a temp root", () => {
    expect(isTemporaryDir("/tmp/piui-lead", roots)).toBe(true);
    expect(isTemporaryDir("/tmp", roots)).toBe(true);
    expect(isTemporaryDir("/var/folders/xy/T/pi-ui/data", roots)).toBe(true);
  });
  it("leaves normal folders alone", () => {
    expect(isTemporaryDir("/Users/me/Library/Application Support/pi-ui", roots)).toBe(false);
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
