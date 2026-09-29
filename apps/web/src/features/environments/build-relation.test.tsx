/** I-149: Connections says when a device you use runs an older or newer Glade than this one. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/preact";
import type { BuildComparison, BuildInfo } from "@glade/protocol";

const server = vi.hoisted(() => ({ comparisons: {} as Record<string, unknown> }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    request: vi.fn(async (_method: string, path: string) => {
      const commit = new URL(path, "http://x").searchParams.get("commit") ?? "";
      if (path.startsWith("/version/compare")) return server.comparisons[commit] ?? { commit, relation: "unknown" };
      throw new Error(`unexpected ${path}`);
    }),
  };
});
vi.mock("./use-discovery", () => ({ useDiscovery: () => ({ found: [], refreshing: false, refresh: () => {} }) }));

import { TooltipProvider } from "@/ui";
import { saveEnvironments } from "@/state/saved-environments";
import { versionStatus } from "@/state/version";
import { fakeEnv, resetEnvironmentsForTest, useEnvironments } from "@/test/env-fixtures";
import { Connections } from "./Connections";

const OURS: BuildInfo = { commit: "a".repeat(40), shortCommit: "aaaaaaa", builtAt: "2026-09-27T10:00:00.000Z", dirty: false, repoPath: "/src/glade", kind: "release" };
const build = (c: string, builtAt: string): BuildInfo => ({ ...OURS, commit: c.repeat(40), shortCommit: c.repeat(7), builtAt });

function setup(theirs: Record<string, BuildInfo | undefined>) {
  const remotes = Object.entries(theirs).map(([id, b]) => {
    const env = fakeEnv({ id, name: id });
    env.info.value = { ...env.info.value!, build: b };
    return env;
  });
  useEnvironments(...remotes);
  saveEnvironments(Object.keys(theirs).map((id) => ({ id, name: id, urls: [`https://${id.toLowerCase()}.tail.ts.net`], token: "t" })));
  versionStatus.value = { build: OURS, check: null, checking: false };
  render(
    <TooltipProvider>
      <Connections onConnect={() => {}} />
    </TooltipProvider>,
  );
}
const line = (key: string) => document.querySelector(`[data-connection="${key}"]`)!.closest("label")!.parentElement!.querySelector('[data-testid="build-relation"]');

beforeEach(() => {
  server.comparisons = {};
});
afterEach(() => {
  cleanup();
  saveEnvironments([]);
  versionStatus.value = null;
  resetEnvironmentsForTest();
});

describe("Connections: other devices' builds", () => {
  it("counts commits when this device's repo can, else compares build times; same build says nothing", async () => {
    const older = build("b", "2026-09-20T10:00:00.000Z");
    const newer = build("c", "2026-09-28T10:00:00.000Z");
    server.comparisons[older.commit] = { commit: older.commit, relation: "older", count: 3 } satisfies BuildComparison;
    setup({ OLD: older, NEW: newer, SAME: { ...OURS }, NONE: undefined });
    await waitFor(() => expect(line("OLD")?.textContent).toBe("Running an older Glade (3 commits behind this device). Some features (e.g. quick pairing) need both devices updated."));
    expect(line("NEW")?.textContent).toMatch(/^Running a newer Glade\. /);
    expect(line("SAME")).toBeNull();
    expect(line("NONE")).toBeNull();
    expect(screen.getAllByTestId("build-relation")).toHaveLength(2);
  });
});
