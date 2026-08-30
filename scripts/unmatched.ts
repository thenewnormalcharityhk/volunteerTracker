// Reports Calendly booking emails that don't match any Volunteers row, and
// tries to work out which are actually existing volunteers using a second
// address rather than people with no record at all.
//
// Read-only: touches nothing in Notion or Calendly.
//
//   npm run unmatched -- --since=2025-04-01
//
// Writes unmatched-report.md next to the repo root.

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { requireEnv, optionalEnv } from "./_env.js";
import { CalendlyClient } from "../src/calendly.js";
import { NotionClient, type VolunteerRow } from "../src/notion.js";
import { classifyEvent } from "../src/mapping.js";

const sinceArg = process.argv.find((a) => a.startsWith("--since="));
const since = sinceArg ? sinceArg.slice("--since=".length) : "2025-04-01";

interface Seen {
  email: string;
  names: Set<string>;
  sessions: string[]; // "2026-08-03  Otherwise Employed"
  first: string;
  last: string;
}

interface Suggestion {
  volunteer: VolunteerRow;
  reason: string;
  confidence: "high" | "medium";
}

// ── name / email helpers ──
const strip = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const localPart = (e: string) => e.toLowerCase().split("@")[0] ?? "";

function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, " ") // drop "(Participant)", "(旁聽)" etc.
    .split(/[^a-z]+/)
    .filter((t) => t.length > 2);
}

function suggest(seen: Seen, volunteers: VolunteerRow[]): Suggestion | null {
  const bookingNames = [...seen.names];
  const local = localPart(seen.email);

  // 1. Exact name match against a volunteer.
  for (const v of volunteers) {
    if (!v.name) continue;
    for (const bn of bookingNames) {
      if (strip(bn) && strip(bn) === strip(v.name)) {
        return { volunteer: v, reason: `same name as their record`, confidence: "high" };
      }
    }
  }

  // 2. Same email local part, different domain (jyshsieh@gmail vs @yahoo).
  for (const v of volunteers) {
    if (!v.email) continue;
    if (localPart(v.email) === local && v.email.toLowerCase() !== seen.email.toLowerCase()) {
      return {
        volunteer: v,
        reason: `same address before the @, different domain (${v.email})`,
        confidence: "high",
      };
    }
  }

  // 3. Near-identical local part — catches typo pairs like ksajnani / kaajnani.
  for (const v of volunteers) {
    if (!v.email) continue;
    const vl = localPart(v.email);
    if (vl.length > 5 && local.length > 5 && editDistance(vl, local) <= 2) {
      return {
        volunteer: v,
        reason: `address looks like a typo of ${v.email}`,
        confidence: "medium",
      };
    }
  }

  // 4. Overlapping name tokens.
  for (const v of volunteers) {
    if (!v.name) continue;
    const vt = new Set(nameTokens(v.name));
    for (const bn of bookingNames) {
      const shared = nameTokens(bn).filter((t) => vt.has(t));
      if (shared.length >= 2 || (shared.length === 1 && shared[0]!.length >= 5)) {
        return {
          volunteer: v,
          reason: `booking name "${bn}" overlaps their record`,
          confidence: "medium",
        };
      }
    }
  }

  return null;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[a.length]![b.length]!;
}

async function main() {
  const calendly = new CalendlyClient(
    requireEnv("CALENDLY_PAT"),
    optionalEnv("CALENDLY_API_BASE", "https://api.calendly.com"),
  );
  const notion = new NotionClient({
    token: requireEnv("NOTION_TOKEN"),
    apiVersion: optionalEnv("NOTION_API_VERSION", "2022-06-28"),
  });

  console.log("Reading Volunteers from Notion…");
  const volunteers = await notion.listVolunteers(requireEnv("NOTION_VOLUNTEERS_DB_ID"));
  const known = new Set(
    volunteers.filter((v) => v.email).map((v) => v.email!.trim().toLowerCase()),
  );
  console.log(`  ${volunteers.length} volunteers, ${known.size} with an email on file\n`);

  const me = await calendly.me();
  const org = optionalEnv("CALENDLY_ORG_URI", me.current_organization);

  console.log(`Walking Calendly bookings since ${since}…`);
  const seen = new Map<string, Seen>();
  let nextPageUrl: string | undefined;
  let events = 0;

  do {
    const page = await calendly.listScheduledEvents(
      nextPageUrl ? { nextPageUrl } : { organization: org, minStartTime: `${since}T00:00:00Z` },
    );
    for (const event of page.collection) {
      if (classifyEvent(event.name).kind === "skip") continue;
      if (event.status === "canceled") continue;
      events++;
      let invitees;
      try {
        invitees = await calendly.listInvitees(event.uri);
      } catch (err) {
        console.error(`  ! ${event.name} ${event.start_time}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      const date = event.start_time.slice(0, 10);
      for (const inv of invitees) {
        if (inv.status !== "active") continue;
        const email = (inv.email ?? "").trim().toLowerCase();
        if (!email || known.has(email)) continue;
        let s = seen.get(email);
        if (!s) {
          s = { email, names: new Set(), sessions: [], first: date, last: date };
          seen.set(email, s);
        }
        if (inv.name) s.names.add(inv.name.trim());
        s.sessions.push(`${date}  ${event.name.trim()}`);
        if (date < s.first) s.first = date;
        if (date > s.last) s.last = date;
      }
    }
    nextPageUrl = page.pagination.next_page ?? undefined;
  } while (nextPageUrl);

  console.log(`  ${events} sessions scanned, ${seen.size} unmatched email(s)\n`);

  const rows = [...seen.values()].sort((a, b) => b.sessions.length - a.sessions.length);
  const linked: Array<{ s: Seen; sug: Suggestion }> = [];
  const newPeople: Seen[] = [];
  for (const s of rows) {
    const sug = suggest(s, volunteers);
    if (sug) linked.push({ s, sug });
    else newPeople.push(s);
  }

  // ── console summary ──
  console.log(`── Probably an existing volunteer's second address (${linked.length}) ──`);
  for (const { s, sug } of linked) {
    console.log(
      `  ${String(s.sessions.length).padStart(2)} sessions  ${s.email.padEnd(34)} → ${sug.volunteer.name} (${sug.confidence}: ${sug.reason})`,
    );
  }
  console.log(`\n── No matching volunteer found (${newPeople.length}) ──`);
  for (const s of newPeople) {
    console.log(
      `  ${String(s.sessions.length).padStart(2)} sessions  ${s.email.padEnd(34)} ${[...s.names].join(" / ")}`,
    );
  }

  // ── markdown report ──
  const md: string[] = [];
  md.push(`# Unmatched booking emails`);
  md.push(``);
  md.push(
    `Generated ${new Date().toISOString().slice(0, 10)} · bookings since ${since} · ` +
      `${events} sessions · ${seen.size} emails with no Volunteers row.`,
  );
  md.push(``);
  md.push(
    `The sync links a booking to a volunteer by email, so these sessions are not ` +
      `counted towards anyone. Two kinds below: people who look like an existing ` +
      `volunteer booking under a second address, and people with no record at all.`,
  );
  md.push(``);
  md.push(`## Add the address to an existing record (${linked.length})`);
  md.push(``);
  md.push(`Suggestions, not certainties. Check each before editing.`);
  md.push(``);
  md.push(`| Booking email | Booked as | Sessions | Last | Likely who | Why | Confidence |`);
  md.push(`|---|---|---|---|---|---|---|`);
  for (const { s, sug } of linked) {
    md.push(
      `| \`${s.email}\` | ${[...s.names].join(" / ") || "—"} | ${s.sessions.length} | ${s.last} | ${sug.volunteer.name} | ${sug.reason} | ${sug.confidence} |`,
    );
  }
  md.push(``);
  md.push(`## No matching volunteer (${newPeople.length})`);
  md.push(``);
  md.push(`Either they need a Volunteers record, or they are staff or guests who don't need one.`);
  md.push(``);
  md.push(`| Booking email | Booked as | Sessions | First | Last |`);
  md.push(`|---|---|---|---|---|`);
  for (const s of newPeople) {
    md.push(
      `| \`${s.email}\` | ${[...s.names].join(" / ") || "—"} | ${s.sessions.length} | ${s.first} | ${s.last} |`,
    );
  }
  md.push(``);
  md.push(`## Sessions affected`);
  md.push(``);
  for (const s of rows) {
    md.push(`**${s.email}** (${[...s.names].join(" / ") || "no name"})`);
    md.push(``);
    for (const line of s.sessions.sort()) md.push(`- ${line}`);
    md.push(``);
  }
  md.push(`---`);
  md.push(``);
  md.push(
    `After fixing records in Notion, re-run \`npm run backfill -- --since=${since}\` ` +
      `to link the sessions. The backfill is idempotent and leaves Status and ` +
      `[CANCELED] titles alone.`,
  );

  const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "unmatched-report.md");
  writeFileSync(out, md.join("\n"), "utf8");
  console.log(`\n📄 Report written to: ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
