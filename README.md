# ForexVerse Central FCM Worker

One sender for all Supabase `push_delivery_jobs`. Webhook `POST /wake` triggers immediate processing; Cloudflare Cron `* * * * *` retries each minute. Both call `drain()` and atomically claim via `claim_pending_push_jobs`, then acknowledge via `record_push_delivery_outcome`.

## Setup

From this folder, run `npm install`, `npm test`, and `npx wrangler login`. Store **secrets** with `npx wrangler secret put <NAME>`:

- `SUPABASE_URL` — Supabase project's HTTPS URL
- `SUPABASE_SERVICE_ROLE_KEY` — server-only credential; never use browser key
- `FIREBASE_SERVICE_ACCOUNT_KEY` — service account JSON string with Firebase Messaging permissions
- `PUSH_WEBHOOK_SECRET` — long random secret, unrelated to any database password
- `FIREBASE_PROJECT_ID` — recommended; falls back to JSON's `project_id`

Then `npm run deploy`. GET `/health` is non-sensitive; POST `/wake` requires `x-webhook-secret` matching `PUSH_WEBHOOK_SECRET`.

## Cutover checklist (must follow this order)

1. Create Worker and set all Cloudflare secrets. Run tests and deploy.
2. Make a **single controlled test push** via the existing Supabase durable queue; confirm `push_delivery_events` -> `fcm_accepted` and check actual Android display. During this test, the existing Vercel senders may also claim jobs; the DB's atomic claim prevents concurrent claims, but whichever sender claims first owns the job.
3. Disable **all** old FCM dispatch calls in both Next.js repositories and the main admin direct-send API. Maintain all alert producers / quote fetching / snapshots / calendar generation.
4. Convert admin announcements into durable queued sends. DB's current `source` check only allows `price_alert`, `economic_event`, `candle_formation`, `trade_level`; add `admin_announcement` via a deliberate reviewed migration before routing admins.
5. Configure a Supabase Database Webhook for `public.push_delivery_jobs` `INSERT` -> `https://<worker-host>/wake` with HTTP header `x-webhook-secret`. Do not send token-bearing webhook payload to logs. For retry scheduled by `UPDATE`, cron is the recovery path; do not add broad update webhooks.
6. Re-test each notification type, verify deduplication, revoked tokens, and failure codes. Check scheduled runs in Cloudflare dashboard. Only then remove Firebase secrets from old Vercel projects if not needed elsewhere.

## Guarantees and limitations

- One FCM sender after cutover. Atomic job claim with a 2-minute lease supports concurrent webhook/cron invocations.
- Firebase HTTP 200 means *accepted*, not necessarily displayed on Android.
- Delivery is **at least once**, not strictly exactly once: a process failure after FCM acceptance but before recording can lead to a later retry. For strict cross-network exactly-once, FCM and Supabase do not offer one atomic transaction.
- Credential check and Google OAuth happen before claiming jobs, avoiding terminal failures when Firebase credentials are absent.
- Market data detection cadence is unchanged; immediate webhook delivery starts only after a job is inserted.
