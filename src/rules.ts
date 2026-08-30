// Daily alert rule engine — PDF Section 5 scenarios 2,3,4,5,7,8,9.
//
// Pure functions: given a snapshot of Notion data + thresholds + "now", they
// return a list of Alert objects. The orchestrator (alerts.ts) decides what to
// actually send / mutate, and handles KV dedupe. Keeping this pure makes it
// trivially testable and safe to dry-run.

import type { VolunteerRow, GroupRow, ConcernFlagRow, NoteInput } from "./notion.js";
import type { OutgoingMessage } from "./notify.js";

export interface Thresholds {
  hostInactiveDays: number;
  shadowInactiveDays: number;
  inTrainingStaleDays: number;
  milestoneGroups: number;
  frequentWeekLimit: number;
  frequentMonthLimit: number;
  shadowSignoffPrompt: number;
  shadowSignoffEscalate: number;
  shadowReadinessGroups: number;
}

export interface Recipients {
  coordinator: string;
  ceo: string;
  dsl: string;
}

export interface RuleConfig {
  thresholds: Thresholds;
  recipients: Recipients;
  now: Date;
}

export interface Alert {
  rule: string;
  volunteerId: string;
  volunteerName: string;
  // If set and already present in KV, the orchestrator skips this alert.
  dedupeKey?: string;
  dedupeTtlSec?: number;
  messages: OutgoingMessage[];
  mutation?: { status: string };
  note?: Omit<NoteInput, "flagsDbId">;
}

const ACTIVE_HOST_STATUSES = new Set(["Active Host", "Buddy Host"]);

// Per-volunteer session history, split by the role they booked in.
//
// Sessions where they hosted or co-hosted ("hosted") drive the host rules:
// inactivity (3), frequent host (7) and milestones (4). Sessions they
// shadowed drive the shadow progression rules: sign-off (8) and readiness (9).
// Shadow inactivity (2) uses every session in any role, so a shadow who is
// easing into co-hosting isn't flagged as having gone quiet.
interface Agg {
  v: VolunteerRow;
  hostedDates: Date[]; // desc, excluding canceled
  shadowDates: Date[]; // desc, excluding canceled
  allDates: Date[]; // desc, union of the two
  hostedTotal: number;
  shadowTotal: number;
  lastHosted: Date | null;
  lastAny: Date | null;
}

function notionUrl(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, "")}`;
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / 86_400_000);
}

function countWithin(dates: Date[], now: Date, days: number): number {
  const cutoff = now.getTime() - days * 86_400_000;
  return dates.filter((d) => d.getTime() >= cutoff).length;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// week / month buckets for periodic dedupe keys
function weekBucket(d: Date): string {
  const onejan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - onejan.getTime()) / 86_400_000 + onejan.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}W${week}`;
}
function monthBucket(d: Date): string {
  return `${d.getUTCFullYear()}M${d.getUTCMonth() + 1}`;
}

// Build per-volunteer aggregation of the groups they took part in, keeping
// hosted and shadowed sessions apart. Shadow membership comes from the Groups
// DB "Shadow" relation, populated from the Calendly booking question
// "Are you joining as host / co-host / shadow host?".
export function aggregate(volunteers: VolunteerRow[], groups: GroupRow[]): Map<string, Agg> {
  const byId = new Map<string, Agg>();
  for (const v of volunteers) {
    byId.set(v.id, {
      v,
      hostedDates: [],
      shadowDates: [],
      allDates: [],
      hostedTotal: 0,
      shadowTotal: 0,
      lastHosted: null,
      lastAny: null,
    });
  }

  for (const g of groups) {
    if (!g.date) continue;
    if (g.name.startsWith("[CANCELED]")) continue;
    const d = new Date(g.date);
    if (Number.isNaN(d.getTime())) continue;

    const shadows = new Set(g.shadowIds);
    for (const pid of shadows) {
      byId.get(pid)?.shadowDates.push(d);
    }
    // A shadow on a session isn't also counted as having hosted it.
    for (const pid of new Set([...g.hostIds, ...g.coHostIds])) {
      if (shadows.has(pid)) continue;
      byId.get(pid)?.hostedDates.push(d);
    }
  }

  const desc = (a: Date, b: Date) => b.getTime() - a.getTime();
  for (const agg of byId.values()) {
    agg.hostedDates.sort(desc);
    agg.shadowDates.sort(desc);
    agg.allDates = [...agg.hostedDates, ...agg.shadowDates].sort(desc);
    agg.hostedTotal = agg.hostedDates.length;
    agg.shadowTotal = agg.shadowDates.length;
    agg.lastHosted = agg.hostedDates[0] ?? null;
    agg.lastAny = agg.allDates[0] ?? null;
  }
  return byId;
}

export function runRules(
  cfg: RuleConfig,
  volunteers: VolunteerRow[],
  groups: GroupRow[],
  openFlags: ConcernFlagRow[],
): Alert[] {
  const { thresholds: t, recipients: r, now } = cfg;
  const agg = aggregate(volunteers, groups);
  const alerts: Alert[] = [];
  const coordOnly = (subject: string, body: string): OutgoingMessage => ({
    subject,
    body,
    channels: ["slack", "email"],
    emailTo: [r.coordinator],
  });

  for (const v of volunteers) {
    const a = agg.get(v.id);
    if (!a) continue;
    const status = v.status ?? "";
    const link = notionUrl(v.id);

    // ── Scenario 5: Safeguarding flag → On Hold ──
    const hasOpenFlag = openFlags.some((f) => f.volunteerIds.includes(v.id));
    if (hasOpenFlag && status !== "On Hold") {
      alerts.push({
        rule: "safeguarding-on-hold",
        volunteerId: v.id,
        volunteerName: v.name,
        messages: [
          {
            subject: `🚩 Safeguarding: ${v.name} has an open concern flag`,
            body: `${v.name} has an OPEN concern flag and is being set to On Hold. Please review.\n${link}`,
            channels: ["slack", "email"],
            emailTo: [r.coordinator, r.ceo, r.dsl],
          },
        ],
        mutation: { status: "On Hold" },
        note: {
          volunteerId: v.id,
          type: "System",
          summary: "Auto-set to On Hold — open concern flag",
          content: "Status automatically set to On Hold because an open concern flag exists (Scenario 5).",
          addedBy: "System (daily alerts)",
          dateAddedIso: isoDate(now),
          visibleToVolunteer: false,
        },
      });
      // Don't pile other nudges on a flagged volunteer.
      continue;
    }

    // ── Scenario 3: Host inactivity → Check in ──
    if (
      ACTIVE_HOST_STATUSES.has(status) &&
      a.lastHosted &&
      daysBetween(now, a.lastHosted) > t.hostInactiveDays
    ) {
      const days = daysBetween(now, a.lastHosted);
      alerts.push({
        rule: "host-inactivity",
        volunteerId: v.id,
        volunteerName: v.name,
        messages: [
          coordOnly(
            `⏰ ${v.name} hasn't hosted in ${days} days → Check in`,
            `${v.name} (was ${status}) last hosted ${isoDate(a.lastHosted)} — ${days} days ago. Status set to "Check in".\n${link}`,
          ),
        ],
        mutation: { status: "Check in" },
        note: {
          volunteerId: v.id,
          type: "System",
          summary: `Auto-set to Check in — ${days} days since last hosted`,
          content: `No hosted session since ${isoDate(a.lastHosted)} (> ${t.hostInactiveDays} days). Status set to Check in (Scenario 3).`,
          addedBy: "System (daily alerts)",
          dateAddedIso: isoDate(now),
          visibleToVolunteer: false,
        },
      });
      continue;
    }

    // ── Scenario 7: Frequent host ──
    if (ACTIVE_HOST_STATUSES.has(status)) {
      const wk = countWithin(a.hostedDates, now, 7);
      const mo = countWithin(a.hostedDates, now, 30);
      if (wk > t.frequentWeekLimit || mo > t.frequentMonthLimit) {
        alerts.push({
          rule: "frequent-host",
          volunteerId: v.id,
          volunteerName: v.name,
          dedupeKey: `frequent:${v.id}:${weekBucket(now)}`,
          messages: [
            coordOnly(
              `🔥 Frequent host: ${v.name}`,
              `${v.name} has hosted ${wk} group(s) in the last 7 days and ${mo} in the last 30. Consider a wellbeing check-in.\n${link}`,
            ),
          ],
        });
      }
    }

    // ── Scenario 2: Shadow / In-Training inactivity ──
    if (status === "In Training" && v.dateOfApplication) {
      const joined = new Date(v.dateOfApplication);
      if (!Number.isNaN(joined.getTime()) && daysBetween(now, joined) > t.inTrainingStaleDays) {
        alerts.push({
          rule: "in-training-stale",
          volunteerId: v.id,
          volunteerName: v.name,
          dedupeKey: `in-training-stale:${v.id}:${weekBucket(now)}`,
          messages: [
            coordOnly(
              `🐢 ${v.name} still In Training after ${daysBetween(now, joined)} days`,
              `${v.name} joined ${isoDate(joined)} and is still In Training (> ${t.inTrainingStaleDays} days). Check in.\n${link}`,
            ),
          ],
        });
      }
    }
    if (status === "Shadow") {
      const noShadow = !a.lastAny || daysBetween(now, a.lastAny) > t.shadowInactiveDays;
      if (noShadow) {
        const detail = a.lastAny
          ? `last session ${isoDate(a.lastAny)} (${daysBetween(now, a.lastAny)} days ago, ${a.shadowTotal} shadowed in total)`
          : "no sessions logged yet";
        alerts.push({
          rule: "shadow-inactivity",
          volunteerId: v.id,
          volunteerName: v.name,
          dedupeKey: `shadow-inactivity:${v.id}:${weekBucket(now)}`,
          messages: [
            coordOnly(
              `🌑 Shadow inactive: ${v.name}`,
              `${v.name} (Shadow) — ${detail}; threshold is ${t.shadowInactiveDays} days. Check in.\n${link}`,
            ),
          ],
        });
      }
    }

    // ── Scenario 8 + 9: Shadow progression ──
    if (status === "Shadow") {
      if (a.shadowTotal >= t.shadowSignoffEscalate) {
        alerts.push({
          rule: "shadow-signoff-escalate",
          volunteerId: v.id,
          volunteerName: v.name,
          dedupeKey: `signoff-escalate:${v.id}`,
          messages: [
            coordOnly(
              `📣 ${v.name} still Shadow at ${a.shadowTotal} shadowed sessions`,
              `${v.name} has shadowed ${a.shadowTotal} sessions but is still Shadow (≥ ${t.shadowSignoffEscalate}). Coordinator check-in needed (Scenario 8b).\n${link}`,
            ),
          ],
        });
      } else if (a.shadowTotal >= t.shadowSignoffPrompt) {
        alerts.push({
          rule: "shadow-signoff-prompt",
          volunteerId: v.id,
          volunteerName: v.name,
          dedupeKey: `signoff-prompt:${v.id}`,
          messages: [
            coordOnly(
              `✅ ${v.name} ready for sign-off? (${a.shadowTotal} shadowed sessions)`,
              `${v.name} (Shadow) has shadowed ${a.shadowTotal} sessions (≥ ${t.shadowSignoffPrompt}). Prompt the buddy host: "Are you ready to sign off?" (Scenario 8).\n${link}`,
            ),
          ],
        });
      }
      const recent = countWithin(a.shadowDates, now, 90);
      if (recent > t.shadowReadinessGroups) {
        alerts.push({
          rule: "shadow-readiness",
          volunteerId: v.id,
          volunteerName: v.name,
          dedupeKey: `readiness:${v.id}:${monthBucket(now)}`,
          messages: [
            coordOnly(
              `🧭 ${v.name}: ${recent} shadowed sessions in 3 months`,
              `${v.name} (Shadow) shadowed ${recent} sessions in the last 3 months (> ${t.shadowReadinessGroups}). Check in — not yet ready for sign-off (Scenario 9).\n${link}`,
            ),
          ],
        });
      }
    }

    // ── Scenario 4: Milestones ──
    if (a.hostedTotal === 1) {
      alerts.push({
        rule: "milestone-first-group",
        volunteerId: v.id,
        volunteerName: v.name,
        dedupeKey: `milestone1:${v.id}`,
        messages: [
          coordOnly(
            `🎉 ${v.name} hosted their first group!`,
            `${v.name} has just hosted their first group. A nice moment to acknowledge (Scenario 4ii).\n${link}`,
          ),
        ],
        note: {
          volunteerId: v.id,
          type: "Milestone",
          summary: "First group hosted",
          content: "Volunteer hosted their first group (Scenario 4ii).",
          addedBy: "System (daily alerts)",
          dateAddedIso: isoDate(now),
          visibleToVolunteer: false,
        },
      });
    }
    if (a.hostedTotal >= t.milestoneGroups) {
      const msgs: OutgoingMessage[] = [
        coordOnly(
          `🏅 Milestone: ${v.name} reached ${t.milestoneGroups} groups`,
          `${v.name} has hosted ${a.hostedTotal} groups (milestone ${t.milestoneGroups}). A personalised email ${v.email ? "has been sent to them" : "could not be sent (no email on file)"}.\n${link}`,
        ),
      ];
      if (v.email) {
        msgs.push({
          subject: `Thank you for hosting ${t.milestoneGroups} groups with The New Normal 💛`,
          body:
            `Hi ${v.name.split(" ")[0]},\n\n` +
            `You've now hosted ${t.milestoneGroups} peer-support groups with The New Normal. ` +
            `That's a real milestone, and a lot of people have felt less alone because of you. Thank you.\n\n` +
            `With gratitude,\nThe New Normal team`,
          channels: ["email"],
          emailTo: [v.email],
        });
      }
      alerts.push({
        rule: "milestone-10-groups",
        volunteerId: v.id,
        volunteerName: v.name,
        dedupeKey: `milestone${t.milestoneGroups}:${v.id}`,
        messages: msgs,
        note: {
          volunteerId: v.id,
          type: "Milestone",
          summary: `${t.milestoneGroups} groups hosted`,
          content: `Reached ${a.hostedTotal} groups hosted (milestone ${t.milestoneGroups}). Personalised email ${v.email ? "sent" : "skipped — no email"} (Scenario 4i).`,
          addedBy: "System (daily alerts)",
          dateAddedIso: isoDate(now),
          visibleToVolunteer: false,
        },
      });
    }
  }

  return alerts;
}
