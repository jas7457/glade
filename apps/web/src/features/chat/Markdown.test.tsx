import { describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/preact";
import { Markdown, fenced } from "./Markdown";

// jsdom has no layout APIs; Streamdown scrolls code blocks while streaming.
Element.prototype.scrollTo ??= function () {};

describe("Markdown", () => {
  it("renders headings, lists and links (links open in a new tab)", async () => {
    const { container } = render(<Markdown text={"# Title\n\n- one\n- two\n\nSee [docs](https://example.com)."} />);
    await waitFor(() => expect(container.querySelector("h1")?.textContent).toBe("Title"));
    expect(container.querySelectorAll("li")).toHaveLength(2);
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toMatch(/^https:\/\/example\.com\/?$/);
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("renders a partial code fence while streaming without crashing", async () => {
    const { container, rerender } = render(<Markdown streaming text={"Here:\n\n```ts\nconst a = 1;\nconst b"} />);
    await waitFor(() => expect(container.textContent).toContain("const a = 1;"));
    rerender(<Markdown streaming text={"Here:\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nDone **bo"} />);
    await waitFor(() => expect(container.textContent).toContain("const b = 2;"));
    expect(container.textContent).toContain("Done");
    expect(container.textContent).not.toContain("**");
  });

  it("renders a copy button on code blocks", async () => {
    const { container } = render(<Markdown text={"```js\nlet x = 1\n```"} />);
    await waitFor(() => expect(container.querySelector('[data-streamdown="code-block-copy-button"]')).not.toBeNull());
  });
});

describe("fenced", () => {
  it("uses a fence longer than any backtick run in the source", () => {
    expect(fenced("a ``` b", "md")).toBe("````md\na ``` b\n````");
    expect(fenced("plain\n")).toBe("```\nplain\n```");
  });
});
