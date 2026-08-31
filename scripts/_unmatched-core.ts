// Shared logic: find Calendly booking emails with no Volunteers row, and work
// out which look like an existing volunteer using a second address.
//
// Used by scripts/unmatched.ts (console + markdown report) and
// scripts/christy-page.ts (Notion page).

import { CalendlyClient } from "../src/calendly.js";
import { NotionClient, type VolunteerRow } from "../src/notion.js";
import { classifyEvent } from "../src/mapping.js";

export interface Seen {
  email: string;
  names: string[];
  sessions: string[]; // "2026-08-03  Otherwise Employed"
  first: string;
  last: string;
}

export interface Suggestion {
  volunteer: VolunteerRow;
  reason: string;
  confidence: "high" | "medium";
}

export interface Collected {
  events: number;
  volunteers: number;
  linked: Array<{ s: Seen; sug: Suggestion }>;
  newPeople: Seen[];
}

const strip = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const localPart = (e: string) => e.toLowerCase().split("@")[0] ?? "";

function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .split(/[^a-z]+/)
    .filter((t) => t.length > 2);
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

export function suggest(seen: Seen, volunteers: VolunteerRow[]): Suggestion | null {
  const local = localPart(seen.email);

  for (const v of volunteers) {
    if (!v.name) continue;
    for (const bn of seen.names) {
      if (strip(bn) && strip(bn) === strip(v.name)) {
        return { volunteer: v, reason: "same name as their record", confidence: "high" };
      }
    }
  }
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
  for (const v of volunteers) {
    if (!v.email) continue;
    const vl = localPart(v.email);
    if (vl.length > 5 && local.length > 5 && editDistance(vl, local) <= 2) {
      return { volunteer: v, reason: `looks like a typo of ${v.email}`, confidence: "medium" };
    }
  }
  for (const v of volunteers) {
    if (!v.name) continue;
    const vt = new Set(nameTokens(v.name));
    for (const bn of seen.names) {
      const shared = nameTokens(bn).filter((t) => vt.has(t));
      if (shared.length >= 2 || (shared.length === 1 && shared[0]!.length >= 5)) {
        return { volunteer: v, reason: `booking name "${bn}" overlaps their record`, confidence: "medium" };
      }
    }
  }
  return null;
}

export async function collectUnmatched(opts: {
  calendly: CalendlyClient;
  notion: NotionClient;
  volunteersDbId: string;
  organization: string;
  since: string;
  log?: (msg: string) => void;
}): Promise<Collected> {
  const log = opts.log ?? (() => {});

  const volunteers = await opts.notion.listVolunteers(opts.volunteersDbId);
  const known = new Set(volunteers.filter((v) => v.email).map((v) => v.email!.trim().toLowerCase()));
  log(`  ${volunteers.length} volunteers, ${known.size} with an email on file`);

  const seen = new Map<string, Seen & { nameSet: Set<string> }>();
  let nextPageUrl: string | undefined;
  let events = 0;

  do {
    const page = await opts.calendly.listScheduledEvents(
      nextPageUrl
        ? { nextPageUrl }
        : { organization: opts.organization, minStartTime: `${opts.since}T00:00:00Z` },
    );
    for (const event of page.collection) {
      if (classifyEvent(event.name).kind === "skip") continue;
      if (event.status === "canceled") continue;
      events++;
      let invitees;
      try {
        invitees = await opts.calendly.listInvitees(event.uri);
      } catch (err) {
        log(`  ! ${event.name} ${event.start_time}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      const date = event.start_time.slice(0, 10);
      for (const inv of invitees) {
        if (inv.status !== "active") continue;
        const email = (inv.email ?? "").trim().toLowerCase();
        if (!email || known.has(email)) continue;
        let s = seen.get(email);
        if (!s) {
          s = { email, names: [], nameSet: new Set(), sessions: [], first: date, last: date };
          seen.set(email, s);
        }
        if (inv.name && !s.nameSet.has(inv.name.trim())) {
          s.nameSet.add(inv.name.trim());
          s.names.push(inv.name.trim());
        }
        s.sessions.push(`${date}  ${event.name.trim()}`);
        if (date < s.first) s.first = date;
        if (date > s.last) s.last = date;
      }
    }
    nextPageUrl = page.pagination.next_page ?? undefined;
  } while (nextPageUrl);

  const rows = [...seen.values()].sort((a, b) => b.sessions.length - a.sessions.length);
  const linked: Array<{ s: Seen; sug: Suggestion }> = [];
  const newPeople: Seen[] = [];
  for (const s of rows) {
    const sug = suggest(s, volunteers);
    if (sug) linked.push({ s, sug });
    else newPeople.push(s);
  }

  return { events, volunteers: volunteers.length, linked, newPeople };
}
