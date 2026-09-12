# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LiteRouter Studio is a lightweight LLM provider aggregation gateway for OpenAI/Anthropic with native protocol passthrough. Single-process Node.js server providing proxy endpoints + Web management UI.

## Commands

| Command | Purpose |
|---------|---------|
| `pnpm install` | Install dependencies (uses registry.npmmirror.com) |
| `pnpm dev` | Backend (3000) + frontend dev server (5173) |
| `pnpm dev:server` | Backend only (tsx watch mode) |
| `pnpm dev:web` | Frontend only (Vite with API proxy) |
| `pnpm typecheck` | TypeScript type checking |
| `pnpm test` | Node unit tests |
| `pnpm test:e2e` | Playwright browser tests (requires `pnpm build:web` first) |
| `pnpm check` | Full validation: typecheck + test + build:web |
| `pnpm build:web` | Build frontend to web/dist |
| `pnpm start` | Production mode (serves API + static frontend) |

## Tech Stack

- **Backend**: TypeScript (strict), Hono 4, better-sqlite3 13, undici 8, zod 4
- **Frontend**: React 19, Vite 8, Tailwind CSS 4, shadcn/ui, TanStack Query, react-router 8
- **Package manager**: pnpm 11.22.0 (locked via packageManager field)
- **Node**: ≥ 24 required

## Architecture Red Lines (Never Violate)

1. **No protocol conversion**: Never convert request formats between OpenAI/Anthropic
2. **Only replace model + thinking level fields**: After routing succeeds, only replace top-level `model` field with real model name; if mapping has thinking config, only rewrite/inject top-level `thinking` (Anthropic) or `reasoning_effort` (OpenAI) fields per config. Never modify any other fields.
3. **HTTP plaintext only**: Trusted network only, no encryption

## Code Conventions

- **Always run backend with tsx directly**: Never compile TypeScript to JavaScript then run; always use `tsx` to execute `.ts` files
- **Must run from project root**: Database path is `process.cwd()/data/gateway.db`, running from wrong directory creates separate database
- **Frontend path alias**: `@/*` → `web/src/*` (configured in tsconfig + vite)
- **Add shadcn/ui components**: Use `pnpm dlx shadcn@latest add ...`

## Testing & Verification

When verifying changes:
- Run `pnpm test` (unit tests) and `pnpm test:e2e` (Playwright browser tests)
- Before E2E tests: ensure `web/dist` is built with `pnpm build:web`
- E2E tests use token from `E2E_GATEWAY_TOKEN` env var or auto-read from `data/gateway.db`

## API Design Patterns

- **Management API uses request body for parameters**: `provider_id`/`model_id` go in body (not path params) because `model_id` may contain `/` (e.g. `openai/gpt-4`)
- **Exception**: `GET /api/models` lists models without body

## Database

- SQLite with WAL mode at `data/gateway.db` (relative to `process.cwd()`)
- Schema v8 (development phase: breaking changes allowed, can delete db and rebuild)
- Foreign key constraints enabled

## Known Gotchas

- **Anthropic client conflict**: Gateway uses `x-api-key` for token extraction; conflicts with Anthropic SDK. Clients should use `Authorization: Bearer` instead
- **Single-process design**: No cluster/multi-instance support; don't run multiple instances sharing same `data/` directory
- **Port conflicts**: Database settings override `HOST`/`PORT` env vars; may need to check `data/gateway.db` settings table
- **E2E token fallback**: Tests auto-read token from dev database if `E2E_GATEWAY_TOKEN` not set
- **Frontend build required for E2E**: Must run `pnpm build:web` before Playwright tests

## Documentation

- `ARCHITECTURE.md`: Authoritative design guide (data model, API, proxy pipeline, boundaries)
- `AGENTS.md`: Development conventions for AI agents (task-based reading index, verification by risk)
- `skills/literouter/`: Gateway management skill (use for actual gateway operations, not for business code development)

## Import Existing Content

For detailed references that change frequently, use `@path/to/file` syntax:
- Architecture details: @ARCHITECTURE.md
- Development conventions: @AGENTS.md
