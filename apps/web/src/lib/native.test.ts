import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

import { pickFolder } from "./native";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("pickFolder", () => {
  beforeEach(() => fetchMock.mockReset());

  it("posts to the server and returns its answer", async () => {
    fetchMock.mockResolvedValue(json(200, { path: "/a/b" }));
    expect(await pickFolder({ prompt: "Pick" })).toEqual({ path: "/a/b" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/fs/pick-folder");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ prompt: "Pick" });
  });

  it("maps 501 to unavailable and rethrows other errors", async () => {
    fetchMock.mockResolvedValueOnce(json(501, { error: "only on macOS" }));
    expect(await pickFolder()).toEqual({ unavailable: true });
    fetchMock.mockResolvedValueOnce(json(500, { error: "boom" }));
    await expect(pickFolder()).rejects.toThrow("boom");
  });
});
