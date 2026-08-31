# Working on this repo

Calendly → Notion sync for The New Normal Charity HK's volunteer tracker,
plus a daily alert engine. Read `README.md` first; this file is the things
that aren't obvious from the code.

## Who you're working with

Anna is not a developer. Write commands out in full, explain what a command
does before she runs it, and give one step at a time. Never ask her to paste
a secret into chat: values live in `.env` and in `wrangler secret put`.

## Before you change anything

- `npm test` runs offline. No secrets, no network. Run it after every change.
- `npm run typecheck` likewise.
- Anything that writes to Notion or Calendly has a `--dry-run`. Use it, show
  Anna the output, and get a yes before the real run.

## Live as of 30 August 2026

Alerts are **live**: `ALERTS_DRY_RUN = "false"`, daily cron at 01:00 UTC
(09:00 HK), posting to Slack. Everyone already past a threshold on 30 August
was baselined via `?seed=1`, so alerts only fire on new crossings. Don't
re-seed casually; it silences things that should fire.

## Traps, all of which have bitten

**The backfill overwrites.** `npm run backfill` refreshes Host, Co-host and
Shadow on every session it touches, from Calendly. It replaces rather than
merges. Manual corrections made in Notion beforehand are lost. Order is
always: fix the source data, then backfill, then any manual corrections.

**Shadow roles come from a booking question whose wording changed four
times.** See `parseAttendanceRole` in `src/mapping.ts` and the tests. Any
answer containing "shadow" is a shadow; "Signed Off Host" means hosting.
Three group event types have no such question at all.

**Notion property updates need the property's own config.** A description
alone is rejected. Rollups, formulas and numbers need their config block
resent. Relations reject even name-plus-description, so their descriptions
were added by hand in the UI. `scripts/tidy-volunteers.ts` sends one property
per request so a rejection isolates.

**Don't rename the Groups relations.** The `Sessions total (auto)` formula
refers to "Groups Hosted" and "Groups Co-hosted" by name in its expression.
Renaming via the API breaks it silently.

**Notion and Calendly time out intermittently.** Three failures in one day.
Neither client retries, so a dropped request silently skips a session in the
backfill. Adding retry with backoff to `NotionClient.req` and
`CalendlyClient.req` is a genuine outstanding improvement.

## Volunteers DB naming convention

- `(auto)` calculated, read-only. Correct it at the source.
- `(manual)` coordinator types into it. Never feeds the alerts.
- relations (`Groups Hosted` etc.) are the sessions. Fix in the Groups DB.

## What counts towards which alert

Hosted and shadowed sessions are aggregated separately in `src/rules.ts`.
Scenarios 8 and 9 count shadowed; 3, 4 and 7 count hosted; 2 counts any role.
This distinction is the whole point of the shadow work, so preserve it.

## Scripts

| Command | Does |
|---|---|
| `npm test` | Offline checks. Always run. |
| `npm run calendly:whoami` | Confirms the Calendly token works. |
| `npm run setup:schema` | One-time Notion fields. Idempotent. |
| `npm run setup:rollups` | Volunteers rollups. Idempotent. |
| `npm run audit:volunteers` | Read-only schema audit. |
| `npm run tidy:volunteers` | Renames and descriptions. Idempotent. |
| `npm run backfill -- --since=YYYY-MM-DD` | Re-syncs history. Overwrites. |
| `npm run verify:hosts` | Counts Host / Co-host / Shadow rows. |
| `npm run unmatched` | Booking emails with no volunteer record. |
| `npm run christy:page -- --parent=<url>` | Publishes that list to Notion. |
| `npm run alerts` | Local dry run, writes `alert-preview.md`. |
| `npm run deploy` | Deploys the worker. |

## Outstanding

- 35 booking emails don't match a volunteer record. Fix records, then backfill.
- Retries on both HTTP clients.
- `FREQUENT_WEEK_LIMIT` is 1, which flagged five people in one run. Probably
  too sensitive; review after a week of live alerts.
- Two event types added 25 Aug 2026, "Training for Signed Off Hosts" In Person
  and Online, land in the Training Log as Training Type "Other".
