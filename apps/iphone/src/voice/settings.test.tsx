import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { RouterProvider, createMemoryRouter } from "react-router";
import type { VoiceInfo } from "./engine";
import { setVoiceEngine } from "./engine-provider";
import { createFakeVoiceEngine, type FakeVoiceEngine } from "./fake-engine";
import { bestVoice, DEFAULT_PAUSE_MS, groupVoices, pauseBeforeSending, reloadVoiceSettings, resolveVoice, setPauseBeforeSending, setSpeakingRate, setVoiceChoice, speakingRate, voiceChoice } from "./settings";
import { PREVIEW_TEXT, VoiceSettingsScreen } from "./VoiceSettingsScreen";

const v = (id: string, language: string, quality: VoiceInfo["quality"], extra: Partial<VoiceInfo> = {}): VoiceInfo => ({ id, name: id, language, quality, ...extra });

describe("voice choice", () => {
  const voices = [v("Samantha", "en-US", "default"), v("Evan", "en-US", "enhanced"), v("Serena", "en-GB", "premium"), v("Ava", "en-US", "premium"), v("Me", "en-US", "premium", { personal: true }), v("Anna", "de-DE", "premium")];

  it("picks the best installed English voice: Premium > Enhanced > default, the exact locale first", () => {
    expect(bestVoice(voices, "en-US")?.id).toBe("Ava");
    expect(bestVoice(voices, "en-GB")?.id).toBe("Serena");
    expect(bestVoice(voices.filter((x) => x.quality !== "premium"), "en-US")?.id).toBe("Evan");
    expect(bestVoice([v("Anna", "de-DE", "premium")], "en-US")).toBeNull();
    expect(bestVoice([], "en-US")).toBeNull();
  });

  it("uses the chosen voice while it's installed", () => {
    expect(resolveVoice(voices, "Evan")?.id).toBe("Evan");
    expect(resolveVoice(voices, "gone")?.id).toBe(bestVoice(voices)?.id);
  });

  it("groups by quality, best first", () => {
    expect(groupVoices(voices, "en-US").map((g) => [g.quality, g.voices.map((x) => x.id)])).toEqual([
      ["premium", ["Ava", "Me", "Serena"]],
      ["enhanced", ["Evan"]],
      ["default", ["Samantha"]],
    ]);
  });

  it("is stored on the phone", () => {
    setVoiceChoice("Evan");
    setSpeakingRate(1.5);
    voiceChoice.value = null;
    reloadVoiceSettings();
    expect(voiceChoice.value).toBe("Evan");
    expect(speakingRate.value).toBe(1.5);
    setSpeakingRate(9);
    expect(speakingRate.value).toBe(2);
  });

  it("the pause before sending (I-193): 1.6 s by default, 0.8 … 3 s in steps, stored", () => {
    localStorage.clear();
    reloadVoiceSettings();
    expect(pauseBeforeSending.value).toBe(DEFAULT_PAUSE_MS);
    expect(DEFAULT_PAUSE_MS).toBe(1600);
    setPauseBeforeSending(2390);
    expect(pauseBeforeSending.value).toBe(2400);
    setPauseBeforeSending(100);
    expect(pauseBeforeSending.value).toBe(800);
    setPauseBeforeSending(9000);
    reloadVoiceSettings();
    expect(pauseBeforeSending.value).toBe(3000);
    localStorage.setItem("glade.iphone.voice", JSON.stringify({ pauseMs: "x" }));
    reloadVoiceSettings();
    expect(pauseBeforeSending.value).toBe(1600);
  });
});

describe("Settings → Voice", () => {
  let engine: FakeVoiceEngine;
  beforeEach(() => {
    localStorage.clear();
    reloadVoiceSettings();
    engine = createFakeVoiceEngine({ wordMs: 0 });
    setVoiceEngine(engine);
  });
  afterEach(() => {
    cleanup();
    setVoiceEngine(null);
  });

  async function renderScreen() {
    const router = createMemoryRouter([{ path: "/settings/voice", element: <VoiceSettingsScreen /> }, { path: "*", element: <div /> }], { initialEntries: ["/settings/voice"] });
    render(<RouterProvider router={router} />);
    await act(async () => {});
  }

  it("Automatic (the best voice) is preselected; picking a voice previews and stores it", async () => {
    await renderScreen();
    expect(screen.getByText(/The best installed voice: Serena \(Premium\)/)).toBeTruthy();
    expect(screen.getByText(/Download better voices in iOS Settings → Accessibility → Spoken Content → Voices/)).toBeTruthy();
    expect(screen.getByText("Enhanced")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Evan/ }));
    expect(voiceChoice.value).toBe("com.apple.voice.enhanced.en-US.Evan");
    const speak = engine.calls.filter((c) => c.method === "speak").at(-1)!;
    expect(speak.args[0]).toBe(PREVIEW_TEXT);
    expect(speak.args[1]).toMatchObject({ voiceId: "com.apple.voice.enhanced.en-US.Evan", rate: 1 });
  });

  it("Preview and the speaking rate", async () => {
    await renderScreen();
    fireEvent.input(screen.getByLabelText("Speaking rate"), { target: { value: "1.25" } });
    expect(speakingRate.value).toBe(1.25);
    expect(screen.getByTestId("rate-value").textContent).toBe("1.25×");
    fireEvent.click(screen.getByRole("button", { name: /^Preview/ }));
    expect(engine.speaking).toBe(PREVIEW_TEXT);
    expect(engine.calls.filter((c) => c.method === "speak").at(-1)!.args[1]).toMatchObject({ rate: 1.25 });
    fireEvent.click(screen.getByRole("button", { name: /Stop Preview/ }));
    await act(async () => {});
    expect(engine.speaking).toBeNull();
  });

  it("Pause Before Sending: a slider with the value and an explanation", async () => {
    await renderScreen();
    expect(screen.getByTestId("pause-value").textContent).toBe("1.6 seconds");
    expect(screen.getByText(/How long you can pause before what you said is sent/)).toBeTruthy();
    fireEvent.input(screen.getByLabelText("Pause before sending"), { target: { value: "2200" } });
    expect(pauseBeforeSending.value).toBe(2200);
    expect(screen.getByTestId("pause-value").textContent).toBe("2.2 seconds");
  });
});
