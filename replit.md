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
- Production env: `APP_URL` — public HTTPS Mini App URL used by Telegram buttons, the menu button and the webhook; it must be the published `.replit.app` address, never the workspace `*.replit.dev` address
- Optional env: `SESSION_SECRET` — secret behind the Telegram webhook token (derived from `BOT_TOKEN` when it is missing); `ADMIN_IDS` — extra admin Telegram IDs separated by commas, spaces or new lines
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
- `artifacts/api-server/src/routes/mail.ts` — Telegram validation, provider lifecycle, inbox polling, sanitization, and bot notifications; also the `/start` and `/admin` bot commands
- `artifacts/api-server/src/lib/telegram-auth.ts` — initData signature check and the admin ID list (built-in ID plus `ADMIN_IDS`)
- `artifacts/jnt-mail/src/admin/AdminApp.tsx` — admin panel (summary, announcements, channels, bans, ads), served at `/admin`
- `artifacts/jnt-mail/src/lib/telegram.ts` — Telegram WebApp helpers (initData, ready/expand, native back button)
- `lib/api-spec/openapi.yaml` — source of truth for mail API routes and generated hooks

## Architecture decisions

- Mail provider credentials and tokens stay server-side; the client receives only the public session and sanitized message data.
- Development previews accept a stable preview user when Telegram initData is unavailable; production requires a valid Telegram HMAC signature.
- Expired provider accounts are deleted both on session replacement and via the 30-second cleanup loop.
- The frontend polls inboxes every five seconds, while the backend suppresses provider calls more frequently than its safety window.
- Production Telegram updates use a secret-validated webhook; never start long polling alongside it.
- Admin access is decided on the server from a verified Telegram initData signature. Telegram ID `8377297659` is built in (`BUILT_IN_ADMIN_IDS`) and `ADMIN_IDS` adds more; an ID alone never grants access without a valid signature.
- The admin panel only works inside Telegram. Admins reach it from the Admin button in the Mini App header (`isAdmin` comes from `/api/gate/status`), the second button under `/start`, or the `/admin` bot command, all of which open it as a Mini App; Telegram's native back button returns to the mail screen.
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
- Telegram opens whatever URL BotFather has saved. If the Mini App shows Replit's "Run this app to see the results here" screen, BotFather (Menu Button, Main Mini App, or a `/newapp` app) still points at the workspace `*.replit.dev` address; change it to the published URL. Production startup re-points the default menu button to `APP_URL`, but the Main Mini App URL can only be edited in BotFather.
- Republish after changing code or secrets; the published app does not follow the workspace.
- Use `sql` defaults for bigint columns, as in ``.default(sql`0`)``. A `0n` default makes `drizzle-kit push` (and `scripts/post-merge.sh`) crash with "Do not know how to serialize a BigInt".
- For a continuously running instance, select Reserved VM rather than Autoscale. The uptime check endpoint is `/api/healthz`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
