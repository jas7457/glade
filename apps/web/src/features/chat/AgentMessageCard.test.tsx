import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { agentOpenNote, formatAgentFinished, parseAgentMessage } from "@glade/protocol";
import { TooltipProvider } from "@/ui";
import { AgentMessageCard, agentPreview } from "./AgentMessageCard";

const summary = "## Summary\n\nImplemented **the parser**.\n\n- one\n- two\n\n```ts\nconst x = 1;\n```";
const note = agentOpenNote({ name: "harness-core", closing: false, userEngaged: false, keepOpenReason: null, idleMinutes: 10 });
const message = parseAgentMessage(formatAgentFinished("harness-core", summary, note))!;

function renderCard() {
  return render(
    <TooltipProvider>
      <AgentMessageCard message={message} />
    </TooltipProvider>,
  );
}

describe("agentPreview", () => {
  it("prefers the first line of prose, without Markdown syntax", () => {
    expect(agentPreview(summary)).toBe("Implemented the parser.");
    expect(agentPreview("## Only a heading")).toBe("Only a heading");
    expect(agentPreview("- see [the docs](https://x.dev) and `code`")).toBe("see the docs and code");
    expect(agentPreview("")).toBe("");
  });
});

describe("AgentMessageCard", () => {
  it("is one collapsed line: who, what, a preview", () => {
    const { container } = renderCard();
    const header = screen.getByRole("button", { expanded: false });
    expect(header.textContent).toContain("harness-core finished");
    expect(header.textContent).toContain("Implemented the parser.");
    expect(container.querySelector("[data-streamdown]")).toBeNull();
    expect(container.textContent).not.toContain("still open");
  });

  it("expands into Markdown with the note as a footnote, and copies the body", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = renderCard();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(container.querySelector("[data-streamdown=heading-2]")?.textContent).toBe("Summary");
    expect(container.querySelector("[data-streamdown=strong]")?.textContent).toBe("the parser");
    expect(container.querySelectorAll("[data-streamdown=list-item]")).toHaveLength(2);
    expect(container.textContent).toContain("harness-core is still open.");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(summary));
  });

  it("titles messages and exits", () => {
    render(<AgentMessageCard message={{ kind: "message", from: "dialogs", body: "Question?" }} />);
    expect(screen.getByRole("button").textContent).toContain("Message from dialogs");
    render(<AgentMessageCard message={{ kind: "exited", from: "tool-kinds", body: "Crashed." }} />);
    expect(screen.getAllByRole("button")[1]!.textContent).toContain("tool-kinds exited");
  });
});
