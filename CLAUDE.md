# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LiteRouter Studio is a lightweight LLM provider aggregation gateway for OpenAI/Anthropic with native protocol passthrough. Single-process Node.js server providing proxy endpoints + Web management UI.

## Authoritative Docs

Do not maintain parallel behavior rules here. Read the source of truth when needed:

- `ARCHITECTURE.md` — sole authoritative design guide (red lines, data model, API, proxy pipeline, boundaries)
- `AGENTS.md` — development conventions, reading index, verification by risk
- `README.md` — setup, run, deploy/CD, client integration

## Commands

| Command | Purpose |
|---------|---------|
| `pnpm install` | Install dependencies (uses registry.npmmirror.com) |
| `pnpm dev` | Backend (3000) + frontend dev server (5173) |
| `pnpm dev:server` | Backend only (tsx watch mode) |
| `pnpm dev:web` | Frontend only (Vite with API proxy) |
| `pnpm typecheck` | TypeScript type checking |
| `pnpm lint` | ESLint |
| `pnpm test` | Node unit tests |
| `pnpm test:e2e` | Playwright browser tests (requires `pnpm build:web` first) |
| `pnpm check` | typecheck + lint + test + build:web |
| `pnpm build:web` | Build frontend to web/dist |
| `pnpm start` | Production mode (serves API + static frontend) |

## Development

- Work in the `dev` worktree (`scripts/dev-worktree.sh`, ports 3001/5174). Port 3000 is the production gateway — never touch it for feature work.
- Package manager is pinned via `packageManager` (pnpm). Node ≥ 24.
- `typescript` resolves to TypeScript 6 for typescript-eslint; `tsc`/typecheck uses TypeScript 7 (`typescript-native`). Keep both when updating TS.
- Backend always runs with `tsx` (never compile then run). Database path is `process.cwd()/data/gateway.db`.
