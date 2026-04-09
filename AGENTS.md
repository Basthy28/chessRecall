<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project Guidelines

## Build and Run
- Use `npm` for commands.
- Install deps: `npm install`
- Start dev server: `npm run dev`
- Build production bundle: `npm run build`
- Start production server: `npm run start`
- Run lint checks: `npm run lint`
- There is currently no test command in `package.json`; do not invent one.

## Architecture
- Framework: Next.js App Router with TypeScript strict mode and path aliases (`@/*` -> `src/*`).
- Main route UI lives in `src/app/page.tsx` and composes training UI components.
- API boundary is in `src/app/api/**`.
- External API clients and infrastructure helpers live in `src/lib/**`.
- Queue producer runs in Next.js server context (`src/lib/queue.ts`).
- Queue worker runs as a separate Node process (`src/workers/analyzeGame.worker.ts`). Keep this boundary strict.

## Conventions
- Reuse shared constants from `src/lib/constants.ts`. Do not hardcode queue names.
- Keep API route handlers defensive and explicit: validate input, return structured JSON errors, handle 404/429 for upstream chess APIs.
- Keep browser code and server code separate:
	- Browser components must use `"use client"` when required.
	- Never expose `SUPABASE_SERVICE_ROLE_KEY` to client code.
- For Supabase usage:
	- Server code should use `createServerClient()` from `src/lib/supabase.ts`.
	- Client/browser code should use `createBrowserClient()` from `src/lib/supabase.ts`.
- Worker code must remain standalone Node-compatible and communicate with the app through Redis/BullMQ only.

## Environment and Local Setup
- Required env vars are read from `.env.local`:
	- `NEXT_PUBLIC_SUPABASE_URL`
	- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
	- `SUPABASE_URL` (or fallback to `NEXT_PUBLIC_SUPABASE_URL`)
	- `SUPABASE_SERVICE_ROLE_KEY`
	- `REDIS_HOST`
	- `REDIS_PORT`
	- `REDIS_PASSWORD` (optional)
- If these are missing, API routes and queue integration are expected to fail fast with explicit errors.

## Current Phase Notes
- The import pipeline uses a phase-1 placeholder user id in `src/app/api/import/route.ts`.
- The worker in `src/workers/analyzeGame.worker.ts` is a phase-1 stub pending Stockfish integration.
- Keep phase notes intact unless implementing the corresponding feature fully.

## Key References
- Project overview and setup: `README.md`
- Import API route pattern: `src/app/api/import/route.ts`
- Supabase client pattern: `src/lib/supabase.ts`
- Queue producer pattern: `src/lib/queue.ts`
- Lichess API integration: `src/lib/lichess.ts`
- Chess.com API integration: `src/lib/chessdotcom.ts`
- Worker process boundary: `src/workers/analyzeGame.worker.ts`
- Shared types: `src/types/index.ts`

## When Changing Behavior
- Prefer small, localized changes and preserve existing API contracts.
- Update types in `src/types/index.ts` when changing DB-facing payload shapes.
- If adding tests later, document the exact command and location in this file.
