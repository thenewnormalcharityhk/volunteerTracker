// Core sync logic shared by the worker (webhook handler) and the backfill script.

import { CalendlyClient, type CalendlyInvitee, uuidFromUri } from "./calendly.js";
import { NotionClient, type GroupSyncInput, type TrainingSyncInput } from "./notion.js";
import { classifyEvent, inferLanguage, inferTutor } from "./mapping.js";

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
  // training fields
  trainingType?: string;
  trainingRowsCreated?: number;
  trainingRowsUpdated?: number;
  unmatchedEmails: string[];
}

// Sync a single Calendly scheduled event into Notion.
//   - Peer-support groups → Groups DB (Host = first invitee, Co-hosts = rest).
//   - Training-type events → Training Log DB, one row per attendee.
//   - Excluded types (interviews) → no-op.
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

  if (routing.kind === "training") {
    // One Training Log row per attendee.
    const tutor = inferTutor(event.name);
    let created = 0;
    let updated = 0;
    for (const inv of activeInvitees) {
      const volunteerPageId = await resolveVolunteer(cfg, inv, unmatched);
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
  const hostInvitee = activeInvitees[0] ?? null;
  const coHostInvitees = activeInvitees.slice(1);

  const hostPageId = hostInvitee ? await resolveVolunteer(cfg, hostInvitee, unmatched) : null;
  const coHostPageIds: string[] = [];
  for (const inv of coHostInvitees) {
    const id = await resolveVolunteer(cfg, inv, unmatched);
    if (id) coHostPageIds.push(id);
  }

  const input: GroupSyncInput = {
    calendlyEventUuid,
    groupName: event.name,
    date: event.start_time,
    groupType: routing.groupType,
    language: inferLanguage(event.name),
    hostVolunteerPageId: hostPageId,
    coHostVolunteerPageIds: coHostPageIds,
    location: event.location?.location ?? event.location?.type ?? null,
    status: cfg.defaultStatus,
  };

  const res = await cfg.notion.upsertGroup(cfg.groupsDbId, input);

  return {
    kind: "group",
    groupName: event.name,
    pageId: res.pageId,
    created: res.created,
    groupType: routing.groupType,
    matchedHost: hostPageId !== null,
    matchedCoHostCount: coHostPageIds.length,
    unmatchedEmails: unmatched,
  };
}

async function resolveVolunteer(
  cfg: SyncConfig,
  invitee: CalendlyInvitee,
  unmatched: string[],
): Promise<string | null> {
  const id = await cfg.notion.findVolunteerByEmail(cfg.volunteersDbId, invitee.email);
  if (!id) unmatched.push(invitee.email);
  return id;
}
