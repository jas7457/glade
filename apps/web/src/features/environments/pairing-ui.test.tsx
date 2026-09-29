/**
 * I-126 dialogs: the host's invite (QR, code, countdown, renew), the app-wide Allow/Deny confirm,
 * the devices list (revoke), and the client's connect dialog waiting for the host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import type { PairedDevice, PendingPairing, RemoteAccessState, TransportStatus } from "@glade/protocol";

vi.mock("@glade/app-core/lib/api-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@glade/app-core/lib/api-auth")>();
  return {
    ...actual,
    hostAuth: {
      getRemote: vi.fn(async () => ({ enabled: true, addresses: ["http://192.168.1.20:4327"] })),
      setRemote: vi.fn(async (enabled: boolean) => ({ enabled, addresses: ["http://192.168.1.20:4327"] })),
      setMaster: vi.fn(async (master: boolean) => ({ enabled: false, master, addresses: [] })),
      listPeers: vi.fn(async () => []),
      createInvite: vi.fn(),
      cancelInvite: vi.fn(async () => undefined),
      listPending: vi.fn(async () => []),
      answerPending: vi.fn(async () => undefined),
      listDevices: vi.fn(async () => []),
      renameDevice: vi.fn(),
      revokeDevice: vi.fn(async () => undefined),
      revokeAllDevices: vi.fn(async () => undefined),
      listAudit: vi.fn(async () => []),
      discover: vi.fn(async () => []),
    },
  };
});
vi.mock("@glade/app-core/lib/socket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@glade/app-core/lib/socket")>();
  return { ...actual, socket: { onMessage: () => () => {}, onOpen: () => () => {}, watch: () => () => {}, send: () => {} } };
});

import { hostAuth } from "@glade/app-core/lib/api-auth";
import { ConfirmHost, TooltipProvider } from "@glade/app-core/ui";
import { hostRemote, receiveHostMessage, resetRemoteHost } from "@glade/app-core/state/remote-host";
import { localEnvironmentId } from "@glade/app-core/state/env-registry";
import { remoteMaster, resetRemoteMaster } from "@glade/app-core/state/remote-master";
import { saveEnvironments } from "@glade/app-core/state/saved-environments";
import { RemoteAccessSettings } from "./RemoteAccessSettings";
import { AddDeviceDialog } from "./AddDeviceDialog";
import { PendingPairingHost } from "./PendingPairingHost";
import { ConnectEnvironmentDialog } from "./ConnectEnvironmentDialog";

const mocked = hostAuth as unknown as Record<keyof typeof hostAuth, ReturnType<typeof vi.fn>>;
const LINK = "glade://pair?v=1&e=ENV-B&n=Studio&u=http%3A%2F%2F192.168.1.20%3A4327&g=GRANT";

beforeEach(() => {
  resetRemoteHost();
  resetRemoteMaster();
  Object.values(mocked).forEach((fn) => fn.mockClear());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Add Device", () => {
  it("shows the QR code, the link, the code with the address and a countdown; renews when expired", async () => {
    hostRemote.value = { enabled: true, addresses: ["http://192.168.1.20:4327"] };
    mocked.createInvite
      .mockResolvedValueOnce({ link: LINK, code: "ABCD-EFGH", expiresAt: Date.now() - 1 })
      .mockResolvedValueOnce({ link: LINK, code: "JKMN-PQRS", expiresAt: Date.now() + 65_000 });
    const onOpenChange = vi.fn();
    render(<AddDeviceDialog open onOpenChange={onOpenChange} />);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("ABCD-EFGH");
    expect(within(dialog).getByText("This code expired.")).toBeTruthy();
    expect(within(dialog).getByRole("img", { name: /QR code/ }).querySelector("path")!.getAttribute("d")).toMatch(/^M4 4h7/); // finder pattern after the quiet zone
    fireEvent.click(within(dialog).getByRole("button", { name: "Create New Code" }));
    await within(dialog).findByText("JKMN-PQRS");
    expect(within(dialog).getByText(/Expires in 1:0[45]/)).toBeTruthy();
    expect(within(dialog).getByText("http://192.168.1.20:4327")).toBeTruthy();
    expect((within(dialog).getByLabelText("Pairing link") as HTMLInputElement).value).toBe(LINK);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(mocked.cancelInvite).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("Add Device follows its invite's use", () => {
  const request = (id: string, deviceName: string): PendingPairing => ({ id, deviceName, deviceKind: "mac", remoteAddress: "10.0.0.5", tailscaleLogin: null, requestedAt: Date.now() });

  it("Allow → Paired ✓ with Done", async () => {
    mocked.createInvite.mockResolvedValue({ link: LINK, code: "ABCD-EFGH", expiresAt: Date.now() + 60_000 });
    const onOpenChange = vi.fn();
    render(
      <>
        <AddDeviceDialog open onOpenChange={onOpenChange} />
        <PendingPairingHost />
      </>,
    );
    await screen.findByText("ABCD-EFGH");
    receiveHostMessage({ type: "pairing_pending", pending: [request("p9", "Studio Air")] });
    await screen.findByText(/“Studio Air” used this code\. Waiting for your answer…/);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    receiveHostMessage({ type: "pairing_pending", pending: [] });
    await screen.findByText(/Paired with/);
    expect(screen.getByText("Studio Air")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mocked.cancelInvite).not.toHaveBeenCalled();
  });

  it("Deny → the code is used up, Create New Code makes another", async () => {
    mocked.createInvite
      .mockResolvedValueOnce({ link: LINK, code: "ABCD-EFGH", expiresAt: Date.now() + 60_000 })
      .mockResolvedValueOnce({ link: LINK, code: "JKMN-PQRS", expiresAt: Date.now() + 60_000 });
    render(
      <>
        <AddDeviceDialog open onOpenChange={() => {}} />
        <PendingPairingHost />
      </>,
    );
    await screen.findByText("ABCD-EFGH");
    receiveHostMessage({ type: "pairing_pending", pending: [request("p8", "Stranger")] });
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await screen.findByText(/This code was used \(you denied “Stranger”\)/);
    fireEvent.click(screen.getByRole("button", { name: "Create New Code" }));
    await screen.findByText("JKMN-PQRS");
    expect(screen.getByText(/Expires in/)).toBeTruthy();
  });
});

describe("pending pairing confirm", () => {
  const pending = (id: string, name: string, requestedAt: number): PendingPairing => ({
    id,
    deviceName: name,
    deviceKind: "mac",
    remoteAddress: "192.168.1.30",
    tailscaleLogin: id === "p1" ? "jason@example.com" : null,
    requestedAt,
  });

  it("asks wherever the user is; Allow and Deny answer in order", async () => {
    render(<PendingPairingHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
    receiveHostMessage({ type: "batch", messages: [{ type: "pairing_pending", pending: [pending("p2", "iPad", 2), pending("p1", "Jason's MacBook Air", 1)] }] });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Allow “Jason's MacBook Air” to use this device?")).toBeTruthy();
    expect(within(dialog).getByText("jason@example.com")).toBeTruthy();
    expect(within(dialog).getByText("192.168.1.30")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow" }));
    expect(mocked.answerPending).toHaveBeenCalledWith("p1", true);
    const next = await screen.findByText("Allow “iPad” to use this device?");
    fireEvent.click(within(next.closest("[role=dialog]") as HTMLElement).getByRole("button", { name: "Deny" }));
    expect(mocked.answerPending).toHaveBeenCalledWith("p2", false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a code-free request (I-143) says who wants in and shows the number to compare", async () => {
    render(<PendingPairingHost />);
    receiveHostMessage({ type: "pairing_pending", pending: [{ ...pending("p1", "MacBook Air", 1), number: "0729" }] });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("“MacBook Air” wants to use this device")).toBeTruthy();
    expect(within(dialog).getByTestId("pair-number").textContent).toBe("0729");
    expect(within(dialog).getByText(/Allow only if MacBook Air shows the same number/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow" }));
    expect(mocked.answerPending).toHaveBeenCalledWith("p1", true);
  });

  it("closes when another window answered (the list shrank)", async () => {
    render(<PendingPairingHost />);
    receiveHostMessage({ type: "pairing_pending", pending: [pending("p1", "Air", 1)] });
    await screen.findByRole("dialog");
    receiveHostMessage({ type: "pairing_pending", pending: [] });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("devices list", () => {
  const device = (id: string, name: string, extra: Partial<PairedDevice> = {}): PairedDevice => ({
    id,
    name,
    kind: "mac",
    createdAt: 1,
    lastSeenAt: Date.now() - 5 * 60_000,
    lastAddress: "192.168.1.30",
    tailscaleLogin: null,
    scopes: ["full"],
    connected: false,
    ...extra,
  });

  it("shows last seen and revokes after a destructive confirm", async () => {
    mocked.listDevices.mockResolvedValue([device("d1", "MacBook Air", { connected: true }), device("d2", "Old Mac")]);
    mocked.getRemote.mockResolvedValue({ enabled: true, master: true, addresses: ["http://192.168.1.20:4327"] });
    remoteMaster.value = true;
    render(
      <TooltipProvider>
        <RemoteAccessSettings />
        <ConfirmHost />
      </TooltipProvider>,
    );
    await screen.findByText("MacBook Air");
    expect(screen.getByText(/Last seen now · 192\.168\.1\.30/)).toBeTruthy();
    expect(screen.getByText(/Last seen 5 min ago/)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("switch", { name: "Let other devices use this device" }) as HTMLElement).getAttribute("aria-checked")).toBe("true"));

    fireEvent.click(screen.getAllByRole("button", { name: "Revoke…" })[1]!);
    const alert = await screen.findByRole("alertdialog");
    expect(within(alert).getByText(/Old Mac/)).toBeTruthy();
    fireEvent.click(within(alert).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(mocked.revokeDevice).toHaveBeenCalledWith("d2"));
    await waitFor(() => expect(screen.queryByText("Old Mac")).toBeNull());
    expect(screen.getByRole("button", { name: /Share This Device/ })).toBeTruthy();
  });
});

describe("transport status (I-127)", () => {
  const transport = (extra: Partial<TransportStatus> = {}): TransportStatus => ({
    id: "tailscale",
    available: true,
    https: true,
    serving: false,
    dnsName: "studio.tail1234.ts.net",
    ips: ["100.100.1.1"],
    managed: true,
    ...extra,
  });
  const renderHost = async (state: RemoteAccessState) => {
    mocked.getRemote.mockResolvedValue({ master: true, ...state });
    remoteMaster.value = true;
    render(
      <TooltipProvider>
        <RemoteAccessSettings />
      </TooltipProvider>,
    );
    return (await screen.findByTestId("transport-status")).closest("div")!.parentElement!;
  };
  const hostSwitch = () => screen.getByRole("switch", { name: "Let other devices use this device" }) as HTMLElement;

  it("serving: Tailscale ✓ with the https address", async () => {
    const row = await renderHost({ enabled: true, addresses: ["https://studio.tail1234.ts.net"], transport: transport({ serving: true }) });
    expect(row.textContent).toMatch(/Reachable on your private tailnet/);
    expect(screen.getByText("https://studio.tail1234.ts.net")).toBeTruthy(); // under the sharing switch
    expect(within(row).getByLabelText("Available")).toBeTruthy();
    expect(hostSwitch().hasAttribute("disabled")).toBe(false);
  });

  it("HTTPS off: explains, links to the admin console, and the switch can't turn on", async () => {
    const row = await renderHost({ enabled: false, addresses: [], transport: transport({ available: false, https: false, problem: "https_off", reason: "HTTPS is off in your tailnet." }) });
    expect(row.textContent).toMatch(/HTTPS is off in your tailnet/);
    expect(within(row).getByRole("link", { name: "Open the admin console" }).getAttribute("href")).toBe("https://login.tailscale.com/admin/dns");
    await waitFor(() => expect(hostSwitch().hasAttribute("disabled")).toBe(true));
  });

  it("not installed: download link; signed out: fix-it text", async () => {
    const row = await renderHost({ enabled: false, addresses: [], transport: transport({ available: false, https: false, problem: "not_installed", dnsName: undefined }) });
    expect(within(row).getByRole("link", { name: "Download Tailscale" }).getAttribute("href")).toBe("https://tailscale.com/download");
    cleanup();
    const row2 = await renderHost({ enabled: false, addresses: [], transport: transport({ available: false, problem: "signed_out" }) });
    expect(row2.textContent).toMatch(/signed out\. Sign in from the Tailscale menu/);
  });

  it("an enabled switch can still be turned off when Tailscale broke meanwhile; a refused change is shown", async () => {
    await renderHost({ enabled: true, addresses: [], transport: transport({ available: false, problem: "stopped" }) });
    await waitFor(() => expect(hostSwitch().hasAttribute("disabled")).toBe(false));
    cleanup();
    mocked.setRemote.mockRejectedValueOnce(new Error("Couldn't start Tailscale Serve: boom"));
    await renderHost({ enabled: false, addresses: [], transport: transport() });
    fireEvent.click(hostSwitch());
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't start Tailscale Serve: boom");
    expect(hostSwitch().getAttribute("aria-checked")).toBe("false");
  });
});

describe("connect dialog", () => {
  const found = [
    { name: "Studio", address: "https://studio.tail1234.ts.net", environmentId: "ENV-B", reachable: true, os: "macOS" },
    { name: "iPhone", address: "https://iphone.tail1234.ts.net", reachable: false, os: "iOS" },
  ];
  /**
   * Answers GET /environment as Studio; the pair request waits (or answers with `pair`). A
   * code-free request (I-143) gets `tailnet` (default: refused, other account) and its wait `wait`.
   */
  const stubHost = (pair?: object, tailnet: object = { status: "refused", reason: "other_account" }, wait?: object) => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith("/environment")) return new Response(JSON.stringify({ id: "ENV-B", name: "Studio" }), { status: 200 });
        const body = init?.body ? (JSON.parse(String(init.body)) as { mode?: string }) : {};
        if (url.endsWith("/auth/pair") && body.mode === "tailnet") return new Response(JSON.stringify(tailnet), { status: 200 });
        if (url.endsWith("/auth/pair/wait") && wait) return new Response(JSON.stringify(wait), { status: 200 });
        if (url.endsWith("/auth/pair/wait")) return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
        if (pair) return new Response(JSON.stringify(pair), { status: 200 });
        return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }),
    );
    return calls;
  };
  afterEach(() => {
    cleanup();
    localEnvironmentId.value = null;
    saveEnvironments([]);
  });

  it("a typed code: the address field with the hint and the found devices as quick picks", async () => {
    mocked.discover.mockResolvedValue(found);
    render(<ConnectEnvironmentDialog open onOpenChange={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    // Nothing typed yet: no address, no target line.
    expect(within(dialog).queryByLabelText("Address")).toBeNull();
    expect(within(dialog).queryByTestId("connect-target")).toBeNull();
    fireEvent.input(within(dialog).getByLabelText("Pairing link or code"), { target: { value: "ABCD-EFGH" } });
    expect(within(dialog).getByLabelText("Address")).toBeTruthy();
    expect(within(dialog).getByText("The address shown on the other device under Share This Device.")).toBeTruthy();
    const list = await within(dialog).findByRole("list", { name: "Found on your tailnet" });
    expect(within(list).queryByText("iPhone")).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: /Studio/ }));
    expect((within(dialog).getByLabelText("Address") as HTMLInputElement).value).toBe("https://studio.tail1234.ts.net");
    expect(within(list).getByRole("button", { name: /Studio/ }).getAttribute("aria-pressed")).toBe("true");
    // No name field: the host is told this device's own name.
    expect(within(dialog).queryByLabelText(/Name of this device|Show this device as/)).toBeNull();
    mocked.discover.mockResolvedValue([]);
  });

  it("a found device on another Tailscale account: falls back to the code with a reason; the pair request sends this device's own name", async () => {
    localEnvironmentId.value = "ENV-A";
    const { connections } = await import("@glade/app-core/state/env-registry");
    const { EnvironmentConnection } = await import("@glade/app-core/state/environments");
    const local = new EnvironmentConnection("ENV-A", "http://127.0.0.1:1/api", true);
    local.info.value = { id: "ENV-A", name: "MacBook Air" } as never;
    connections.value = [local];
    const calls = stubHost();
    render(<ConnectEnvironmentDialog open onOpenChange={() => {}} initialAddress="https://studio.tail1234.ts.net" initialName="Studio" />);
    const dialog = await screen.findByRole("dialog");
    expect((await within(dialog).findByTestId("code-reason")).textContent).toBe("Studio uses a different Tailscale account, so it needs a code.");
    expect(within(dialog).getByTestId("connect-target").textContent).toBe("Connecting to Studio · studio.tail1234.ts.net");
    // The code is required now.
    expect(within(dialog).getByRole("button", { name: "Connect" }).hasAttribute("disabled")).toBe(true);
    fireEvent.input(within(dialog).getByLabelText("Pairing link or code"), { target: { value: "ABCD-EFGH" } });
    expect(within(dialog).queryByLabelText("Address")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    await within(dialog).findByText("Waiting for Studio to allow this device…");
    const pair = calls.find((c) => c.url.endsWith("/auth/pair") && !(c.body as { mode?: string }).mode)!;
    expect(pair.url).toBe("https://studio.tail1234.ts.net/api/auth/pair");
    expect(pair.body).toMatchObject({ grant: "ABCD-EFGH", deviceName: "MacBook Air", clientEnvironmentId: "ENV-A" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    connections.value = [];
  });

  it("a found device on your own tailnet (I-143): no code; shows the number the host shows; Allow pairs", async () => {
    localEnvironmentId.value = "ENV-A";
    const { pairingNumber } = await import("@glade/protocol");
    const paired = { status: "paired", token: "TOKEN", environmentId: "ENV-B", device: { id: "D1", name: "MacBook Air", kind: "mac", createdAt: 1, lastSeenAt: 1, lastAddress: null, tailscaleLogin: "me@example.com", scopes: ["full"], connected: false } };
    const calls = stubHost(undefined, { status: "confirm", requestId: "R1", hostNonce: "host-nonce-0123456789", expiresAt: Date.now() + 120_000 }, paired);
    // Hold the wait until the number was checked.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/pair/wait")) await gate;
      return inner(url, init);
    });
    const onOpenChange = vi.fn();
    render(<ConnectEnvironmentDialog open onOpenChange={onOpenChange} initialAddress="https://studio.tail1234.ts.net" initialName="Studio" />);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Check that Studio shows");
    const start = calls.find((c) => c.url.endsWith("/auth/pair"))!.body as { mode: string; clientNonce: string; deviceName: string };
    expect(start).toMatchObject({ mode: "tailnet", clientEnvironmentId: "ENV-A" });
    expect(start.clientNonce).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(within(dialog).getByTestId("pair-number").textContent).toBe(pairingNumber(start.clientNonce, "host-nonce-0123456789"));
    expect(within(dialog).queryByLabelText("Pairing link or code")).toBeNull();
    release();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(calls.find((c) => c.url.endsWith("/auth/pair/wait"))!.body).toEqual({ requestId: "R1", clientNonce: start.clientNonce });
    saveEnvironments([]);
  });

  it("code-free: Deny shows a clear message; Try Again asks again; Cancel falls back to the code field", async () => {
    stubHost(undefined, { status: "confirm", requestId: "R1", hostNonce: "host-nonce-0123456789", expiresAt: Date.now() + 120_000 }, { status: "denied" });
    render(<ConnectEnvironmentDialog open onOpenChange={() => {}} initialAddress="https://studio.tail1234.ts.net" initialName="Studio" />);
    const dialog = await screen.findByRole("dialog");
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Studio didn't allow this device.");
    cleanup();
    stubHost(undefined, { status: "confirm", requestId: "R1", hostNonce: "host-nonce-0123456789", expiresAt: Date.now() + 120_000 }, { status: "timeout" });
    render(<ConnectEnvironmentDialog open onOpenChange={() => {}} initialAddress="https://studio.tail1234.ts.net" initialName="Studio" />);
    const d2 = await screen.findByRole("dialog");
    expect((await within(d2).findByRole("alert")).textContent).toMatch(/Nobody answered on Studio in time/);
    cleanup();
    // Waiting forever: Cancel shows the code field; Connect with it empty asks without a code again.
    stubHost(undefined, { status: "confirm", requestId: "R1", hostNonce: "host-nonce-0123456789", expiresAt: Date.now() + 120_000 });
    render(<ConnectEnvironmentDialog open onOpenChange={() => {}} initialAddress="https://studio.tail1234.ts.net" initialName="Studio" />);
    const d3 = await screen.findByRole("dialog");
    await within(d3).findByTestId("pair-number");
    fireEvent.click(within(d3).getByRole("button", { name: "Cancel" }));
    await within(d3).findByLabelText("Pairing link or code");
    expect(within(d3).queryByTestId("code-reason")).toBeNull();
    fireEvent.click(within(d3).getByRole("button", { name: "Connect" }));
    await within(d3).findByTestId("pair-number");
    fireEvent.click(within(d3).getByRole("button", { name: "Cancel" }));
  });

  it("code-free: sharing off or no Tailscale identity falls back to the code with a reason; Pair Again on a LAN address goes straight to the code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/environment")) return new Response(JSON.stringify({ id: "ENV-B", name: "Studio" }), { status: 200 });
        return new Response(JSON.stringify({ code: "remote_disabled", error: "off" }), { status: 403 });
      }),
    );
    render(<ConnectEnvironmentDialog open onOpenChange={() => {}} initialAddress="https://studio.tail1234.ts.net" initialName="Studio" />);
    expect((await screen.findByTestId("code-reason")).textContent).toMatch(/Studio isn't sharing right now/);
    cleanup();
    stubHost(undefined, { status: "refused", reason: "no_identity" });
    render(<ConnectEnvironmentDialog open onOpenChange={() => {}} initialAddress="https://studio.tail1234.ts.net" initialName="Studio" />);
    expect((await screen.findByTestId("code-reason")).textContent).toBe("Studio can't see your Tailscale account on this connection, so it needs a code.");
    cleanup();
    const calls = stubHost();
    saveEnvironments([{ id: "ENV-B", name: "Studio", urls: ["http://192.168.1.20:4327"] }]);
    render(<ConnectEnvironmentDialog open onOpenChange={() => {}} envId="ENV-B" />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Pairing link or code")).toBeTruthy();
    expect(within(dialog).queryByTestId("code-reason")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("a pasted link: the target line from the link; waits for the host, and can cancel", async () => {
    localEnvironmentId.value = "ENV-A";
    stubHost();
    render(<ConnectEnvironmentDialog open onOpenChange={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.input(within(dialog).getByLabelText("Pairing link or code"), { target: { value: LINK } });
    expect(within(dialog).queryByLabelText("Address")).toBeNull(); // a link carries its address
    expect(within(dialog).getByTestId("connect-target").textContent).toBe("Connecting to Studio · 192.168.1.20:4327");
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    await within(dialog).findByText("Waiting for Studio to allow this device…");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await within(dialog).findByLabelText("Pairing link or code");
  });

  it("Pair Again: the saved device (by this device's name for it) is the target", async () => {
    saveEnvironments([{ id: "ENV-B", name: "Studio", alias: "Work Mac", urls: ["https://studio.tail1234.ts.net"] }]);
    // A Tailscale address: it asks without a code first (I-143); refused here, so the code it is.
    const calls = stubHost();
    render(<ConnectEnvironmentDialog open onOpenChange={() => {}} envId="ENV-B" />);
    const dialog = await screen.findByRole("dialog", { name: "Pair Again with Work Mac" });
    expect((await within(dialog).findByTestId("code-reason")).textContent).toBe("Work Mac uses a different Tailscale account, so it needs a code.");
    expect(calls.find((c) => c.url.endsWith("/auth/pair"))!.body).toMatchObject({ mode: "tailnet" });
    expect(within(dialog).getByTestId("connect-target").textContent).toBe("Connecting to Work Mac · studio.tail1234.ts.net");
    fireEvent.input(within(dialog).getByLabelText("Pairing link or code"), { target: { value: "ABCD-EFGH" } });
    expect(within(dialog).queryByLabelText("Address")).toBeNull();
  });

  it("Return in a field connects like the button", async () => {
    render(<ConnectEnvironmentDialog open onOpenChange={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.input(within(dialog).getByLabelText("Pairing link or code"), { target: { value: "ABCD-EFGH" } });
    fireEvent.keyDown(within(dialog).getByLabelText("Address"), { key: "Enter" });
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/address/); // submitted: asks for the address
  });

  it("explains a bad code before connecting", async () => {
    render(<ConnectEnvironmentDialog open onOpenChange={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.input(within(dialog).getByLabelText("Pairing link or code"), { target: { value: "ABCD" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/8-character code/);
  });
});

describe("/pair deep link", () => {
  it("opens Settings → Remote Access with the link filled in", async () => {
    const { MemoryRouter, Routes, Route } = await import("react-router");
    const { PairRoute } = await import("./PairRoute");
    const { pairDialogRequest } = await import("@glade/app-core/state/pairing");
    render(
      <MemoryRouter initialEntries={[`/pair?link=${encodeURIComponent(LINK)}`]}>
        <Routes>
          <Route path="/pair" element={<PairRoute />} />
          <Route path="/settings/:section" element={<div>settings page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText("settings page");
    expect(pairDialogRequest.value).toEqual({ link: LINK });
    pairDialogRequest.value = null;
  });
});

describe("connections (I-136)", () => {
  const device = (id: string, name: string, extra: Partial<PairedDevice> = {}): PairedDevice => ({
    id,
    name,
    kind: "mac",
    createdAt: 1,
    lastSeenAt: Date.now() - 60 * 60_000,
    lastAddress: null,
    tailscaleLogin: null,
    scopes: ["full"],
    connected: false,
    ...extra,
  });
  const renderSettings = async (remote: Partial<RemoteAccessState> = {}) => {
    mocked.getRemote.mockResolvedValue({ enabled: true, master: true, addresses: ["http://192.168.1.20:4327"], ...remote });
    remoteMaster.value = true;
    render(
      <TooltipProvider>
        <RemoteAccessSettings />
        <ConfirmHost />
      </TooltipProvider>,
    );
    await screen.findByText("Connections");
  };
  /** The row of a connection (its FormRow). */
  const row = (key: string) => document.querySelector(`[data-connection="${key}"]`)!.closest("label")!.parentElement!.parentElement as HTMLElement;
  const labels = (el: HTMLElement) => ["You use it", "Uses this device"].filter((l) => within(el).queryByText(l));
  const buttons = (el: HTMLElement) => within(el).queryAllByRole("button").map((b) => b.textContent);

  beforeEach(() => {
    saveEnvironments([]);
    mocked.listDevices.mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    saveEnvironments([]);
  });

  it("merges both directions by the pairing's environment id; actions follow each direction", async () => {
    saveEnvironments([
      { id: "ENV-S", name: "Studio", urls: ["https://studio.tail.ts.net"], token: "t" },
      { id: "ENV-P", name: "Pro", urls: ["https://pro.tail.ts.net"] },
    ]);
    mocked.listDevices.mockResolvedValue([device("d1", "Studio", { clientEnvironmentId: "ENV-S", connected: true }), device("d2", "iPad", { kind: "phone", clientEnvironmentId: null })]);
    await renderSettings();
    await waitFor(() => expect(document.querySelector('[data-connection="device:d2"]')).not.toBeNull());
    // One row per device: Studio (both), Pro (you use it), iPad (uses this device).
    expect([...document.querySelectorAll("[data-connection]")].map((e) => e.getAttribute("data-connection"))).toEqual(["ENV-S", "ENV-P", "device:d2"]);
    expect(labels(row("ENV-S"))).toEqual(["You use it", "Uses this device"]);
    expect(labels(row("ENV-P"))).toEqual(["You use it"]);
    expect(labels(row("device:d2"))).toEqual(["Uses this device"]);
    expect(buttons(row("ENV-S"))).toEqual(["Rename", "Disconnect…", "Revoke…"]);
    expect(buttons(row("ENV-P"))).toEqual(["Pair Again…", "Rename", "Disconnect…"]);
    expect(buttons(row("device:d2"))).toEqual(["Rename", "Revoke…"]);
    // Each direction's actions sit on that direction's own line.
    const line = (key: string, which: string) => [...row(key).querySelectorAll(`[data-actions="${which}"] button`)].map((b) => b.textContent);
    // One Rename per row (I-138): on the first line when it's two-way.
    expect(line("ENV-S", "uses")).toEqual(["Rename", "Disconnect…"]);
    expect(line("ENV-S", "used-by")).toEqual(["Revoke…"]);
    expect(within(row("ENV-S")).getByText("You use it").closest("[data-line]")!.querySelector('[data-actions="uses"]')).not.toBeNull();
    expect(within(row("ENV-S")).getByText("Uses this device").closest("[data-line]")!.querySelector('[data-actions="used-by"]')).not.toBeNull();
    expect(within(row("ENV-S")).getByLabelText("Connected")).toBeTruthy();
    expect(within(row("ENV-P")).getByTestId("environment-status").textContent).toBe("pro.tail.ts.net · Needs pairing");
    expect(within(row("device:d2")).getByTestId("device-status").textContent).toBe("Last seen 1 h ago");
  });

  it("revoking or disconnecting one direction keeps the other", async () => {
    saveEnvironments([{ id: "ENV-S", name: "Studio", urls: ["https://studio.tail.ts.net"], token: "t" }]);
    mocked.listDevices.mockResolvedValue([device("d1", "Studio", { clientEnvironmentId: "ENV-S" })]);
    await renderSettings();
    await waitFor(() => expect(labels(row("ENV-S"))).toEqual(["You use it", "Uses this device"]));

    fireEvent.click(within(row("ENV-S")).getByRole("button", { name: "Revoke…" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(mocked.revokeDevice).toHaveBeenCalledWith("d1"));
    mocked.listDevices.mockResolvedValue([]);
    await waitFor(() => expect(labels(row("ENV-S"))).toEqual(["You use it"]));

    // The other way round: disconnect, the device that uses this one stays.
    cleanup();
    mocked.listDevices.mockResolvedValue([device("d1", "Studio", { clientEnvironmentId: "ENV-S" })]);
    await renderSettings();
    await waitFor(() => expect(labels(row("ENV-S"))).toEqual(["You use it", "Uses this device"]));
    fireEvent.click(within(row("ENV-S")).getByRole("button", { name: "Disconnect…" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(document.querySelector('[data-connection="ENV-S"]')).toBeNull());
    expect(labels(row("device:d1"))).toEqual(["Uses this device"]);
  });

  it("sections in order: master, sharing, Tailscale, the two buttons, Connections, Recent activity", async () => {
    await renderSettings({ transport: { id: "tailscale", available: true, https: true, serving: true, dnsName: "air.tail.ts.net", ips: [], managed: true } });
    const order = [
      screen.getByRole("switch", { name: /Remote access/ }),
      await screen.findByRole("switch", { name: "Let other devices use this device" }),
      await screen.findByTestId("transport-status"),
      screen.getByRole("button", { name: /Connect to a Device/ }),
      screen.getByRole("button", { name: /Share This Device/ }),
      screen.getByText("No connections yet."),
      screen.getByText("Recent activity"),
    ];
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The address sits under the sharing switch while it's on.
    expect(screen.getByText("https://air.tail.ts.net")).toBeTruthy();
  });

  it("Share This Device… with sharing off offers to turn it on first", async () => {
    mocked.createInvite.mockResolvedValue({ link: LINK, code: "ABCD-EFGH", expiresAt: Date.now() + 60_000 });
    await renderSettings({ enabled: false });
    await waitFor(() => expect(screen.getByRole("switch", { name: "Let other devices use this device" }).hasAttribute("disabled")).toBe(false));

    // Cancel: nothing changes.
    fireEvent.click(screen.getByRole("button", { name: /Share This Device/ }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocked.setRemote).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();

    // Turn On: sharing goes on, then the invite opens.
    fireEvent.click(screen.getByRole("button", { name: /Share This Device/ }));
    const alert = await screen.findByRole("alertdialog");
    expect(within(alert).getByText("Turn on sharing?")).toBeTruthy();
    fireEvent.click(within(alert).getByRole("button", { name: "Turn On" }));
    await waitFor(() => expect(mocked.setRemote).toHaveBeenCalledWith(true));
    const dialog = await screen.findByRole("dialog", { name: "Share This Device" });
    await within(dialog).findByText("ABCD-EFGH");
  });

  it("Share This Device… with sharing on opens the invite at once", async () => {
    mocked.createInvite.mockResolvedValue({ link: LINK, code: "ABCD-EFGH", expiresAt: Date.now() + 60_000 });
    await renderSettings({ enabled: true });
    await waitFor(() => expect(screen.getByRole("switch", { name: "Let other devices use this device" }).getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: /Share This Device/ }));
    await screen.findByRole("dialog", { name: "Share This Device" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("one Rename names a two-way device on both sides; the row shows it", async () => {
    saveEnvironments([{ id: "ENV-S", name: "Studio", urls: ["https://studio.tail.ts.net"], token: "t" }]);
    mocked.listDevices.mockResolvedValue([device("d1", "Studio", { clientEnvironmentId: "ENV-S" })]);
    mocked.renameDevice.mockImplementation(async (id: string, name: string) => device(id, name, { clientEnvironmentId: "ENV-S" }));
    await renderSettings();
    await waitFor(() => expect(labels(row("ENV-S"))).toEqual(["You use it", "Uses this device"]));
    fireEvent.click(within(row("ENV-S")).getByRole("button", { name: "Rename" }));
    const field = within(row("ENV-S")).getByLabelText("Device name") as HTMLInputElement;
    fireEvent.input(field, { target: { value: "Work Mac" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(mocked.renameDevice).toHaveBeenCalledWith("d1", "Work Mac"));
    const { environmentAlias } = await import("@glade/app-core/state/saved-environments");
    await waitFor(() => expect(environmentAlias("ENV-S")).toBe("Work Mac"));
    expect(within(row("ENV-S")).getByText("Work Mac")).toBeTruthy();
  });

  it("tailnet devices refresh while shown, with a Refresh button", async () => {
    mocked.discover.mockResolvedValue([]);
    await renderSettings({ transport: { id: "tailscale", available: true, https: true, serving: true, dnsName: "air.tail.ts.net", ips: [], managed: true } });
    await screen.findByText("No other devices sharing Glade right now.");
    const before = mocked.discover.mock.calls.length;
    mocked.discover.mockResolvedValue([{ name: "Pro", address: "https://pro.tail.ts.net", environmentId: "ENV-P", reachable: true }]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("button", { name: "Connect…" });
    expect(mocked.discover.mock.calls.length).toBe(before + 1);
    expect(screen.getByText("pro.tail.ts.net · Found on your tailnet")).toBeTruthy();
    mocked.discover.mockResolvedValue([]);
  });
});
