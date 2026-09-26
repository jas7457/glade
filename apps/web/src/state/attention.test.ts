import { describe, expect, it } from "vitest";
import { attentionCount, windowTitle, workingCount } from "./attention";
import { workspaces } from "./store";
import { makeWorkspace } from "@/test/fixtures";

describe("counts + window title", () => {
  it("counts attention and working workspaces", () => {
    workspaces.value = [
      makeWorkspace({ id: "1", status: "unread" }),
      makeWorkspace({ id: "2", status: "blocked" }),
      makeWorkspace({ id: "3", status: "working" }),
      makeWorkspace({ id: "4", status: "idle" }),
    ];
    expect(attentionCount.value).toBe(2);
    expect(workingCount.value).toBe(2);
  });
  it("formats the title", () => {
    expect(windowTitle(0)).toBe("pi-ui");
    expect(windowTitle(3)).toBe("(3) pi-ui");
    expect(windowTitle(1, "Fix bug")).toBe("(1) Fix bug — pi-ui");
  });
});
