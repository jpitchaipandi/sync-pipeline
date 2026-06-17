# AI Usage

This project was built with Claude (Anthropic, Opus 4.7, 1M context) for both planning and implementation. AI was used to:

- Research best practices across HubSpot, Google Calendar, and Notion sync patterns, idempotency strategies, failure-isolation approaches, and free-tier hosting tradeoffs
- Draft the implementation plan (six phases, ~57 files) covering architecture, data model, key flows, failure modes, and testing strategy
- Scaffold the codebase across all phases — env validation, DB client, migration runner, Fastify app, sync orchestrator, three source adapters, webhook handlers, and the cron entry point
- Diagnose and fix bugs as they surfaced: TS strict-mode regressions on Render, a Fastify auth-bypass from misunderstanding plugin encapsulation, the `tsx watch` hot-reload + module-level state staleness, Notion SDK v5's `databases.query → dataSources.query` migration, and others

All architectural decisions, library choices, and deployment configuration were reviewed and approved by the developer before commits. Claude offered options with trade-offs at each design decision; the developer made the calls.

## Conversation transcript

A narrative log of the dialogue — questions, trade-offs discussed, and decisions made (without code or terminal output) — lives at **[`docs/ai-conversation.md`](docs/ai-conversation.md)**.

The implementation-level build diary (with concrete bugs, fixes, and verification outputs) is kept privately outside this repo for the developer's reference.

The original Claude chat share link will be added here on final submission.
