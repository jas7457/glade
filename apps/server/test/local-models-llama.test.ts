/** I-196: the llama-server router backend: mapping, router detection, errors. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalModelsError } from "../src/services/local-models/backend.js";
import { displayName, ggufSize, LlamaServerBackend, normalizeLlamaUrl } from "../src/services/local-models/llama-server.js";
import { closedUrl, startFakeRouter, type FakeRouter } from "./fake-llama-router.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function router(models: Parameters<typeof startFakeRouter>[0]): Promise<FakeRouter> {
  const r = await startFakeRouter(models);
  cleanups.push(() => r.close());
  return r;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "glade-gguf-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("LlamaServerBackend.list", () => {
  it("maps every status, sizes, context and sorts loaded first (loading ones stay in place)", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "zeta-Q4_K_M.gguf"), Buffer.alloc(1234));
    const r = await router({
      "zeta-Q4_K_M": { status: "unloaded", path: join(dir, "zeta-Q4_K_M.gguf") },
      "alpha-Q8_0": { status: "loaded", size: 5_000_000, nCtx: 32768 },
      beta: { status: "loading", args: ["llama-server", "-m", "/nowhere/beta.gguf", "-c", "8192"] },
      gamma: { status: "sleeping" },
      delta: { status: "unloaded", failed: true, exitCode: 3 },
      "org/eps-GGUF:Q4_K_M": { status: "downloading" },
    });
    const snap = await new LlamaServerBackend({ url: `${r.url}/` }).list();
    expect(snap.reachable).toBe(true);
    expect(snap.error).toBeNull();
    expect(snap.maxLoaded).toBe(4);
    expect(snap.models.map((m) => [m.id, m.status])).toEqual([
      ["alpha-Q8_0", "loaded"],
      ["gamma", "sleeping"],
      ["beta", "loading"],
      ["delta", "failed"],
      ["org/eps-GGUF:Q4_K_M", "loading"],
      ["zeta-Q4_K_M", "unloaded"],
    ]);
    const byId = new Map(snap.models.map((m) => [m.id, m]));
    expect(byId.get("alpha-Q8_0")).toEqual({ id: "alpha-Q8_0", name: "alpha-Q8_0", status: "loaded", sizeBytes: 5_000_000, contextLength: 32768 });
    expect(byId.get("beta")).toMatchObject({ sizeBytes: null, contextLength: 8192 });
    // Not loaded: the size of the file on disk (from `-m`), unknown when it isn't there.
    expect(byId.get("zeta-Q4_K_M")).toMatchObject({ sizeBytes: 1234, contextLength: null });
    expect(byId.get("delta")!.error).toMatch(/exited with code 3/);
    expect(byId.get("org/eps-GGUF:Q4_K_M")!.name).toBe("eps:Q4_K_M");
  });

  it("unlimited --models-max (0) is maxLoaded null", async () => {
    const r = await router({});
    r.props.max_instances = 0;
    expect((await new LlamaServerBackend({ url: r.url }).list()).maxLoaded).toBeNull();
  });

  it("explains a single-model llama-server", async () => {
    const r = await router({});
    r.singleModel = true;
    const snap = await new LlamaServerBackend({ url: r.url }).list();
    expect(snap).toEqual({ reachable: true, error: "llama-server is running a single model; start it without -m to manage models", models: [], maxLoaded: null });
  });

  it("reports an unreachable server", async () => {
    const url = await closedUrl();
    const snap = await new LlamaServerBackend({ url }).list();
    expect(snap).toEqual({ reachable: false, error: `llama-server isn't running at ${url}`, models: [], maxLoaded: null });
  });

  it("asks for an API key on 401 and sends LLAMA_API_KEY as a bearer token", async () => {
    const r = await router({});
    r.forceStatus = 401;
    expect((await new LlamaServerBackend({ url: r.url }).list()).error).toMatch(/API key/);
    const seen: string[] = [];
    const fetchSpy: typeof fetch = async (input, init) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return fetch(input, init);
    };
    await new LlamaServerBackend({ url: r.url, apiKey: "s3cret", fetch: fetchSpy }).list();
    expect(seen[0]).toBe("Bearer s3cret");
  });
});

describe("LlamaServerBackend load/unload", () => {
  it("loads and unloads; maps the router's errors", async () => {
    const r = await router({ a: { status: "unloaded" } });
    const b = new LlamaServerBackend({ url: r.url });
    await b.load("a");
    expect(r.models.get("a")!.status).toBe("loading");
    await expect(b.load("a")).rejects.toMatchObject({ status: 409 });
    await expect(b.load("nope")).rejects.toMatchObject({ status: 404 });
    await b.unload("a");
    await expect(b.unload("a")).rejects.toMatchObject({ status: 409, message: "a isn't loaded" });
    expect(r.requests.filter((q) => q.startsWith("POST"))).toEqual(["POST /models/load a", "POST /models/load a", "POST /models/load nope", "POST /models/unload a", "POST /models/unload a"]);
  });

  it("limit reached is a 409, other failures and unreachable a 502", async () => {
    const answer = (status: number, message: string): typeof fetch => async () => new Response(JSON.stringify({ error: { code: status, message } }), { status });
    const limit = new LlamaServerBackend({ url: "http://x", fetch: answer(500, "model limit reached, try again later") });
    await expect(limit.load("a")).rejects.toMatchObject({ status: 409 });
    const broken = new LlamaServerBackend({ url: "http://x", fetch: answer(500, "boom") });
    await expect(broken.load("a")).rejects.toMatchObject({ status: 502, message: "llama-server couldn't load a: boom" });
    const url = await closedUrl();
    const err = await new LlamaServerBackend({ url }).unload("a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalModelsError);
    expect(err).toMatchObject({ status: 502, message: `llama-server isn't running at ${url}` });
  });
});

describe("helpers", () => {
  it("display names and URLs", () => {
    expect(displayName("Qwen3.8-27B-Q4_K_M")).toBe("Qwen3.8-27B-Q4_K_M");
    expect(displayName("ggml-org/gemma-3-4b-it-GGUF:Q4_K_M")).toBe("gemma-3-4b-it:Q4_K_M");
    expect(normalizeLlamaUrl(" http://127.0.0.1:8080/v1/ ")).toBe("http://127.0.0.1:8080");
  });

  it("sums split GGUF parts", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "big-00001-of-00002.gguf"), Buffer.alloc(10));
    writeFileSync(join(dir, "big-00002-of-00002.gguf"), Buffer.alloc(5));
    writeFileSync(join(dir, "mmproj.gguf"), Buffer.alloc(99));
    expect(await ggufSize(join(dir, "big-00001-of-00002.gguf"))).toBe(15);
    expect(await ggufSize(join(dir, "missing.gguf"))).toBeNull();
  });
});
