---
name: issue-queue
description: Collect issues, bugs and requests the user reports into the Glade Inbox in PLAN.md WITHOUT starting work, across any number of messages or chats; then, only when the user says "go", split the queued items into parallel sub-agent workstreams, integrate, verify, tick them off and commit. Use whenever the user lists problems/ideas for Glade (formerly pi-ui), asks what's queued, or says go/start/work the queue.
---

# Issue queue: collect now, work later

The user reports issues in batches, often across several messages or separate chats. Your job
has two strictly separate modes. **Never mix them**: reporting an issue is not permission to
fix it.

The durable queue is the `## Inbox` section at the top of `PLAN.md` (repo root). It is the only
state that survives between chats, so everything goes there immediately.

## Mode 1 — Intake (default)

Triggered by the user describing problems, bugs, annoyances, or feature ideas.

1. **Read `PLAN.md`** to get the next free id and to spot duplicates. Ids are `I-001`, `I-002`, …
   and are never reused.
2. **Investigate lightly, don't fix.** You may read code, run the app, or take screenshots to pin
   down *where* the problem is (files, components, likely cause) so the item is actionable later.
   Do not edit source code, do not spawn workers, do not commit code.
3. **Append one entry per distinct issue** to the Inbox (split compound reports; merge
   duplicates into the existing item and mention it). Format:

   ```markdown
   - [ ] **I-007** Short imperative title — `area`
     - Reported: 2026-09-26 — what the user wants and why, in your own words (see below)
     - Notes: what you found (files, repro, suspected cause), acceptance criteria if obvious.
     - Open question: … (only if something truly blocks the work)
   ```

   **Record intent, never quotes** (user decision, 2026-10-05; the repo is going public). Don't
   copy the user's words into PLAN.md (or any other file): they often dictate and ramble. Write
   what they want, why, and any constraints or decisions they stated, clearly and completely enough
   that an agent can act on it without the chat. Keep every requirement and nuance; drop the
   filler. The same goes for answers and decisions: `Decided (user, 2026-10-05): <the decision>`,
   not a quote. Paths, names and personal details from the user's machine or other private projects
   don't belong in PLAN.md either.

   `area` is one of: `server`, `pi-adapter`, `protocol`, `shell` (app/, ui/, sidebar, projects),
   `chat` (features/chat), `settings`, `docs`, `infra`. Pick the one that owns most of the change.
4. **Reply briefly**: the ids + titles you added or updated, and any open questions. Then stop.
   Don't propose to start. The user will say when.
5. Commit the PLAN.md change only (`git commit -m "plan: queue I-007..I-009"`); no code.

Also in intake mode: "what's queued?" → summarize open Inbox items grouped by area.

**Future features.** When the user describes an idea they want documented but *not* planned ("for later",
"someday", "future feature"), add it to the `## Future features` section of PLAN.md instead of the Inbox,
with the next `F-###` id, the user's intent (own words, no quotes), background and a design sketch. Never work on future features.
When the user promotes one ("let's do F-003"), create an Inbox item with a new `I-###` id that links to it,
and strike the F entry through with "promoted to I-###".

## Mode 2 — Work the queue

Only when the user explicitly says **go** (or "start", "work the queue", "do I-003 and I-005").
If they name ids, only those; otherwise all open Inbox items without open questions.

1. **Plan the split.** Group items into workstreams by *file ownership* so sub-agents never edit
   the same files in parallel. Usual owners:
   - `apps/server/**` (server, pi-adapter)
   - `packages/app-core/src/features/chat/**` (shared chat: transcript, composer, tools)
   - `packages/app-core/src/{ui,state,lib}/**` (shared core; coordinate, many owners read it)
   - `apps/web/src/{app,features/sidebar,features/projects,features/settings,…}/**` (desktop layout)
   - `apps/iphone/src/**` (iPhone layout; Tauri iOS shell in `apps/iphone/src-tauri`)
   - `packages/protocol/**` is shared: make protocol changes **yourself first**, then spawn.
   Use one agent per workstream; do trivial one-liners yourself. Tell the user the split in a
   few lines, then spawn immediately (don't wait for approval unless something is ambiguous).
2. **Spawn workers** (`spawn_agent`, agent `worker`). Each task must be self-contained:
   - repo path, and to read `AGENTS.md` + `docs/ARCHITECTURE.md` first;
   - the exact Inbox entries (ids, text, notes) it owns and the acceptance criteria;
   - the folders it owns and the folders it must NOT touch;
   - **do not commit, and do not stage anything** (no `git add`/`git rm`; delete files with plain `rm`);
   - **do not edit PLAN.md or CHANGELOG.md** (the lead owns the ledger);
   - write/adjust tests; run `pnpm --filter <pkg> typecheck` and `pnpm vitest run --project <proj>`;
   - **test in a sandbox, never on the user's data**: anything that writes data (creating chats,
     prompts, settings, projects) runs against `pnpm dev:agent --name <worker-name>` (own ports,
     own data under `/tmp/glade-sandbox/<name>`, fake harness; `--real` only if the task needs
     real pi, with one tiny prompt). Start it in the background
     (`pnpm dev:agent --name <worker-name> > /tmp/glade-<worker-name>.log 2>&1 &`), read the
     Web/API URLs from the log, verify visually there (chrome-devtools MCP), and stop it when done
     (`pnpm dev:agent --name <worker-name> --stop`), which deletes the sandbox and its pi session
     files. Never write through the user's servers on :4317/:5317 or their data folder;
     read-only screenshots of the user's running app are fine;
   - final report: files changed, what was verified, per-id status (done / partial / blocked + why).
3. **While they work**, relay cross-agent info (e.g. new ui primitives) with `message_agent`.
4. **Integrate** as each finishes: run `pnpm check` and `pnpm --filter @glade/web build`, check the
   result yourself (browser for UI items), fix small gaps.
5. **Update the ledger** in the same commit as the code:
   - tick the Inbox item: `- [x] **I-007** … (2026-09-26)`; leave notes, add a one-line outcome;
   - add a user-facing `CHANGELOG.md` entry under `[Unreleased]` (Added/Changed/Fixed/Removed);
   - partial/blocked items stay unticked with a `Status:` line explaining what's left.
6. **Commit and push** (`git commit -m "fix: I-007 …"`; one commit per workstream is fine), then
   report: done ids, anything left open, and anything the user should look at.

## Rules

- While workers are running, the lead commits **only explicit paths** (`git commit -m … -- PLAN.md`)
  so half-finished work that happens to be staged is never swept into a commit.

- Intake never changes code. If a report is urgent, say so and ask; don't just start.
- `Reported:` states the user's intent in your words, completely (every requirement, constraint
  and preference they gave), never as a quote. If you're unsure what they meant, ask, then record
  the answer as a decision.
- If an item is really a design question, record it with an `Open question:` and ask it once.
- Done items stay in the Inbox (ticked) as the history. Periodically the lead may move ticked
  items to a `## Done inbox items` section at the bottom of PLAN.md to keep the top short.
