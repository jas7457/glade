# Changelog

All notable changes to pi-ui. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Every entry corresponds to a ticked item in PLAN.md.

## [Unreleased]

### Added

- Project skeleton: pnpm monorepo with web app, server and shared protocol package.
- Working agreement for humans and agents (AGENTS.md), plan ledger (PLAN.md), architecture notes.
- Shared protocol describing models, transcripts and streaming agent events independent of pi.
- Server-side pi integration: runs `pi --mode rpc` per chat, translates its events, keeps a pool
  of agent processes, and tracks running/unread state and chat titles.
- Fake agent harness so the UI can be developed and tested without a real model.
- App data (projects, chat list, settings) stored in `~/Library/Application Support/pi-ui`.
- Web app scaffold with macOS-style light/dark design tokens and first UI components.
