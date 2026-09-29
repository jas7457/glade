/**
 * Attachments go to the session's own environment (I-123/I-125): its base URL and device token,
 * so `Attached file:` paths are paths on the host that runs the agent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi, localBaseUrl } from "@glade/app-core/lib/api";
import { makeSession } from "@glade/app-core/test/fixtures";
import { fakeEnv, resetEnvironmentsForTest, useEnvironments } from "@glade/app-core/test/env-fixtures";
import { attachFilesToText } from "./attachments";
import * as store from "./store";

const B = "http://10.0.0.2:4327/api";
let calls: { url: string; headers: Record<string, string> }[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.startsWith(B) && (init?.headers as Record<string, string>).authorization !== "Bearer TOKEN")
        return new Response(JSON.stringify({ code: "unauthorized", error: "no" }), { status: 401 });
      const host = url.startsWith(B) ? "/Users/studio" : "/Users/air";
      const name = new URL(url).searchParams.get("name");
      return new Response(JSON.stringify({ path: `${host}/.glade/attachments/${name}` }), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetEnvironmentsForTest();
  store.sessions.value = [];
});

describe("attachments per environment", () => {
  it("uploads a remote chat's files to that environment with its token; local ones to the page's server", async () => {
    const onAuthError = vi.fn();
    const remote = createApi(B, { token: () => "TOKEN", onAuthError });
    useEnvironments(fakeEnv({ id: "B", baseUrl: B, api: { uploadAttachment: remote.uploadAttachment } }));
    store.sessions.value = [makeSession({ id: "sb", workspaceId: "wb", environmentId: "B" }), makeSession({ id: "sa", workspaceId: "wa", environmentId: "local-env" })];

    const text = await attachFilesToText("sb", "look", [new File(["x"], "a b.txt")]);
    expect(text).toContain("/Users/studio/.glade/attachments/a b.txt");
    expect(calls[0]).toMatchObject({ url: `${B}/sessions/sb/attachments?name=a%20b.txt`, headers: { authorization: "Bearer TOKEN" } });

    // A revoked token: the error names the file and the environment learns it needs pairing.
    const revoked = createApi(B, { token: () => "OLD", onAuthError });
    await expect(revoked.uploadAttachment("sb", new File(["x"], "c.txt"), "c.txt")).rejects.toThrow();
    expect(onAuthError).toHaveBeenCalledOnce();

    const localClient = createApi(localBaseUrl(), { token: () => null });
    await localClient.uploadAttachment("sa", new File(["x"], "d.txt"), "d.txt");
    expect(calls.at(-1)!.url.startsWith(localBaseUrl())).toBe(true);
    expect(calls.at(-1)!.headers.authorization).toBeUndefined();
  });
});
