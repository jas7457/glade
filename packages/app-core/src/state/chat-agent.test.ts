/** I-176: which agent to name on a chat (desktop badge + iPhone title line). */
import { beforeEach, describe, expect, it } from "vitest";
import type { HarnessCapabilities, HarnessInfo } from "@glade/protocol";
import { makeSession } from "@glade/app-core/test/fixtures";
import { chatAgentOf } from "./chat-agent";
import { harnesses } from "./harnesses";
import { sessions } from "./store";

const caps = {} as HarnessCapabilities;
const pi: HarnessInfo = { id: "pi", label: "pi", isDefault: true, capabilities: caps };
const claude: HarnessInfo = { id: "claude", label: "Claude Code", isDefault: false, capabilities: caps };
const acp: HarnessInfo = { id: "acp-fake", label: "Fake ACP", isDefault: false, capabilities: caps };

const chatOn = (harness: string) => {
  sessions.value = [makeSession({ id: "s", harness })];
  return chatAgentOf("s");
};

beforeEach(() => {
  harnesses.value = null;
  sessions.value = [];
});

describe("chatAgentOf", () => {
  it("nothing until the agents have loaded, or for unknown chats", () => {
    expect(chatOn("pi")).toBeNull();
    harnesses.value = [pi, claude];
    expect(chatAgentOf("nope")).toBeNull();
  });

  it("with two or more agents, names every chat's, the default one included", () => {
    harnesses.value = [pi, claude];
    expect(chatOn("pi")).toEqual({ id: "pi", label: "pi", title: "Runs on pi", installed: true });
    expect(chatOn("claude")).toMatchObject({ label: "Claude Code", title: "Runs on Claude Code" });
  });

  it("with one agent, nothing for its chats", () => {
    harnesses.value = [pi];
    expect(chatOn("pi")).toBeNull();
  });

  it("a chat on an agent that isn't offered is still named, even with one agent", () => {
    harnesses.value = [pi];
    expect(chatOn("claude")).toEqual({ id: "claude", label: "claude", title: "Runs on claude, which isn't installed", installed: false });
  });

  it("ACP agents say so in the tooltip", () => {
    harnesses.value = [pi, acp];
    expect(chatOn("acp-fake")?.title).toBe("Runs on Fake ACP (ACP)");
  });
});
