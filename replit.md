# JNT Mail

JNT Mail is a Telegram Mini App that creates a private, disposable ten-minute email inbox.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/jnt-mail run dev` — run the mobile-first Telegram Mini App
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `BOT_TOKEN` — Telegram BotFather token
- Production env: `APP_URL` — public HTTPS Mini App URL used by Telegram buttons and webhook
- `DATABASE_URL` is supplied by Replit's managed PostgreSQL environment; do not hardcode or expose it

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Mail providers: mail.tm primary, mail.gw fallback

## Where things live

- `artifacts/jnt-mail/src/App.tsx` — frontend shell and interaction states
- `artifacts/jnt-mail/src/index.css` — JNT Mail visual tokens and responsive styling
- `artifacts/jnt-mail/src/lib/locales.ts` — Turkish, Russian, and English interface copy
- `artifacts/api-server/src/routes/mail.ts` — Telegram validation, provider lifecycle, inbox polling, sanitization, and bot notifications
- `lib/api-spec/openapi.yaml` — source of truth for mail API routes and generated hooks

## Architecture decisions

- Mail provider credentials and tokens stay server-side; the client receives only the public session and sanitized message data.
- Development previews accept a stable preview user when Telegram initData is unavailable; production requires a valid Telegram HMAC signature.
- Expired provider accounts are deleted both on session replacement and via the 30-second cleanup loop.
- The frontend polls inboxes every five seconds, while the backend suppresses provider calls more frequently than its safety window.
- Production Telegram updates use a secret-validated webhook; never start long polling alongside it.
- PostgreSQL tables are declared in `lib/db/src/schema` and applied to production by Replit's Publish schema flow, not by startup SQL.
- Active mail-provider tokens and message contents remain in process memory; API restarts invalidate unexpired inboxes.

## Product

Users receive a new disposable address automatically, can copy or replace it, renew the ten-minute window up to three times, watch their inbox update, open sanitized messages, copy detected verification codes, and switch languages without reloading.

## User preferences

- Never add emojis to the interface, toast messages, or bot notifications.
- Keep the visual language premium, calm, dark, and mobile-first with inline SVG/Lucide-style icons.

## Gotchas

- Regenerate API client/Zod outputs after changing `lib/api-spec/openapi.yaml`.
- Set `APP_URL` to the published HTTPS URL before using the Telegram bot in production.
- For a continuously running instance, select Reserved VM rather than Autoscale. The uptime check endpoint is `/api/healthz`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
