import { describe, expect, it } from "vitest";
import { agentMessageText, isAgentMessage } from "../src/services/search/agent-text.js";

describe("search: delivered agent-teams texts (I-100, I-120)", () => {
  it("indexes old and new headers without the marker", () => {
    expect(agentMessageText("[agent-teams] reviewer finished:\nok")).toBe("reviewer finished:\nok");
    expect(agentMessageText("[agent-teams] Leo (t3-research) finished:\nok")).toBe("Leo (t3-research) finished:\nok");
    expect(agentMessageText("[agent-teams] message from Leo (t3-research):\nhi")).toBe("message from Leo (t3-research):\nhi");
    expect(agentMessageText("[agent-teams] message from main:\nhi")).toBe("message from main:\nhi");
    expect(agentMessageText("hello")).toBeNull();
    expect(isAgentMessage({ role: "user", text: "[agent-teams] Leo 2 (x) exited:\ngone" })).toBe(true);
  });
});
