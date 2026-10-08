# Original brief (2026-09-26)

The request Glade started from, summarised. Glade was first called pi-ui.

## Goal

A GUI for the pi coding agent, inspired by apps like Codex. It works with pi first, but the agent
harness must be swappable so others (e.g. Claude Code) can be added later.

## Layout

- A resizable sidebar on the left and the chat on the right. Research what the sidebar should
  hold so it suits both plain conversations and, mainly, code projects.
- A project is a folder on disk that holds several chats.
- A settings area, sparse at first; recommend what belongs there before building.

## Chat

- The text box is a reusable component, and so is the transcript view above it: both may be
  needed elsewhere.
- Render streaming Markdown properly, with a library that handles most of it but can be customised.
- Consecutive tool calls collapse into one expandable group ("Ran 4 tool calls"), each call
  expandable again; display tool calls the way apps like Codex do.
- Pick the model in the chat from pi's model list (local models will be added to pi later and
  should show up there), and the thinking level next to it.

## Way of working

- Keep a strict ledger: a Markdown plan of everything planned, ticked off when done, and an
  AGENTS.md telling agents to work that way. A CHANGELOG.md grows as items are ticked.

## Tech

- Talk to pi through its RPC mode, so a Node server sits in between.
- Persist settings and session data in a sensible place on disk, so every conversation can be
  continued after the app is closed. Chats can be created, deleted and renamed, and are titled
  automatically from the first message (editable later).
- TypeScript and Preact with Preact signals for state; Tailwind for CSS, built from reusable
  components so the app looks consistent. Discuss any UI library first; one that looks native is a
  plus. It's a web app, packaged with Tauri as a native macOS app, so the UI should feel native.
- Tests as we go. Every screen routable, so a refresh keeps you in place.
- Ask questions before starting rather than fixing misunderstandings later.
