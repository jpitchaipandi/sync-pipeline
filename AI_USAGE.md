# AI Usage

This project was built with Claude (Anthropic) for both planning and implementation. AI was used to:

- Research best practices across HubSpot, Google Calendar, and Notion sync patterns, idempotency strategies, failure-isolation approaches, and free-tier hosting tradeoffs
- Draft the implementation plan (six phases, ~57 files) covering architecture, data model, key flows, failure modes, and testing strategy
- Scaffold the initial codebase: env validation, DB client, migration runner, Fastify app, health route, SQL schema, and migration files
- Generate the migration tracker and `cleanup_stale_runs()` recovery function

All architectural decisions, library choices, and deployment configuration were reviewed and approved before commits. The conversation transcript will be linked here.

## Conversation transcript

_To be added on final submission._
