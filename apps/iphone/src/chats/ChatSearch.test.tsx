import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { MemoryRouter } from "react-router";
import type { AskMatch, SearchHit } from "@glade/protocol";
import { pendingJump } from "@glade/app-core/features/chat/jump-to-message";
import { connections, type EnvHandle } from "@glade/app-core/state/env-registry";
import { savedEnvironments } from "@glade/app-core/state/saved-environments";
import { projects, workspaces } from "@glade/app-core/state/store";
import { closedProjects } from "@glade/app-core/state/ui";
import { makeProject, makeWorkspace } from "@glade/app-core/test/fixtures";
import { fakeEnv } from "~/test/fake-env";
import { ChatList } from "./ChatList";
import { mergeHits, mergePicks, type AskPick, type ContentHit } from "./chat-search";

function hit(o: Partial<SearchHit> & { sessionId: string; workspaceId: string }): SearchHit {
  return {
    sessionKind: "main",
    title: "",
    workspaceTitle: "",
    projectId: null,
    project: null,
    snippet: { text: "…the flaky test…", highlights: [[5, 10]] },
    matchedIn: "assistant",
    score: 1,
    updatedAt: 0,
    ...o,
  };
}

function match(o: Partial<AskMatch> & { sessionId: string; workspaceId: string }): AskMatch {
  return { sessionKind: "main", title: "", project: null, summary: null, reason: "", updatedAt: 0, ...o };
}

type Handler = (method: string, path: string, body?: unknown) => unknown;

/** A connected Mac whose requests go to `handler` (a thrown/rejected value = unreachable). */
function mac(id: string, name: string, handler: Handler): EnvHandle {
  const env = fakeEnv(id, name);
  const request = vi.fn(async (method: string, path: string, body?: unknown) => handler(method, path, body));
  return { ...env, request: request as unknown as EnvHandle["request"] };
}

describe("merging results from several Macs", () => {
  const h = (envId: string, sessionId: string, o: Partial<SearchHit> = {}): ContentHit => ({ ...hit({ sessionId, workspaceId: `w-${sessionId}`, ...o }), envId });
  it("interleaves the Macs, drops title hits, unknown chats and duplicates", () => {
    const merged = mergeHits(
      [
        [h("a", "1"), h("a", "2", { matchedIn: "title" }), h("a", "3")],
        [h("b", "4"), h("b", "1"), h("b", "gone")],
      ],
      (w) => w !== "w-gone",
    );
    expect(merged.map((x) => x.sessionId)).toEqual(["1", "4", "3"]);
    expect(mergeHits([[h("a", "1"), h("a", "2")]], () => true, 1)).toHaveLength(1);
  });

  it("returns null for picks only when every Mac failed", () => {
    const p = (sessionId: string): AskPick => ({ ...match({ sessionId, workspaceId: "w" }), envId: "a" });
    expect(mergePicks([null, null], () => true)).toBeNull();
    expect(mergePicks([null, [p("1"), p("1")]], () => true)?.map((x) => x.sessionId)).toEqual(["1"]);
    expect(mergePicks([[p("1")], [p("2")]], () => false)).toEqual([]);
  });
});

describe("iPhone chat list: searching inside chats and Ask (I-167)", () => {
  beforeEach(() => {
    closedProjects.value = new Set();
    pendingJump.value = null;
    savedEnvironments.value = [
      { id: "m1", name: "Studio", urls: ["http://m1.test:4327"], token: "t" },
      { id: "m2", name: "Air", urls: ["http://m2.test:4327"], token: "t" },
    ];
    projects.value = [makeProject({ id: "p1", name: "Alpha", sortOrder: 0, environmentId: "m1" })];
    workspaces.value = [
      makeWorkspace({ id: "c1", projectId: "p1", title: "Fix the build", environmentId: "m1" }),
      makeWorkspace({ id: "c2", projectId: null, title: "Release notes", environmentId: "m2" }),
    ];
  });
  afterEach(() => {
    connections.value = [];
  });

  function renderList(query: string) {
    const onOpen = vi.fn();
    const onOpenSession = vi.fn();
    const utils = render(
      <MemoryRouter>
        <ChatList query={query} onOpen={onOpen} onOpenSession={onOpenSession} />
      </MemoryRouter>,
    );
    return { ...utils, onOpen, onOpenSession };
  }

  it("shows hits from every connected Mac with snippet and Mac name, and opens one at its message", async () => {
    const m1 = mac("m1", "Studio", (_m, path) =>
      path.startsWith("/search?") ? { query: "flaky", hits: [hit({ sessionId: "s1", workspaceId: "c1", title: "Fix the build", message: { role: "assistant", timestamp: 42 } })] } : undefined,
    );
    const m2 = mac("m2", "Air", (_m, path) => (path.startsWith("/search?") ? { query: "flaky", hits: [hit({ sessionId: "s2", workspaceId: "c2", title: "Release notes" })] } : undefined));
    const down = mac("m3", "Mini", () => {
      throw new Error("unreachable");
    });
    connections.value = [m1, m2, { ...down, status: fakeEnv("m3", "Mini", "offline").status }];
    const { container, onOpenSession } = renderList("flaky");
    // Titles don't match; the content search is on its way.
    expect(screen.getByText("Searching conversations…")).toBeTruthy();
    await waitFor(() => expect(container.querySelectorAll("[data-search-result=hit]")).toHaveLength(2));
    expect(m1.request).toHaveBeenCalledWith("GET", "/search?q=flaky&limit=12");
    expect(down.request).not.toHaveBeenCalled();
    const first = container.querySelector("[data-session-id=s1]") as HTMLElement;
    expect(first.textContent).toContain("…the flaky test…");
    expect(first.querySelector("b")?.textContent).toBe("flaky");
    expect(first.querySelector("[title=Studio]")).toBeTruthy();
    fireEvent.click(first);
    expect(onOpenSession).toHaveBeenCalledWith({ envId: "m1", workspaceId: "c1", sessionId: "s1", sessionKind: "main", message: { role: "assistant", timestamp: 42 } });
    expect(pendingJump.value).toMatchObject({ sessionId: "s1", message: { role: "assistant", timestamp: 42 } });
    expect(screen.queryByText(/No chats match/)).toBeNull();
  });

  it("waits for a pause in typing and ignores stale answers", async () => {
    const seen: string[] = [];
    const m1 = mac("m1", "Studio", (_m, path) => {
      const q = new URLSearchParams(path.split("?")[1]).get("q")!;
      seen.push(q);
      return { query: q, hits: [hit({ sessionId: `s-${q}`, workspaceId: "c1" })] };
    });
    connections.value = [m1];
    const { container, rerender } = renderList("fl");
    for (const q of ["fla", "flak", "flaky"]) {
      rerender(
        <MemoryRouter>
          <ChatList query={q} onOpen={() => {}} />
        </MemoryRouter>,
      );
    }
    await waitFor(() => expect(container.querySelector("[data-session-id=s-flaky]")).toBeTruthy());
    expect(seen).toEqual(["flaky"]);
  });

  it("asks every connected Mac and lists the picks with their reasons", async () => {
    let answer!: () => void;
    const m1 = mac("m1", "Studio", (method, path) => {
      if (method === "GET") return { query: "", hits: [] };
      expect(path).toBe("/search/ask");
      return new Promise((resolve) => {
        answer = () => resolve({ query: "", matches: [match({ sessionId: "s1", workspaceId: "c1", title: "Fix the build", reason: "You fixed CI there." })], confident: true, model: "m" });
      });
    });
    const m2 = mac("m2", "Air", (method) => {
      if (method === "GET") return { query: "", hits: [] };
      throw new Error("offline");
    });
    connections.value = [m1, m2];
    const { container, onOpenSession } = renderList("where we fixed ci");
    fireEvent.click(container.querySelector("[data-ask]")!);
    expect(screen.getByText("Looking through your chats…")).toBeTruthy();
    expect(m1.request).toHaveBeenCalledWith("POST", "/search/ask", { query: "where we fixed ci", limit: 3 });
    expect(m2.request).toHaveBeenCalledWith("POST", "/search/ask", { query: "where we fixed ci", limit: 3 });
    answer();
    await waitFor(() => expect(screen.getByText("You fixed CI there.")).toBeTruthy());
    // The Mac that failed is skipped quietly.
    expect(screen.queryByText(/Couldn't ask/)).toBeNull();
    expect(screen.queryByText(/Matched by keywords/)).toBeNull();
    fireEvent.click(container.querySelector("[data-search-result=pick]")!);
    expect(onOpenSession).toHaveBeenCalledWith({ envId: "m1", workspaceId: "c1", sessionId: "s1", sessionKind: "main" });
  });

  it("says so when no Mac could answer, and resets when the query changes", async () => {
    const m1 = mac("m1", "Studio", (method) => {
      if (method === "GET") return { query: "", hits: [] };
      throw new Error("No fast model is set up");
    });
    connections.value = [m1];
    const { container, rerender } = renderList("the button chat");
    fireEvent.click(container.querySelector("[data-ask]")!);
    expect(await screen.findByText("Couldn't ask: No fast model is set up")).toBeTruthy();
    rerender(
      <MemoryRouter>
        <ChatList query="the button chat again" onOpen={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/Couldn't ask/)).toBeNull();
    expect(screen.getByText(/“the button chat again”/)).toBeTruthy();
  });

  it("notes when the picks are keyword matches (no model)", async () => {
    connections.value = [
      mac("m1", "Studio", (method) =>
        method === "GET" ? { query: "", hits: [] } : { query: "", matches: [match({ sessionId: "s1", workspaceId: "c1", title: "Fix the build" })], confident: false, model: null },
      ),
    ];
    const { container } = renderList("build fix");
    fireEvent.click(container.querySelector("[data-ask]")!);
    expect(await screen.findByText(/Matched by keywords/)).toBeTruthy();
    expect(container.querySelectorAll("[data-search-result=pick]")).toHaveLength(1);
  });

  it("only filters titles for one-letter queries", () => {
    const m1 = mac("m1", "Studio", () => ({ query: "", hits: [] }));
    connections.value = [m1];
    const { container } = renderList("f");
    expect(container.querySelector("[data-ask]")).toBeNull();
    expect(screen.queryByText("Searching conversations…")).toBeNull();
  });
});
