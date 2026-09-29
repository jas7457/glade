import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/preact";
import { RouterProvider, createMemoryRouter } from "react-router";
import { ConnectScreen } from "./ConnectScreen";

function renderConnect() {
  const router = createMemoryRouter([{ path: "/connect", element: <ConnectScreen /> }], { initialEntries: ["/connect"] });
  return render(<RouterProvider router={router} />);
}

describe("ConnectScreen", () => {
  it("offers scan, paste and code on first run", () => {
    renderConnect();
    expect(screen.getByText("Connect to a Device")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Scan QR Code/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Paste Link/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Enter Code/ })).toBeTruthy();
  });

  it("Enter Code asks for the code and the address", () => {
    renderConnect();
    fireEvent.click(screen.getByRole("button", { name: /Enter Code/ }));
    expect(screen.getByLabelText("Pairing code")).toBeTruthy();
    expect(screen.getByLabelText("Address")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
