/** I-147: the "Keeping this device awake" line and the `power` push. */
import { afterEach, describe, expect, it } from "vitest";
import type { PowerStatus } from "@glade/protocol";
import { powerStatus, powerStatusText, receivePowerMessage, resetPower } from "./power";

const status = (over: Partial<PowerStatus>): PowerStatus => ({ reasons: [], text: "", held: false, canHold: true, powerSource: null, sharedSkipped: null, ...over });

afterEach(resetPower);

describe("power status", () => {
  it("says why the Mac is kept awake", () => {
    expect(powerStatusText(null)).toBeNull();
    expect(powerStatusText(status({}))).toBeNull();
    expect(powerStatusText(status({ reasons: [{ kind: "working", chats: 2 }], text: "2 chats are working", held: true }))).toBe(
      "Keeping this device awake: 2 chats are working.",
    );
    expect(powerStatusText(status({ sharedSkipped: "battery" }))).toMatch(/on battery power/);
  });

  it("a web-only server only would", () => {
    expect(powerStatusText(status({ reasons: [{ kind: "working", chats: 1 }], text: "a chat is working", canHold: false }))).toMatch(
      /^A chat is working\. Only the Glade app keeps this device awake/,
    );
  });

  it("follows pushes, also inside batches", () => {
    const next = status({ reasons: [{ kind: "shared", devices: ["iPhone"] }], text: "iPhone is connected", held: true });
    receivePowerMessage({ type: "batch", messages: [{ type: "power", power: next }] });
    expect(powerStatus.value).toEqual(next);
  });
});
