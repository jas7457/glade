import { afterEach, describe, expect, it, vi } from "vitest";
import { runHttpCheck } from "../src/checks/http.js";

const check = { id: "api", name: "API", url: "https://api.test/health", intervalSec: 30, timeoutMs: 1000 };

afterEach(() => vi.unstubAllGlobals());

describe("runHttpCheck", () => {
  it("counts 2xx as up", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 204 })));
    const result = await runHttpCheck(check);
    expect(result).toMatchObject({ checkId: "api", ok: true, status: 204 });
  });

  it("counts 5xx as down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
    expect((await runHttpCheck(check)).ok).toBe(false);
  });

  it("reports network errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const result = await runHttpCheck(check);
    expect(result).toMatchObject({ ok: false, status: null, error: "fetch failed" });
  });
});
