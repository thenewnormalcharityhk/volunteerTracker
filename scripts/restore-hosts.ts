// Surgical restore of Host / Co-host relations on the Notion Groups DB.
//
// Why this exists: the Groups DB relations were accidentally cleared when the
// "Host"/"Co-host" relation properties were converted from one-way to two-way
// in Notion (a schema change that dropped existing links). This script rebuilds
// ONLY those two relations from Calendly's invitee list — the same derivation
// the sync uses (Host = first active invitee by created_at, Co-hosts = rest).
//
// Unlike the full backfill, this NEVER creates pages and NEVER writes any other
// property (Status, Group Name, Date, Type, Language are left untouched), so it
// can't clobber human-set values like "Confirmed".
//
// Usage:
//   npm run restore:hosts -- --since=2024-01-01 --dry-run
//   npm run restore:hosts -- --since=2024-01-01

import { requireEnv, optionalEnv } from "./_env.js";
import { CalendlyClient, uuidFromUri, type CalendlyInvitee } from "../src/calendly.js";
import { NotionClient } from "../src/notion.js";
import { classifyEvent } from "../src/mapping.js";

interface Args {
  since: string;
  until?: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const out: Args = { since: "2024-01-01", dryRun: false };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg.startsWith("--since=")) out.since = arg.slice("--since=".length);
    else if (arg.startsWith("--until=")) out.until = arg.slice("--until=".length);
  }
  return out;
}

function toIso(date: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return `${date}T00:00:00Z`;
  return new Date(date).toISOString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs();
  const pat = requireEnv("CALENDLY_PAT");
  const notionToken = requireEnv("NOTION_TOKEN");
  const base = optionalEnv("CALENDLY_API_BASE", "https://api.calendly.com");
  const apiVersion = optionalEnv("NOTION_API_VERSION", "2022-06-28");
  const groupsDbId = requireEnv("NOTION_GROUPS_DB_ID");
  const volunteersDbId = requireEnv("NOTION_VOLUNTEERS_DB_ID");

  const calendly = new CalendlyClient(pat, base);
  const notion = new NotionClient({ token: notionToken, apiVersion });

  const me = await calendly.me();
  const orgUri = optionalEnv("CALENDLY_ORG_URI", me.current_organization);

  console.log(`Restoring Host / Co-host on Notion Groups (relations only)`);
  console.log(`  scope: organization=${orgUri}`);
  console.log(`  range: ${args.since} → ${args.until ?? "now"}`);
  console.log(`  dry-run: ${args.dryRun}\n`);

  // Cache volunteer email → pageId (many events share the same hosts).
  const volunteerCache = new Map<string, string | null>();
  async function resolve(email: string, unmatched: string[]): Promise<string | null> {
    const key = email.toLowerCase();
    if (volunteerCache.has(key)) {
      const cached = volunteerCache.get(key)!;
      if (cached === null) unmatched.push(email);
      return cached;
    }
    const id = await notion.findVolunteerByEmail(volunteersDbId, email);
    volunteerCache.set(key, id);
    if (!id) unmatched.push(email);
    return id;
  }

  // Direct PATCH of only the two relation properties.
  async function patchRelations(
    pageId: string,
    hostId: string | null,
    coHostIds: string[],
  ): Promise<void> {
    const properties: Record<string, unknown> = {};
    if (hostId) properties.Host = { relation: [{ id: hostId }] };
    if (coHostIds.length) properties["Co-host"] = { relation: coHostIds.map((id) => ({ id })) };
    if (Object.keys(properties).length === 0) return;
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Notion-Version": apiVersion,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ properties }),
    });
    if (!res.ok) {
      throw new Error(`Notion PATCH /pages/${pageId} failed ${res.status}: ${await res.text()}`);
    }
  }

  let nextPageUrl: string | undefined;
  let total = 0;
  let groupEvents = 0;
  let patched = 0;
  let noPage = 0;
  let hostMiss = 0;
  let unmatchedTotal = 0;

  do {
    const page = await calendly.listScheduledEvents(
      nextPageUrl
        ? { nextPageUrl }
        : {
            organization: orgUri,
            minStartTime: toIso(args.since),
            maxStartTime: args.until ? toIso(args.until) : undefined,
          },
    );

    for (const event of page.collection) {
      total++;
      const routing = classifyEvent(event.name);
      if (routing.kind !== "group") continue; // only groups carry Host/Co-host
      groupEvents++;

      const tag = `[${event.start_time}] ${event.name}`;
      try {
        const invitees = await calendly.listInvitees(event.uri);
        const active = invitees
          .filter((i: CalendlyInvitee) => i.status === "active")
          .sort((a, b) => a.created_at.localeCompare(b.created_at));

        const unmatched: string[] = [];
        const hostInvitee = active[0] ?? null;
        const hostId = hostInvitee ? await resolve(hostInvitee.email, unmatched) : null;
        const coHostIds: string[] = [];
        for (const inv of active.slice(1)) {
          const id = await resolve(inv.email, unmatched);
          if (id) coHostIds.push(id);
        }
        unmatchedTotal += unmatched.length;
        if (!hostId) hostMiss++;

        const uuid = uuidFromUri(event.uri);
        const pageId = await notion.findGroupByCalendlyEventId(groupsDbId, uuid);
        if (!pageId) {
          noPage++;
          console.log(`  (no page)  ${tag}  — no Group row with this Calendly Event ID`);
          continue;
        }

        const unmatchedSuffix = unmatched.length ? `  unmatched=[${unmatched.join(", ")}]` : "";
        const label = `host=${hostId ? "ok" : "MISS"} co-host=${coHostIds.length}${unmatchedSuffix}`;
        if (args.dryRun) {
          console.log(`  (dry) would patch  ${tag}  ${label}`);
        } else {
          await patchRelations(pageId, hostId, coHostIds);
          patched++;
          console.log(`  patched  ${tag}  ${label}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ! ${tag}  failed: ${msg}`);
      }

      await sleep(300); // stay comfortably under Notion's ~3 req/s limit
    }

    nextPageUrl = page.pagination.next_page ?? undefined;
  } while (nextPageUrl);

  console.log(
    `\nDone. Scanned ${total} Calendly events, ${groupEvents} classified as groups. ` +
      `${args.dryRun ? "would patch" : "patched"} ${patched}, ${noPage} had no Group row, ` +
      `${hostMiss} with no host match, ${unmatchedTotal} unmatched invitee email(s).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
