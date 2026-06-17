# AI Usage

This project was built with Claude (Anthropic, Opus 4.7, 1M context) for both planning and implementation. AI was used to:

- Research best practices across HubSpot, Google Calendar, and Notion sync patterns, idempotency strategies, failure-isolation approaches, and free-tier hosting tradeoffs
- Draft the implementation plan (six phases, ~57 files) covering architecture, data model, key flows, failure modes, and testing strategy
- Scaffold the codebase across all phases — env validation, DB client, migration runner, Fastify app, sync orchestrator, three source adapters, webhook handlers, and the cron entry point
- Diagnose and fix bugs as they surfaced: TS strict-mode regressions on Render, a Fastify auth-bypass from misunderstanding plugin encapsulation, the `tsx watch` hot-reload + module-level state staleness, Notion SDK v5's `databases.query → dataSources.query` migration, and others

All architectural decisions, library choices, and deployment configuration were reviewed and approved by the developer before commits. Claude offered options with trade-offs at each design decision; the developer made the calls.

## How the conversation happened

This project was built via **Claude Code CLI** — the terminal-based agentic coding environment from Anthropic, not the claude.ai web interface. As a result there isn't a single "share link" the way a claude.ai chat would produce; the equivalent is the local session transcript that the CLI captures.

What's available in this repo:

- **[`docs/ai-conversation.md`](docs/ai-conversation.md)** — a curated narrative log of the dialogue: the questions, trade-offs discussed, decisions made, and bugs caught across all six implementation phases. Code, commands, and terminal output stripped out so it reads as a design story.
