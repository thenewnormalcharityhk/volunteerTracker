// Core sync logic shared by the worker (webhook handler) and the backfill script.

import { CalendlyClient, type CalendlyInvitee, uuidFromUri } from "./calendly.js";
import { NotionClient, type GroupSyncInput, type TrainingSyncInput } from "./notion.js";
import { classifyEvent, inferLanguage, inferTutor, parseAttendanceRole } from "./mapping.js";

export interface SyncConfig {
  calendly: CalendlyClient;
  notion: NotionClient;
  groupsDbId: string;
  trainingDbId: string;
  volunteersDbId: string;
  defaultStatus: "Pending review" | "Confirmed";
}

export interface SyncOneResult {
  kind: "group" | "training" | "skip";
  reason?: string; // for skip
  groupName: string;
  // group fields
  pageId?: string | null;
  created?: boolean;
  groupType?: string;
  matchedHost?: boolean;
  matchedCoHostCount?: number;
  matchedShadowCount?: number;
  // True when at least one invitee answered the host/co-host/shadow question,
  // i.e. the roles below are declared rather than inferred from booking order.
  rolesFromCalendly?: boolean;
  // training fields
  trainingType?: string;
  trainingRowsCreated?: number;
  trainingRowsUpdated?: number;
  unmatchedEmails: string[];
}

// Sync a single Calendly scheduled event into Notion.
//   - Peer-support groups → Groups DB (Host / Co-host / Shadow relations).
//   - Training-type events → Training Log DB, one row per attendee.
//   - Excluded types (interviews) → no-op.
//
// Shadows on a peer-support group are written twice on purpose: as a Shadow
// relation on the Groups row (so the session shows who was in the room) and as
// a Training Log row (so it appears in the volunteer's training history).
export async function syncScheduledEvent(
  cfg: SyncConfig,
  eventUriOrUuid: string,
): Promise<SyncOneResult> {
  const event = await cfg.calendly.getScheduledEvent(eventUriOrUuid);
  const routing = classifyEvent(event.name);

  if (routing.kind === "skip") {
    return { kind: "skip", reason: routing.reason, groupName: event.name, unmatchedEmails: [] };
  }

  const invitees = await cfg.calendly.listInvitees(event.uri);
  const activeInvitees = invitees
    .filter((i) => i.status === "active")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const calendlyEventUuid = uuidFromUri(event.uri);
  const unmatched: string[] = [];
  const resolved = new Map<string, string | null>();
  const resolve = (inv: CalendlyInvitee) => resolveVolunteer(cfg, inv, unmatched, resolved);

  if (routing.kind === "training") {
    // One Training Log row per attendee.
    const tutor = inferTutor(event.name);
    let created = 0;
    let updated = 0;
    for (const inv of activeInvitees) {
      const volunteerPageId = await resolve(inv);
      const input: TrainingSyncInput = {
        calendlyEventUuid,
        trainingName: `${event.name} — ${inv.name}`,
        trainingType: routing.trainingType,
        date: event.start_time,
        tutor,
        attendeeEmail: inv.email,
        volunteerPageId,
      };
      const res = await cfg.notion.upsertTraining(cfg.trainingDbId, input);
      if (res.created) created++;
      else updated++;
    }
    return {
      kind: "training",
      groupName: event.name,
      trainingType: routing.trainingType,
      trainingRowsCreated: created,
      trainingRowsUpdated: updated,
      unmatchedEmails: unmatched,
    };
  }

  // routing.kind === "group"
  const roles = activeInvitees.map((inv) => ({
    inv,
    role: parseAttendanceRole(inv.questions_and_answers),
  }));
  // When nobody answered, this event type has no role question — fall back to
  // the original convention (earliest booker hosts, everyone else co-hosts).
  const rolesFromCalendly = roles.some((r) => r.role !== null);

  const declaredHosts = roles.filter((r) => r.role === "host").map((r) => r.inv);
  const declaredCoHosts = roles.filter((r) => r.role === "co-host").map((r) => r.inv);
  const shadowInvitees = roles.filter((r) => r.role === "shadow").map((r) => r.inv);
  const undeclared = roles.filter((r) => r.role === null).map((r) => r.inv);

  // Groups.Host is a single relation. If two people both answered "Host"
  // (or "Signed Off Host"), the earlier booker takes it and the rest become
  // co-hosts.
  //
  // Older versions of the booking question offered no Host option at all
  // ("Are you joining as shadow host or co-host?"), so on those sessions
  // nobody is declared host. Fall back to the earliest booker who wasn't a
  // shadow, which is the convention the sync used before roles existed.
  let hostInvitee: CalendlyInvitee | null = declaredHosts[0] ?? null;
  let coHostInvitees = [...declaredCoHosts, ...declaredHosts.slice(1), ...undeclared];
  if (!hostInvitee) {
    coHostInvitees.sort((a, b) => a.created_at.localeCompare(b.created_at));
    hostInvitee = coHostInvitees.shift() ?? null;
  }
  // Preserve booking order within each role.
  const byBooking = (a: CalendlyInvitee, b: CalendlyInvitee) =>
    a.created_at.localeCompare(b.created_at);
  coHostInvitees.sort(byBooking);

  const hostPageId = hostInvitee ? await resolve(hostInvitee) : null;

  const coHostPageIds: string[] = [];
  for (const inv of coHostInvitees) {
    const id = await resolve(inv);
    if (id) coHostPageIds.push(id);
  }

  const shadowPageIds: string[] = [];
  for (const inv of shadowInvitees) {
    const id = await resolve(inv);
    if (id) shadowPageIds.push(id);
  }

  const input: GroupSyncInput = {
    calendlyEventUuid,
    groupName: event.name,
    date: event.start_time,
    groupType: routing.groupType,
    language: inferLanguage(event.name),
    hostVolunteerPageId: hostPageId,
    coHostVolunteerPageIds: coHostPageIds,
    shadowVolunteerPageIds: shadowPageIds,
    // Calendly knows the full picture only when roles were declared. In that
    // case overwrite Co-host and Shadow outright, so someone who moved from
    // co-host to shadow (or vice versa) doesn't linger in both. Without role
    // data we leave existing relations alone rather than wiping a coordinator's
    // manual wiring.
    replaceRelations: rolesFromCalendly,
    location: event.location?.location ?? event.location?.type ?? null,
    status: cfg.defaultStatus,
  };

  const res = await cfg.notion.upsertGroup(cfg.groupsDbId, input);

  // A shadowed session is also a training entry for that volunteer.
  let trainingCreated = 0;
  let trainingUpdated = 0;
  for (const inv of shadowInvitees) {
    const training: TrainingSyncInput = {
      calendlyEventUuid,
      trainingName: `${event.name} — ${inv.name} (Shadow)`,
      trainingType: "Shadow session",
      date: event.start_time,
      tutor: null,
      attendeeEmail: inv.email,
      volunteerPageId: resolved.get(inv.email.toLowerCase()) ?? null,
    };
    const t = await cfg.notion.upsertTraining(cfg.trainingDbId, training);
    if (t.created) trainingCreated++;
    else trainingUpdated++;
  }

  return {
    kind: "group",
    groupName: event.name,
    pageId: res.pageId,
    created: res.created,
    groupType: routing.groupType,
    matchedHost: hostPageId !== null,
    matchedCoHostCount: coHostPageIds.length,
    matchedShadowCount: shadowPageIds.length,
    rolesFromCalendly,
    trainingRowsCreated: trainingCreated,
    trainingRowsUpdated: trainingUpdated,
    unmatchedEmails: unmatched,
  };
}

async function resolveVolunteer(
  cfg: SyncConfig,
  invitee: CalendlyInvitee,
  unmatched: string[],
  cache: Map<string, string | null>,
): Promise<string | null> {
  const key = invitee.email.toLowerCase();
  if (cache.has(key)) return cache.get(key) ?? null;
  const id = await cfg.notion.findVolunteerByEmail(cfg.volunteersDbId, invitee.email);
  cache.set(key, id);
  if (!id) unmatched.push(invitee.email);
  return id;
}
