/**
 * I-126 dialogs: the host's invite (QR, code, countdown, renew), the app-wide Allow/Deny confirm,
 * the devices list (revoke), and the client's connect dialog waiting for the host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import type { PairedDevice, PendingPairing } from "@glade/protocol";

vi.mock("@/lib/api-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-auth")>();
  return {
    ...actual,
    hostAuth: {
      getRemote: vi.fn(async () => ({ enabled: true, addresses: ["http://192.168.1.20:4327"] })),
      setRemote: vi.fn(async (enabled: boolean) => ({ enabled, addresses: ["http://192.168.1.20:4327"] })),
      createInvite: vi.fn(),
      cancelInvite: vi.fn(async () => undefined),
      listPending: vi.fn(async () => []),
      answerPending: vi.fn(async () => undefined),
      listDevices: vi.fn(async () => []),
      renameDevice: vi.fn(),
      revokeDevice: vi.fn(async () => undefined),
      revokeAllDevices: vi.fn(async () => undefined),
      listAudit: vi.fn(async () => []),
    },
  };
});
vi.mock("@/lib/socket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/socket")>();
  return { ...actual, socket: { onMessage: () => () => {}, onOpen: () => () => {}, watch: () => () => {}, send: () => {} } };
});

import { hostAuth } from "@/lib/api-auth";
import { ConfirmHost, TooltipProvider } from "@/ui";
import { hostRemote, receiveHostMessage, resetRemoteHost } from "@/state/remote-host";
import { localEnvironmentId } from "@/state/env-registry";
import { AddDeviceDialog } from "./AddDeviceDialog";
import { PendingPairingHost } from "./PendingPairingHost";
import { HostRemoteAccess } from "./HostRemoteAccess";
import { ConnectEnvironmentDialog } from "./ConnectEnvironmentDialog";

const mocked = hostAuth as unknown as Record<keyof typeof hostAuth, ReturnType<typeof vi.fn>>;
const LINK = "glade://pair?v=1&e=ENV-B&n=Studio&u=http%3A%2F%2F192.168.1.20%3A4327&g=GRANT";

beforeEach(() => {
  resetRemoteHost();
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
    expect(within(dialog).getByText("Allow “Jason's MacBook Air” to use this Mac?")).toBeTruthy();
    expect(within(dialog).getByText("jason@example.com")).toBeTruthy();
    expect(within(dialog).getByText("192.168.1.30")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow" }));
    expect(mocked.answerPending).toHaveBeenCalledWith("p1", true);
    const next = await screen.findByText("Allow “iPad” to use this Mac?");
    fireEvent.click(within(next.closest("[role=dialog]") as HTMLElement).getByRole("button", { name: "Deny" }));
    expect(mocked.answerPending).toHaveBeenCalledWith("p2", false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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
    render(
      <TooltipProvider>
        <HostRemoteAccess />
        <ConfirmHost />
      </TooltipProvider>,
    );
    await screen.findByText("MacBook Air");
    expect(screen.getByText(/Last seen now · 192\.168\.1\.30/)).toBeTruthy();
    expect(screen.getByText(/Last seen 5 min ago/)).toBeTruthy();
    expect((screen.getByRole("switch", { name: "Allow other devices to connect" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getAllByRole("button", { name: "Revoke…" })[1]!);
    const alert = await screen.findByRole("alertdialog");
    expect(within(alert).getByText(/Old Mac/)).toBeTruthy();
    fireEvent.click(within(alert).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(mocked.revokeDevice).toHaveBeenCalledWith("d2"));
    await waitFor(() => expect(screen.queryByText("Old Mac")).toBeNull());
    expect(screen.getByRole("button", { name: /Add Device/ })).toBeTruthy();
  });
});

describe("connect dialog", () => {
  it("pastes a link, waits for the host, and can cancel", async () => {
    localEnvironmentId.value = "ENV-A";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/environment")) {
          return new Response(JSON.stringify({ id: "ENV-B", name: "Studio" }), { status: 200 });
        }
        return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }),
    );
    render(<ConnectEnvironmentDialog open onOpenChange={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.input(within(dialog).getByLabelText("Pairing link or code"), { target: { value: LINK } });
    expect(within(dialog).queryByLabelText("Address")).toBeNull(); // a link carries its address
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    await within(dialog).findByText("Waiting for Studio to allow this device…");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await within(dialog).findByLabelText("Pairing link or code");
  });

  it("Return in a field connects like the button", async () => {
    render(<ConnectEnvironmentDialog open onOpenChange={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.input(within(dialog).getByLabelText("Pairing link or code"), { target: { value: "ABCD-EFGH" } });
    fireEvent.keyDown(within(dialog).getByLabelText("Name of this device"), { key: "Enter" });
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
    const { pairDialogRequest } = await import("@/state/pairing");
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
