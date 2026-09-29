/** The touch composer (I-164): ↩ is a new line on the iPhone, Send sends, holding Send offers steer / follow-up / Ask Aside; pickers as sheets. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/preact";
import type { ComponentChildren } from "preact";
import type { ModelInfo } from "@glade/protocol";
import { TooltipProvider } from "@/ui";
import { ComposerBox, SEND_LONG_PRESS_MS, type ComposerBoxProps } from "@/features/chat/Composer";
import { OptionSheetContext } from "@/features/chat/option-sheet";
import { SheetList } from "~/ui/SheetList";

const MODELS: ModelInfo[] = [
  { provider: "anthropic", id: "haiku", name: "Claude Haiku", thinkingLevels: ["off", "low", "high"], input: ["text", "image"] },
  { provider: "openai", id: "mini", name: "GPT Mini", thinkingLevels: ["off"], input: ["text"] },
];

let seq = 0;
function renderBox(overrides: Partial<ComposerBoxProps> = {}, sheets = true) {
  const onSend = vi.fn(async () => true);
  const props: ComposerBoxProps = {
    draftKey: `touch-${++seq}`,
    supportsImages: true,
    model: { provider: "anthropic", id: "haiku" },
    models: MODELS,
    onModelChange: vi.fn(),
    thinkingLevel: "low",
    thinkingLevels: ["off", "low", "high"],
    onThinkingChange: vi.fn(),
    onSend,
    ...overrides,
  };
  const wrap = (children: ComponentChildren) => (
    <TooltipProvider>{sheets ? <OptionSheetContext.Provider value={SheetList}>{children}</OptionSheetContext.Provider> : children}</TooltipProvider>
  );
  render(wrap(<ComposerBox {...props} />));
  return { onSend: props.onSend as typeof onSend, props };
}

const textarea = () => screen.getByLabelText("Message") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.input(textarea(), { target: { value: text } });

afterEach(() => {
  delete (window as { __GLADE_IPHONE__?: boolean }).__GLADE_IPHONE__;
  vi.useRealTimers();
});

describe("touch composer", () => {
  it("is a slim pill until focused or typed into, then grows with the pickers (like ChatGPT)", async () => {
    renderBox({ touch: true, autoFocus: false });
    const box = () => textarea().closest("[data-compact]")!;
    const pickersHidden = () => screen.getByRole("button", { name: "Model" }).parentElement!.className.includes("[&>*]:hidden");
    expect(box().getAttribute("data-compact")).toBe("true");
    expect(pickersHidden()).toBe(true);
    await act(async () => textarea().focus());
    expect(box().getAttribute("data-compact")).toBe("false");
    expect(pickersHidden()).toBe(false);
    // Blurred but with text: stays open.
    type("draft");
    await act(async () => textarea().blur());
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(box().getAttribute("data-compact")).toBe("false");
    // Empty and blurred: back to the pill, after a short delay (so a tap on a picker lands first).
    type("");
    await act(async () => textarea().focus());
    await act(async () => textarea().blur());
    expect(box().getAttribute("data-compact")).toBe("false");
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(box().getAttribute("data-compact")).toBe("true");
  });

  it("↩ doesn't send on the iPhone (a new line); the Send button sends", async () => {
    (window as { __GLADE_IPHONE__?: boolean }).__GLADE_IPHONE__ = true;
    const { onSend } = renderBox();
    type("hello");
    const enter = fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(enter).toBe(true); // not prevented: the browser inserts the new line
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Send" })));
    expect(onSend).toHaveBeenCalledWith("hello", [], [], "steer");
  });

  it("the desktop still sends on ↩", async () => {
    const { onSend } = renderBox({}, false);
    type("hello");
    await act(async () => void fireEvent.keyDown(textarea(), { key: "Enter" }));
    expect(onSend).toHaveBeenCalledWith("hello", [], [], "steer");
  });

  it("while running, Send steers and holding it offers follow-up and Ask Aside", async () => {
    vi.useFakeTimers();
    const askAside = vi.fn(async () => true);
    const { onSend } = renderBox({ touch: true, isRunning: true, onStop: vi.fn(), askAside });
    expect(screen.queryByRole("button", { name: "Ask aside" })).toBeNull(); // in the Send options instead
    expect(textarea().placeholder).toMatch(/hold Send/);
    type("later please");
    const send = screen.getByRole("button", { name: "Steer" });
    fireEvent.touchStart(send);
    act(() => void vi.advanceTimersByTime(SEND_LONG_PRESS_MS + 10));
    fireEvent.touchEnd(send);
    fireEvent.click(send); // the long press's trailing click doesn't send
    expect(onSend).not.toHaveBeenCalled();
    const sheet = screen.getByRole("dialog", { name: "Send" });
    expect(sheet.textContent).toContain("Ask Aside");
    await act(async () => void fireEvent.click(screen.getByRole("option", { name: /Send as Follow-up/ })));
    expect(onSend).toHaveBeenCalledWith("later please", [], [], "followUp");
    expect(screen.queryByRole("dialog", { name: "Send" })).toBeNull();
    expect(askAside).not.toHaveBeenCalled();
  });

  it("Ask Aside from the Send options", async () => {
    vi.useFakeTimers();
    const askAside = vi.fn(async () => true);
    const { onSend } = renderBox({ touch: true, isRunning: true, askAside });
    type("what's that file?");
    const send = screen.getByRole("button", { name: "Steer" });
    fireEvent.touchStart(send);
    act(() => void vi.advanceTimersByTime(SEND_LONG_PRESS_MS + 10));
    await act(async () => void fireEvent.click(screen.getByRole("option", { name: /Ask Aside/ })));
    expect(askAside).toHaveBeenCalledWith("what's that file?");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("a short tap while running steers", async () => {
    vi.useFakeTimers();
    const { onSend } = renderBox({ touch: true, isRunning: true });
    type("go left");
    const send = screen.getByRole("button", { name: "Steer" });
    fireEvent.touchStart(send);
    act(() => void vi.advanceTimersByTime(100));
    fireEvent.touchEnd(send);
    await act(async () => void fireEvent.click(send));
    expect(onSend).toHaveBeenCalledWith("go left", [], [], "steer");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the model and thinking pickers open as sheets", () => {
    const { props } = renderBox({ touch: true });
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const sheet = screen.getByRole("dialog", { name: "Model" });
    expect(sheet.textContent).toContain("anthropic");
    expect(screen.getByRole("option", { name: "Claude Haiku" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "GPT Mini" }));
    expect(props.onModelChange).toHaveBeenCalledWith({ provider: "openai", id: "mini" });
    expect(screen.queryByRole("dialog", { name: "Model" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Thinking level" }));
    fireEvent.click(screen.getByRole("option", { name: "High" }));
    expect(props.onThinkingChange).toHaveBeenCalledWith("high");
  });
});
