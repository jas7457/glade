/** I-150: the menu bar's "N chats working" / "N chats need you" open one of them, cycling. */
import { describe, expect, it } from "vitest";
import { makeWorkspace } from "@glade/app-core/test/fixtures";
import { pickChat } from "./menuBarActions";

describe("pickChat", () => {
  const list = [
    makeWorkspace({ id: "a", status: "working" }),
    makeWorkspace({ id: "b", status: "blocked" }),
    makeWorkspace({ id: "c", status: "working" }),
    makeWorkspace({ id: "d", status: "unread" }),
    makeWorkspace({ id: "r", status: "working", environmentId: "other-mac" }),
  ];

  it("opens the first working chat, then the next one after the chat on screen", () => {
    expect(pickChat(list, "working", null)?.id).toBe("a");
    expect(pickChat(list, "working", "a")?.id).toBe("c");
    expect(pickChat(list, "working", "c")?.id).toBe("a"); // wraps; the remote one doesn't count
    expect(pickChat(list, "working", "b")?.id).toBe("a");
  });

  it("needs you = waiting for input or unread", () => {
    expect(pickChat(list, "needs-you", null)?.id).toBe("b");
    expect(pickChat(list, "needs-you", "b")?.id).toBe("d");
    expect(pickChat([makeWorkspace({ id: "x" })], "needs-you", null)).toBeNull();
  });
});
