// One-time backfill: walk past scheduled_events and upsert each into the
// Notion Groups DB. Safe to re-run — the upsert is keyed by Calendly Event ID.
//
// Usage:
//   npm run backfill -- --since=2024-01-01
//   npm run backfill -- --since=2024-01-01 --until=2025-12-31 --dry-run

import { requireEnv, optionalEnv } from "./_env.js";
import { CalendlyClient } from "../src/calendly.js";
import { NotionClient } from "../src/notion.js";
import { syncScheduledEvent } from "../src/sync.js";
import { classifyEvent } from "../src/mapping.js";

interface Args {
  since: string;
  until?: string;
  dryRun: boolean;
  status?: "active" | "canceled";
  groupStatus: "Pending review" | "Confirmed";
}

function parseArgs(): Args {
  const out: Args = { since: "", dryRun: false, groupStatus: "Pending review" };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg.startsWith("--since=")) out.since = arg.slice("--since=".length);
    else if (arg.startsWith("--until=")) out.until = arg.slice("--until=".length);
    else if (arg.startsWith("--status=")) {
      const v = arg.slice("--status=".length);
      if (v === "active" || v === "canceled") out.status = v;
    } else if (arg.startsWith("--group-status=")) {
      const v = arg.slice("--group-status=".length);
      if (v === "Confirmed" || v === "Pending review") out.groupStatus = v;
    }
  }
  if (!out.since) {
    console.error("usage: tsx scripts/backfill.ts --since=YYYY-MM-DD [--until=YYYY-MM-DD] [--status=active|canceled] [--dry-run]");
    process.exit(1);
  }
  return out;
}

function toIso(date: string): string {
  // Accept YYYY-MM-DD or full ISO. Always normalize to UTC midnight.
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return `${date}T00:00:00Z`;
  return new Date(date).toISOString();
}

async function main() {
  const args = parseArgs();
  const pat = requireEnv("CALENDLY_PAT");
  const notionToken = requireEnv("NOTION_TOKEN");
  const base = optionalEnv("CALENDLY_API_BASE", "https://api.calendly.com");
  const apiVersion = optionalEnv("NOTION_API_VERSION", "2022-06-28");
  const groupsDbId = requireEnv("NOTION_GROUPS_DB_ID");
  const trainingDbId = requireEnv("NOTION_TRAINING_DB_ID");
  const volunteersDbId = requireEnv("NOTION_VOLUNTEERS_DB_ID");

  const calendly = new CalendlyClient(pat, base);
  const notion = new NotionClient({ token: notionToken, apiVersion });

  const me = await calendly.me();
  const orgUri = optionalEnv("CALENDLY_ORG_URI", me.current_organization);

  const cfg = {
    calendly,
    notion,
    groupsDbId,
    trainingDbId,
    volunteersDbId,
    defaultStatus: args.groupStatus,
  };

  console.log(`Backfilling Calendly → Notion Groups`);
  console.log(`  scope: organization=${orgUri}`);
  console.log(`  range: ${args.since} → ${args.until ?? "now"}`);
  console.log(`  group status: ${args.groupStatus}`);
  console.log(`  dry-run: ${args.dryRun}\n`);

  let nextPageUrl: string | undefined;
  let total = 0;
  let groups = 0;
  let trainingRows = 0;
  let skipped = 0;
  let unmatched = 0;

  do {
    const page = await calendly.listScheduledEvents(
      nextPageUrl
        ? { nextPageUrl }
        : {
            organization: orgUri,
            minStartTime: toIso(args.since),
            maxStartTime: args.until ? toIso(args.until) : undefined,
            status: args.status,
          },
    );

    for (const event of page.collection) {
      total++;
      const tag = `[${event.start_time}] ${event.name}`;
      if (args.dryRun) {
        // Classify from the event name only — no invitee fetch, no writes.
        const r = classifyEvent(event.name);
        if (r.kind === "skip") {
          skipped++;
          console.log(`  (dry) SKIP      ${tag}  — ${r.reason}`);
        } else if (r.kind === "training") {
          trainingRows++; // counts events here, not attendee rows
          console.log(`  (dry) TRAINING  ${tag}  → ${r.trainingType}`);
        } else {
          groups++;
          console.log(`  (dry) GROUP     ${tag}  → ${r.groupType}`);
        }
        continue;
      }
      try {
        const res = await syncScheduledEvent(cfg, event.uri);
        const unmatchedSuffix = res.unmatchedEmails.length
          ? `  unmatched=[${res.unmatchedEmails.join(", ")}]`
          : "";
        unmatched += res.unmatchedEmails.length;

        if (res.kind === "skip") {
          skipped++;
          console.log(`  (skip) ${tag}  — ${res.reason}`);
        } else if (res.kind === "training") {
          const n = (res.trainingRowsCreated ?? 0) + (res.trainingRowsUpdated ?? 0);
          trainingRows += n;
          console.log(
            `  training ${tag}  [${res.trainingType}]  rows=${n} (` +
              `+${res.trainingRowsCreated} ~${res.trainingRowsUpdated})${unmatchedSuffix}`,
          );
        } else {
          groups++;
          const action = res.created ? "+created" : "~updated";
          console.log(
            `  ${action} ${tag}  [${res.groupType}]  host=${res.matchedHost ? "ok" : "MISS"}` +
              `  co-host=${res.matchedCoHostCount}${unmatchedSuffix}`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ! ${tag}  failed: ${msg}`);
      }
    }

    nextPageUrl = page.pagination.next_page ?? undefined;
  } while (nextPageUrl);

  const trainingLabel = args.dryRun ? "training events" : "training rows";
  console.log(
    `\nDone. ${total} events: ${groups} group rows, ${trainingRows} ${trainingLabel}, ${skipped} skipped (interviews). ` +
      `${unmatched} invitee email(s) had no matching Volunteers row.`,
  );
  if (unmatched > 0) {
    console.log(`(unmatched = booking email isn't on a Volunteers row — coordinator links the relation manually)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
