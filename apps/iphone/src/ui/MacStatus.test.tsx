import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import { connections } from "@glade/app-core/state/env-registry";
import { savedEnvironments } from "@glade/app-core/state/saved-environments";
import { macStatusHint, macStatusShort, macStatusTitle } from "~/lib/mac-status";
import { fakeEnv } from "~/test/fake-env";
import { MacStatusNotice, MacStatusRow } from "./MacStatus";

describe("an unreachable Mac on the iPhone (I-170)", () => {
  beforeEach(() => {
    savedEnvironments.value = [{ id: "m1", name: "Studio", urls: ["https://studio.test"], token: "t" }];
  });

  it("words: never 'offline' (no peer list on the phone), always something to check", () => {
    expect(macStatusTitle("unreachable", "Studio")).toBe("Can't reach Studio");
    expect(macStatusTitle("host-offline", "Studio")).toBe("Can't reach Studio");
    expect(macStatusTitle("connecting", "Studio")).toBe("Connecting to Studio…");
    expect(macStatusHint("unreachable", "Studio")).toBe("Make sure it's awake with Glade open, and Tailscale is on on both.");
    expect(macStatusHint("remote-disabled", "Studio")).toContain("Remote Access");
    expect(macStatusHint("connected", "Studio")).toBeNull();
    expect(macStatusShort("unreachable")).toBe("Can't reach");
  });

  it("the row opens the device; Retry reconnects now", () => {
    const studio = fakeEnv("m1", "Studio", "offline");
    const retry = vi.fn();
    studio.retry = retry;
    connections.value = [studio];
    const onOpen = vi.fn();
    render(<MacStatusRow envId="m1" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /Can't reach Studio/ }));
    expect(onOpen).toHaveBeenCalledWith("m1");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("renders nothing while connected; no Retry while connecting or needing pairing", () => {
    connections.value = [fakeEnv("m1", "Studio")];
    const { container, rerender } = render(<MacStatusNotice envId="m1" />);
    expect(container.textContent).toBe("");
    connections.value = [fakeEnv("m1", "Studio", "connecting")];
    rerender(<MacStatusNotice envId="m1" />);
    expect(container.textContent).toContain("Connecting to Studio…");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    connections.value = [fakeEnv("m1", "Studio", "needs-pairing")];
    rerender(<MacStatusNotice envId="m1" />);
    expect(container.textContent).toContain("pair again");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
