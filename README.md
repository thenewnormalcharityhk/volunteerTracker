# calendly-notion-sync

Cloudflare Worker that listens for Calendly webhook deliveries and writes each
booking into The New Normal HK's Notion databases.

```
Calendly booking ──► Worker /webhook ──► routes by event type:
                                          ├─ peer-support group → Groups DB (Host + Co-host)
                                          ├─ training / Q&A / dev / host-connection → Training Log DB (one row per attendee)
                                          └─ interview → skipped
                                      └─► Volunteers DB (email lookup → relations)
```

Notes & Flags is NOT touched — per the requirements PDF those are manual
coordinator entries.

## Routing (edit `src/mapping.ts`)

| Calendly event type | Destination | Notes |
|---|---|---|
| Good Grief, Healing Hearts, Complicated Grief, Otherwise Employed, Cancer Connection, 好心程 *(all Chinese groups)* | **Groups DB** | `Group Type = Peer support group`. Host = first invitee, Co-hosts = rest. |
| English / Cantonese – Group Session with Clinical Advisor | **Training Log** | `Training Type = Clinical Q&A`, tutor inferred (Chris=Eng, Cindy=Canto). |
| Refresher Training, Welcome Back Refresher | **Training Log** | `Training Type = Refresher`. |
| Development sessions with Chris / Cindy | **Training Log** | `Training Type = Development session`, tutor parsed from name. |
| Host Connection Space – English / Cantonese | **Training Log** | `Training Type = Host connection`. |
| First round interview, Comms Strategist Volunteer Interview | **Skipped** | Recruitment — nothing written. |

**Group events** create **one** Groups row (Host = earliest invitee by `created_at`, Co-hosts = the rest), `Status = Pending review`.

**Training events** create **one Training Log row per active attendee**, linked to the volunteer by email, `Source = Calendly sync`, `Attendance = Attended`. Idempotency key = `Calendly Event ID` + `Attendee Email`.

For `invitee.canceled`: the event is re-synced; if a peer-support group is fully canceled, its Groups page title is prefixed with `[CANCELED]`.

## Prerequisites

- **Calendly paid plan** (Standard or higher) — required for webhook subscriptions.
- **Notion integration token** with edit access to the Volunteers and Groups DBs.
- A Cloudflare account (free tier is fine).

## Setup

### 1. Install

```bash
cd calendly-notion-sync
npm install
```

### 2. Get a Calendly personal access token

1. Sign in at https://calendly.com.
2. Open https://calendly.com/integrations/api_webhooks.
3. Generate a new **Personal Access Token**. Copy it (`cal_pat_...`).

### 3. Create a Notion internal integration

1. Visit https://www.notion.so/profile/integrations.
2. **New integration → Internal**. Give it a name (e.g. `Calendly Sync`).
3. Copy the **Internal Integration Secret** (`secret_...`).
4. In Notion, open the **TNN HK Volunteer Tracker — Demo Databases** page → ⋯ → **Connections → Add connection** → select the new integration. (Or share each of the 4 databases individually.)

### 4. Fill in `.env`

```bash
cp .env.example .env
$EDITOR .env
```

Required values:

| Var | Where to get it |
|---|---|
| `CALENDLY_PAT` | step 2 |
| `NOTION_TOKEN` | step 3 |
| `CALENDLY_WEBHOOK_SIGNING_KEY` | You pick this — a long random string. `openssl rand -hex 32` works. |
| `WORKER_URL` | The `https://...workers.dev` URL Cloudflare gives you after step 6. |

`NOTION_GROUPS_DB_ID` and `NOTION_VOLUNTEERS_DB_ID` are pre-filled with TNN's actual database IDs.

### 5. Verify the Calendly side

```bash
npm run calendly:whoami
```

Prints your user URI, organization URI, and lists all event types. Update `src/mapping.ts` if any of those names need explicit routing rules.

### 6. Deploy the worker

```bash
npm run typecheck    # sanity check
npx wrangler login   # first time only
npm run deploy
```

Wrangler will print the public URL — paste it into `.env` as `WORKER_URL`.

Now upload the secrets so the deployed worker can read them:

```bash
npx wrangler secret put CALENDLY_PAT
npx wrangler secret put CALENDLY_WEBHOOK_SIGNING_KEY
npx wrangler secret put NOTION_TOKEN
```

### 7. Register the webhook with Calendly

```bash
npm run setup:webhook
```

This calls `POST /webhook_subscriptions` and points Calendly at `${WORKER_URL}/webhook` with the events `invitee.created` and `invitee.canceled`. The signing key from `.env` is passed in so Calendly will HMAC every delivery for us.

You can inspect or remove subscriptions later:

```bash
npm run list:webhooks
npm run delete:webhook -- <uri-or-uuid>
```

### 8. (Optional) Backfill past events

```bash
npm run backfill -- --since=2026-01-01           # all events since Jan
npm run backfill -- --since=2026-01-01 --dry-run # preview without writing
npm run backfill -- --since=2025-01-01 --status=active
```

Idempotent: safe to re-run. Already-synced rows are updated rather than duplicated.

## Local development

```bash
npm run dev   # wrangler dev — runs worker locally on http://127.0.0.1:8787
```

In another terminal:

```bash
npm run tail  # stream production logs
```

For end-to-end local testing, expose the dev worker via `cloudflared tunnel` or `ngrok`, then point a *test* Calendly subscription at that tunnel.

## Files

| Path | What's in it |
|---|---|
| `src/index.ts` | Worker entry: routes `/webhook` and `/health`. |
| `src/signature.ts` | Calendly HMAC-SHA256 signature verification. |
| `src/calendly.ts` | Typed REST client (no SDK). |
| `src/notion.ts` | Notion REST client + Group page upsert. |
| `src/mapping.ts` | Calendly event-name → Group Type rules. Edit this when event names change. |
| `src/sync.ts` | Core sync logic (shared by worker + backfill). |
| `scripts/whoami.ts` | Prints Calendly user + event types. |
| `scripts/setup-webhook.ts` | Registers the Calendly webhook subscription. |
| `scripts/list-webhooks.ts` | Lists existing subscriptions. |
| `scripts/delete-webhook.ts` | Deletes a subscription. |
| `scripts/backfill.ts` | Imports historical scheduled events into Groups / Training DBs. |
| `src/rules.ts` | Daily-alert rule engine (pure functions, PDF scenarios 2–9). |
| `src/alerts.ts` | Alert orchestrator: fetch → rules → KV dedupe → notify + mutate. |
| `src/notify.ts` | Slack + (optional) Resend email channels. |
| `scripts/run-alerts.ts` | Local dry-run / live runner for the alert engine. |

## How rows look after a sync

| Property | Value |
|---|---|
| `Group Name` | Calendly event name (e.g. `Good Grief — Wan Chai`) |
| `Date` | Calendly `start_time` (ISO datetime) |
| `Group Type` | `Peer support group` / `Q&A with Clinical Advisor` / `Training` (from `mapping.ts`) |
| `Language` | Inferred from name when possible (`(Cantonese)`, Chinese chars, etc.), else blank |
| `Host` | Relation to the Volunteers row whose **Email** matches the first invitee. |
| `Co-host` | Relations to Volunteers rows matching subsequent invitees. |
| `Calendly Event ID` | UUID — used as the idempotency key. |
| `Status` | `Pending review` — coordinator confirms in Notion. |

If a booking email doesn't match any Volunteers row, the relation is left empty and the coordinator wires it up manually during the **Pending review** step.

## Operational notes

- **Idempotency.** Upserts are keyed by Calendly Event ID. Calendly webhook deliveries are at-least-once; the worker handles dupes safely.
- **Retries.** The worker returns `500` on transient errors so Calendly retries (Calendly retries with exponential backoff for ~24h).
- **Cancellations.** When the entire event is canceled in Calendly, the Notion page title is prefixed with `[CANCELED]`. Add a `Canceled` option to the Groups DB `Status` select if you'd rather track it there.
- **Co-host detection.** Order = invitee `created_at`. First booker is treated as Host. If your team prefers a different convention (e.g. always assign by district, or always leave Co-host blank), edit `src/sync.ts`.
- **Rate limits.** Notion is 3 req/s per integration, Calendly is generous (≥1000/hr). Backfill is sequential and well within limits.

## Daily alerts (PDF Section 5, scenarios 2–9)

A **daily cron** (`0 1 * * *` ≈ 09:00 Hong Kong) reads the Notion snapshot
(Volunteers + Groups + open Concern flags) and fires alerts. Pure rule logic
lives in `src/mapping`-style modules: `src/rules.ts` (what fires), `src/alerts.ts`
(orchestration + dedupe), `src/notify.ts` (Slack + email).

| # | Rule | Trigger | Action |
|---|---|---|---|
| 2 | Shadow inactivity | Shadow with no session in `SHADOW_INACTIVE_DAYS` (30), or In Training > `IN_TRAINING_STALE_DAYS` (180) | Notify coordinator |
| 3 | Host inactivity → Check in | Active/Buddy Host, last group > `HOST_INACTIVE_DAYS` (90) | Notify coordinator **+ set Status = Check in** + audit note |
| 4 | Milestone | First group hosted; or `MILESTONE_GROUPS` (10) reached | Notify coordinator; email the volunteer at 10 + Milestone note |
| 5 | Safeguarding → On Hold | Volunteer has an Open concern flag and isn't already On Hold | Notify coordinator + CEO + DSL **+ set Status = On Hold** + audit note |
| 7 | Frequent host | > `FREQUENT_WEEK_LIMIT` (1) groups/week or > `FREQUENT_MONTH_LIMIT` (4)/month | Notify coordinator |
| 8 | Shadow sign-off prompt | Shadow reaches `SHADOW_SIGNOFF_PROMPT` (6) groups; escalate at `SHADOW_SIGNOFF_ESCALATE` (8) | Notify coordinator |
| 9 | Shadow readiness | Shadow with > `SHADOW_READINESS_GROUPS` (4) groups in 3 months | Notify coordinator |

Thresholds are `[vars]` in `wrangler.toml` — change them without touching code.

**Idempotency.** Status-change rules (3, 5) are self-deduping — once a volunteer
is `Check in` / `On Hold` they no longer match. Nudge rules use a KV namespace
(`ALERTS_KV`): milestones & sign-off prompts fire once ever; frequent-host &
shadow-inactivity at most once per week; readiness once per month.

**Channels.** Slack (one incoming webhook → coordinator channel) + optional
email via Resend. If a channel's secret isn't set, it's skipped with a log line
— so you can run Slack-only and add email later. Milestone emails go to the
volunteer; safeguarding emails go to coordinator + CEO + DSL.

### Going live with alerts (currently in safe DRY-RUN)

The worker ships with `ALERTS_DRY_RUN = "true"` — the cron computes and logs
alerts but sends nothing and changes no Notion records. To activate:

1. **Add a Slack incoming webhook** (Slack → Apps → Incoming Webhooks → pick the
   coordinator channel → copy URL):
   ```bash
   npx wrangler secret put SLACK_WEBHOOK_URL
   ```
2. **(Optional) Enable email** — sign up at resend.com, verify the
   `thenewnormalcharityhk.org` domain, then:
   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```
   Without this, email is skipped and everything goes to Slack only.
3. **Baseline the dedupe** so historical milestones don't blast out (someone
   already past 10 groups shouldn't get a "congrats!" for it):
   ```bash
   curl "https://calendly-notion-sync.tech-45b.workers.dev/run-alerts?seed=1&token=<ALERTS_RUN_TOKEN>"
   ```
   This marks all currently-eligible milestones / sign-off prompts as
   already-notified, without sending anything.
4. **Flip to live**: set `ALERTS_DRY_RUN = "false"` in `wrangler.toml`, then
   `npm run deploy`. The next daily run (and any manual `/run-alerts`) now sends
   for real. Note: rules 3 & 5 will then flip stale hosts to `Check in` and any
   flagged volunteer to `On Hold` on the first live run — that's intended.

### Testing alerts

```bash
npm run alerts                 # local DRY RUN — reads live Notion, prints what would fire
npm run alerts -- --live       # local LIVE run (respects configured channels)

# Against the deployed worker (uses the real KV + cron code path):
curl ".../run-alerts?dry=1&token=<TOKEN>"   # dry, no writes
curl ".../run-alerts?token=<TOKEN>"         # uses ALERTS_DRY_RUN var
curl ".../run-alerts?seed=1&token=<TOKEN>"  # baseline dedupe only
```

## Roadmap / not-yet-built

- ❌ Per-volunteer training log auto-creation from group *attendance*. Calendly only knows the host/co-host of a session, not who shadowed it — so shadow-session counts for scenarios 2/8/9 are approximated from the volunteer's linked groups. A cleaner shadow-session model would improve those.
- ❌ Real-time safeguarding (scenario 5 currently fires on the daily cron, not the instant a flag is added). If sub-day urgency is needed, add a Notion automation or a button that calls the worker.
- ❌ Concern flag auto-creation. Per spec, flags are manual coordinator entries.
