import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/preact";
import type { ImageBlock, ToolCallBlock } from "@glade/protocol";
import { connections, type EnvHandle } from "@/state/env-registry";
import { localBaseUrl } from "@/lib/api";
import { ChatEnvContext } from "./chat-env";
import { resetBlobUrlCache } from "./image-src";
import { ImageThumb } from "./UserBubble";
import { ToolCallRow } from "./tools/ToolViews";

const SID = "5f0c2a9e-1b2c-4d5e-8f90-123456789abc";
const PATH = `${SID}/0123456789abcdef`;
const ref: ImageBlock = { type: "image", mimeType: "image/png", blob: PATH, width: 10, height: 10 };
const HASH = "ab".repeat(32);

function remoteEnv(token: string | null): EnvHandle {
  return { id: "remote-1", baseUrl: "https://studio.tail.ts.net/api", isLocal: false, token } as unknown as EnvHandle;
}

afterEach(() => {
  connections.value = [];
  resetBlobUrlCache();
  vi.unstubAllGlobals();
});

describe("image refs (I-157/I-163)", () => {
  it("inline images stay data: URLs", () => {
    const { container } = render(<ImageThumb image={{ type: "image", mimeType: "image/png", data: "AAAA" }} />);
    expect(container.querySelector("img")!.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  it("local chats load the blob straight from this server's API", () => {
    const { container } = render(<ImageThumb image={ref} />);
    expect(container.querySelector("img")!.getAttribute("src")).toBe(`${localBaseUrl()}/blobs/${PATH}`);
  });

  it("legacy sha256 refs still load by hash", () => {
    const { container } = render(<ImageThumb image={{ ...ref, blob: `sha256:${HASH}` }} />);
    expect(container.querySelector("img")!.getAttribute("src")).toBe(`${localBaseUrl()}/blobs/${HASH}`);
  });

  it("malformed refs have no source", () => {
    const { container } = render(<ImageThumb image={{ ...ref, blob: "../glade.db" }} />);
    expect(container.querySelector("img")?.getAttribute("src") ?? null).toBeNull();
  });

  it("a remote environment without a token (loopback) is loaded by URL too", () => {
    connections.value = [remoteEnv(null)];
    const { container } = render(
      <ChatEnvContext.Provider value="remote-1">
        <ImageThumb image={ref} />
      </ChatEnvContext.Provider>,
    );
    expect(container.querySelector("img")!.getAttribute("src")).toBe(`https://studio.tail.ts.net/api/blobs/${PATH}`);
  });

  it("paired remote chats fetch the blob with the device token and show an object URL", async () => {
    connections.value = [remoteEnv("tok-123")];
    const fetchMock = vi.fn(async () => new Response(new Blob(["png"], { type: "image/png" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.fn(() => "blob:glade/1");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL }));
    const { container } = render(
      <ChatEnvContext.Provider value="remote-1">
        <ImageThumb image={ref} />
      </ChatEnvContext.Provider>,
    );
    // Nothing with the token in a URL; no src until the bytes are there.
    expect(container.querySelector("img")!.getAttribute("src")).toBeNull();
    await waitFor(() => expect(container.querySelector("img")!.getAttribute("src")).toBe("blob:glade/1"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://studio.tail.ts.net/api/blobs/${PATH}`);
    expect(init.headers).toEqual({ authorization: "Bearer tok-123" });
    // Cached: a second render doesn't fetch again.
    render(
      <ChatEnvContext.Provider value="remote-1">
        <ImageThumb image={ref} />
      </ChatEnvContext.Provider>,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tool result images with refs render from the blob URL", () => {
    const call: ToolCallBlock = { type: "toolCall", id: "c1", name: "screenshot", kind: "other", args: {} };
    const { container } = render(
      <ToolCallRow
        part={{ type: "tool", key: "c1", call, result: { toolCallId: "c1", toolName: "screenshot", status: "done", output: "shot", images: [ref] }, status: "done" } as never}
        defaultOpen
      />,
    );
    const img = container.querySelector(`img[src$="/blobs/${PATH}"]`);
    expect(img).not.toBeNull();
  });
});
