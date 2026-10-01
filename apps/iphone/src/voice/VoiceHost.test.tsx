import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { setVoiceEngine } from "./engine-provider";
import { createFakeVoiceEngine } from "./fake-engine";
import { VoiceHost } from "./VoiceHost";
import { closeVoiceMode, openVoiceMode, voiceMode } from "./voice-mode";

describe("VoiceHost: minimized (I-193)", () => {
  afterEach(() => {
    cleanup();
    closeVoiceMode();
    setVoiceEngine(null);
  });

  it("the chevron minimizes to a pill; the pill opens it again or ends it", async () => {
    setVoiceEngine(createFakeVoiceEngine({ wordMs: 0 }));
    act(() => openVoiceMode({ kind: "chat", sessionId: "s1" }));
    render(<VoiceHost />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(screen.queryByRole("dialog", { name: "Voice mode" })).toBeNull();
    expect(screen.getByTestId("voice-pill").textContent).toMatch(/^Voice· /);
    fireEvent.click(screen.getByRole("button", { name: "Open voice mode" }));
    expect(screen.getByRole("dialog", { name: "Voice mode" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    fireEvent.click(screen.getByRole("button", { name: "End voice mode" }));
    expect(voiceMode.value).toBeNull();
    expect(screen.queryByTestId("voice-pill")).toBeNull();
  });
});
