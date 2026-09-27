import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_USAGE_URL,
  fetchAnthropicUsageLimits,
  parseAnthropicUsage,
  readPiAnthropicAuth,
} from "../src/harness/pi/anthropic-usage.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/anthropic-usage.json", import.meta.url), "utf8")) as Record<string, unknown>;
const NOW = Date.parse("2026-09-26T18:00:00Z");

function authFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "glade-auth-"));
  const path = join(dir, "auth.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

const oauth = (expires = NOW + 3_600_000) => authFile({ anthropic: { type: "oauth", access: "tok-secret", refresh: "r", expires } });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("readPiAnthropicAuth", () => {
  it("reads the OAuth access token", () => {
    expect(readPiAnthropicAuth(oauth(123))).toEqual({ access: "tok-secret", expires: 123, type: "oauth" });
  });

  it("returns null for a missing file, bad JSON, API keys or missing fields", () => {
    expect(readPiAnthropicAuth("/nonexistent/auth.json")).toBeNull();
    expect(readPiAnthropicAuth(authFile("{nope"))).toBeNull();
    expect(readPiAnthropicAuth(authFile({ anthropic: { type: "api_key", key: "sk-..." } }))).toBeNull();
    expect(readPiAnthropicAuth(authFile({ anthropic: { type: "oauth" } }))).toBeNull();
    expect(readPiAnthropicAuth(authFile({ openai: { type: "oauth", access: "x" } }))).toBeNull();
    expect(readPiAnthropicAuth(authFile([]))).toBeNull();
  });

  it("tolerates a missing expiry", () => {
    expect(readPiAnthropicAuth(authFile({ anthropic: { type: "oauth", access: "a" } }))?.expires).toBe(0);
  });
});

describe("parseAnthropicUsage", () => {
  it("maps the real response shape", () => {
    expect(parseAnthropicUsage(fixture, NOW)).toEqual({
      source: "Claude subscription",
      provider: "anthropic",
      fetchedAt: NOW,
      stale: false,
      limits: [
        { id: "session", label: "Current session", percent: 46, resetsAt: "2026-09-26T22:39:59.874Z", severity: "normal", active: true },
        { id: "weekly_all", label: "This week", percent: 6, resetsAt: "2026-10-03T15:59:59.874Z", severity: "normal", active: false },
        { id: "weekly_scoped:Fable", label: "Fable this week", percent: 0, resetsAt: "2026-10-03T16:00:00.000Z", severity: "normal", active: false, model: "Fable" },
      ],
    });
  });

  it("handles unknown kinds, scopes, severities and extra usage defensively", () => {
    const body = {
      limits: [
        { kind: "session", percent: 97.5, severity: "critical", resets_at: "garbage", is_active: true },
        { kind: "weekly_scoped", percent: 81, severity: "warning", resets_at: null, scope: { model: null, surface: "claude_code" } },
        { kind: "weekly_scoped", percent: 3, scope: null },
        { kind: "monthly_opus", percent: 150, severity: "mystery" },
        { kind: "weekly_all", percent: "12" }, // non-numeric percent → skipped
        { percent: 5 }, // no kind → skipped
        "junk",
      ],
      extra_usage: { is_enabled: true, utilization: 20, spend_limit_reached: false },
    };
    const result = parseAnthropicUsage(body, NOW);
    expect(result?.limits.map((l) => [l.id, l.label, l.percent, l.severity, l.resetsAt, l.active])).toEqual([
      ["session", "Current session", 97.5, "critical", null, true],
      ["weekly_scoped:claude_code", "Claude code this week", 81, "warning", null, false],
      ["weekly_scoped", "Scoped limit this week", 3, "normal", null, false],
      ["monthly_opus", "Monthly opus", 100, "normal", null, false],
      ["extra_usage", "Extra usage", 20, "normal", null, false],
    ]);
  });

  it("returns null for unexpected shapes", () => {
    expect(parseAnthropicUsage(null, NOW)).toBeNull();
    expect(parseAnthropicUsage({ limits: "x" }, NOW)).toBeNull();
    expect(parseAnthropicUsage({ five_hour: {} }, NOW)).toBeNull();
    expect(parseAnthropicUsage({ limits: [] }, NOW)).toBeNull();
    expect(parseAnthropicUsage({ limits: [{ kind: "session" }] }, NOW)).toBeNull();
  });
});

describe("fetchAnthropicUsageLimits", () => {
  it("calls the endpoint with the OAuth token and beta header", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse(fixture));
    const result = await fetchAnthropicUsageLimits({ fetch: fetch as unknown as typeof globalThis.fetch, authPath: oauth(), now: () => NOW });
    expect(result?.limits.map((l) => l.percent)).toEqual([46, 6, 0]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(ANTHROPIC_USAGE_URL);
    expect(init?.headers).toMatchObject({ Authorization: "Bearer tok-secret", "anthropic-beta": "oauth-2025-04-20" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not call the endpoint when there is no OAuth login or the token expired", async () => {
    const fetch = vi.fn(async () => jsonResponse(fixture));
    const f = fetch as unknown as typeof globalThis.fetch;
    expect(await fetchAnthropicUsageLimits({ fetch: f, authPath: "/nonexistent", now: () => NOW })).toBeNull();
    expect(await fetchAnthropicUsageLimits({ fetch: f, authPath: oauth(NOW - 1), now: () => NOW })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns null on HTTP errors, network errors and bad JSON (never throws)", async () => {
    const authPath = oauth();
    const cases: Array<() => Promise<Response>> = [
      async () => jsonResponse({ error: "unauthorized" }, 401),
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => new Response("<html>", { status: 200 }),
      async () => jsonResponse({ something: "else" }),
    ];
    for (const impl of cases) {
      const fetch = vi.fn(impl) as unknown as typeof globalThis.fetch;
      await expect(fetchAnthropicUsageLimits({ fetch, authPath, now: () => NOW })).resolves.toBeNull();
    }
  });
});
