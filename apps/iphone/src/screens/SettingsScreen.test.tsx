import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import { RouterProvider, createMemoryRouter } from "react-router";
import { connections } from "@/state/env-registry";
import { savedEnvironments } from "@/state/saved-environments";
import { paths } from "~/app/routes";
import { phoneTheme } from "~/state/theme";
import { fakeEnv } from "~/test/fake-env";
import { DeviceScreen } from "./DeviceScreen";
import { SettingsScreen } from "./SettingsScreen";

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: "/settings", element: <SettingsScreen /> },
      { path: "/settings/devices/:envId", element: <DeviceScreen /> },
      { path: "*", element: <div>elsewhere</div> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("iPhone settings", () => {
  beforeEach(() => {
    const studio = fakeEnv("m1", "Studio");
    studio.shell.harnesses.value = [{ id: "pi", label: "pi", isDefault: true, capabilities: {} as never }];
    studio.shell.models.value = [{ provider: "anthropic", id: "sonnet", name: "Claude Sonnet", thinkingLevels: ["off"], input: ["text"] }];
    studio.shell.settings.value = { ...studio.shell.settings.value, models: { ...studio.shell.settings.value.models, defaultModel: { provider: "anthropic", id: "sonnet" } } };
    connections.value = [studio, fakeEnv("m2", "Air", "needs-pairing")];
    savedEnvironments.value = [
      { id: "m1", name: "Studio", urls: ["http://m1.test:4327"], token: "t" },
      { id: "m2", name: "Air", urls: ["http://m2.test:4327"], token: "t" },
    ];
    phoneTheme.value = "system";
  });

  it("lists the paired Macs with their status, the theme and the version", () => {
    const router = renderAt(paths.settings());
    expect(screen.getByRole("button", { name: /Studio\s*Connected/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Air\s*Needs pairing/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(phoneTheme.value).toBe("dark");
    expect(screen.getByText(/^Version /)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect to a Device…" }));
    expect(router.state.location.pathname).toBe(paths.connect());
  });

  it("shows a Mac's AI settings read-only", () => {
    renderAt(paths.device("m1"));
    expect(screen.getByText("pi")).toBeTruthy();
    expect(screen.getAllByText("Claude Sonnet").length).toBeGreaterThan(0);
    expect(screen.getByText(/View only/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pair Again/ })).toBeNull();
  });

  it("renames a Mac for this iPhone only", () => {
    renderAt(paths.device("m1"));
    fireEvent.click(screen.getByRole("button", { name: /^Name/ }));
    fireEvent.input(screen.getByLabelText("Device name"), { target: { value: "Desk Mac" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(savedEnvironments.value.find((e) => e.id === "m1")?.alias).toBe("Desk Mac");
    expect(screen.getByRole("button", { name: /^Name\s*Desk Mac/ })).toBeTruthy();
  });

  it("disconnects after confirming, then returns to Settings", () => {
    const router = renderAt(paths.device("m1"));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect…" }));
    expect(savedEnvironments.value).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(savedEnvironments.value.map((e) => e.id)).toEqual(["m2"]);
    expect(router.state.location.pathname).toBe(paths.settings());
  });

  it("offers Pair Again when the Mac refused this iPhone", () => {
    const router = renderAt(paths.device("m2"));
    fireEvent.click(screen.getByRole("button", { name: "Pair Again…" }));
    expect(router.state.location.pathname).toBe(paths.connect());
  });
});
