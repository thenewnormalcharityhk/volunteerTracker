// Notion REST client + Group page upsert logic.
// API ref: https://developers.notion.com/reference/intro

import type { GroupType, Language, TrainingType } from "./mapping.js";

export interface NotionClientConfig {
  token: string;
  apiVersion: string;
}

export interface GroupSyncInput {
  calendlyEventUuid: string;
  groupName: string;
  date: string; // ISO start time
  groupType: GroupType;
  language: Language | null;
  hostVolunteerPageId: string | null;
  coHostVolunteerPageIds: string[];
  shadowVolunteerPageIds: string[];
  // When true, Co-host and Shadow are written even if empty, so a role change
  // in Calendly clears the old value. Set only when Calendly supplied roles.
  replaceRelations: boolean;
  location: string | null;
  status: "Pending review" | "Confirmed";
}

export interface UpsertResult {
  pageId: string;
  created: boolean;
}

// ── Parsed entities used by the daily alert engine ──
export interface VolunteerRow {
  id: string;
  name: string;
  email: string | null;
  status: string | null;
  dateOfApplication: string | null; // ISO date or null
}

export interface GroupRow {
  id: string;
  name: string;
  date: string | null; // ISO
  type: string | null;
  status: string | null; // Pending review | Confirmed
  hostIds: string[];
  coHostIds: string[];
  shadowIds: string[];
}

export interface ConcernFlagRow {
  id: string;
  summary: string;
  status: string | null; // Open | Resolved
  dateAdded: string | null;
  volunteerIds: string[];
}

export interface NoteInput {
  flagsDbId: string;
  volunteerId: string | null;
  type: "Note" | "Concern flag" | "Milestone" | "Buddy check-in" | "System";
  summary: string;
  content: string;
  addedBy: string;
  dateAddedIso: string;
  visibleToVolunteer: boolean;
}

export interface TrainingSyncInput {
  calendlyEventUuid: string;
  trainingName: string; // title, e.g. "Refresher Training — Ada Chung"
  trainingType: TrainingType;
  date: string; // ISO start time
  tutor: string | null;
  attendeeEmail: string;
  volunteerPageId: string | null; // null when email isn't a known volunteer
}

export class NotionClient {
  constructor(private readonly cfg: NotionClientConfig) {}

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`https://api.notion.com/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        "Notion-Version": this.cfg.apiVersion,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(`Notion ${init.method ?? "GET"} ${path} failed ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  // ---- Volunteers DB lookup ----

  // Returns the Notion page ID of the volunteer with this email,
  // or null if no match. Email comparison is case-insensitive on
  // Notion's side (built into the email-property equals filter).
  async findVolunteerByEmail(
    volunteersDataSourceId: string,
    email: string,
  ): Promise<string | null> {
    const res = await this.req<{ results: Array<{ id: string }> }>(
      `/databases/${volunteersDataSourceId}/query`,
      {
        method: "POST",
        body: JSON.stringify({
          filter: {
            property: "Email",
            email: { equals: email },
          },
          page_size: 1,
        }),
      },
    );
    return res.results[0]?.id ?? null;
  }

  // ---- Groups DB upsert ----

  // Look up an existing Group page by Calendly Event ID.
  async findGroupByCalendlyEventId(
    groupsDataSourceId: string,
    calendlyEventUuid: string,
  ): Promise<string | null> {
    const res = await this.req<{ results: Array<{ id: string }> }>(
      `/databases/${groupsDataSourceId}/query`,
      {
        method: "POST",
        body: JSON.stringify({
          filter: {
            property: "Calendly Event ID",
            rich_text: { equals: calendlyEventUuid },
          },
          page_size: 1,
        }),
      },
    );
    return res.results[0]?.id ?? null;
  }

  async upsertGroup(
    groupsDataSourceId: string,
    input: GroupSyncInput,
  ): Promise<UpsertResult> {
    const existingId = await this.findGroupByCalendlyEventId(
      groupsDataSourceId,
      input.calendlyEventUuid,
    );

    const properties = buildGroupProperties(input);

    if (existingId) {
      // Don't clobber the coordinator's work on a re-sync or backfill:
      //   - Status is theirs once the row exists. Writing the default back
      //     would flip every Confirmed row to Pending review.
      //   - Keep a [CANCELED] prefix that markGroupCanceled added, otherwise
      //     re-syncing a cancelled session quietly un-cancels its title.
      delete properties.Status;
      const current = await this.req<{
        properties: Record<string, { type: string; title?: Array<{ plain_text: string }> }>;
      }>(`/pages/${existingId}`);
      const currentTitle =
        Object.values(current.properties)
          .find((p) => p.type === "title")
          ?.title?.map((t) => t.plain_text)
          .join("") ?? "";
      if (currentTitle.startsWith("[CANCELED]")) {
        properties["Group Name"] = {
          title: [{ text: { content: `[CANCELED] ${input.groupName}` } }],
        };
      }
      await this.req(`/pages/${existingId}`, {
        method: "PATCH",
        body: JSON.stringify({ properties }),
      });
      return { pageId: existingId, created: false };
    }

    const res = await this.req<{ id: string }>("/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { database_id: groupsDataSourceId },
        properties,
      }),
    });
    return { pageId: res.id, created: true };
  }

  // ---- Training Log upsert ----

  // Idempotency key for a training row = (Calendly Event ID + Attendee Email).
  // One Calendly training event produces one row per attendee.
  async findTrainingRow(
    trainingDbId: string,
    calendlyEventUuid: string,
    attendeeEmail: string,
  ): Promise<string | null> {
    const res = await this.req<{ results: Array<{ id: string }> }>(
      `/databases/${trainingDbId}/query`,
      {
        method: "POST",
        body: JSON.stringify({
          filter: {
            and: [
              { property: "Calendly Event ID", rich_text: { equals: calendlyEventUuid } },
              { property: "Attendee Email", email: { equals: attendeeEmail } },
            ],
          },
          page_size: 1,
        }),
      },
    );
    return res.results[0]?.id ?? null;
  }

  async upsertTraining(trainingDbId: string, input: TrainingSyncInput): Promise<UpsertResult> {
    const existingId = await this.findTrainingRow(
      trainingDbId,
      input.calendlyEventUuid,
      input.attendeeEmail,
    );
    const properties = buildTrainingProperties(input);

    if (existingId) {
      await this.req(`/pages/${existingId}`, {
        method: "PATCH",
        body: JSON.stringify({ properties }),
      });
      return { pageId: existingId, created: false };
    }

    const res = await this.req<{ id: string }>("/pages", {
      method: "POST",
      body: JSON.stringify({ parent: { database_id: trainingDbId }, properties }),
    });
    return { pageId: res.id, created: true };
  }

  // Mark a Group page as canceled by changing its Status. Status select
  // in the schema only has "Pending review" / "Confirmed" — we add a
  // free-text marker in the Group Name suffix until a "Canceled" status
  // option is added by the coordinator.
  async markGroupCanceled(groupsDataSourceId: string, calendlyEventUuid: string): Promise<void> {
    const pageId = await this.findGroupByCalendlyEventId(groupsDataSourceId, calendlyEventUuid);
    if (!pageId) return;
    // Fetch current title to prepend [CANCELED]
    const page = await this.req<{
      properties: Record<string, { type: string; title?: Array<{ plain_text: string }> }>;
    }>(`/pages/${pageId}`);
    const titleProp = Object.values(page.properties).find((p) => p.type === "title");
    const currentTitle = titleProp?.title?.map((t) => t.plain_text).join("") ?? "";
    const newTitle = currentTitle.startsWith("[CANCELED]") ? currentTitle : `[CANCELED] ${currentTitle}`;

    await this.req(`/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          "Group Name": { title: [{ text: { content: newTitle } }] },
        },
      }),
    });
  }

  // ── Read helpers for the daily alert engine ──

  // Page through every row of a database (no filter = all rows).
  private async queryAll(databaseId: string, body: Record<string, unknown> = {}): Promise<NotionPage[]> {
    const out: NotionPage[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.req<{ results: NotionPage[]; has_more: boolean; next_cursor: string | null }>(
        `/databases/${databaseId}/query`,
        { method: "POST", body: JSON.stringify({ ...body, page_size: 100, start_cursor: cursor }) },
      );
      out.push(...res.results);
      cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
    } while (cursor);
    return out;
  }

  async listVolunteers(volunteersDbId: string): Promise<VolunteerRow[]> {
    const pages = await this.queryAll(volunteersDbId);
    return pages.map((p) => ({
      id: p.id,
      name: plainTitle(p),
      email: readEmail(p, "Email"),
      status: readSelect(p, "Status"),
      dateOfApplication: readDateStart(p, "Date of Application"),
    }));
  }

  async listGroups(groupsDbId: string): Promise<GroupRow[]> {
    const pages = await this.queryAll(groupsDbId);
    return pages.map((p) => ({
      id: p.id,
      name: plainTitle(p),
      date: readDateStart(p, "Date"),
      type: readSelect(p, "Group Type"),
      status: readSelect(p, "Status"),
      hostIds: readRelation(p, "Host"),
      coHostIds: readRelation(p, "Co-host"),
      shadowIds: readRelation(p, "Shadow"),
    }));
  }

  async listOpenConcernFlags(flagsDbId: string): Promise<ConcernFlagRow[]> {
    const pages = await this.queryAll(flagsDbId, {
      filter: {
        and: [
          { property: "Type", select: { equals: "Concern flag" } },
          { property: "Flag Status", select: { equals: "Open" } },
        ],
      },
    });
    return pages.map((p) => ({
      id: p.id,
      summary: plainTitle(p),
      status: readSelect(p, "Flag Status"),
      dateAdded: readDateStart(p, "Date Added"),
      volunteerIds: readRelation(p, "Volunteer"),
    }));
  }

  // ── Mutations used by the alert engine ──

  async updateVolunteerStatus(volunteerId: string, status: string): Promise<void> {
    await this.req(`/pages/${volunteerId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: { Status: { select: { name: status } } } }),
    });
  }

  async createNote(input: NoteInput): Promise<string> {
    const properties: Record<string, unknown> = {
      Summary: { title: [{ text: { content: input.summary } }] },
      Type: { select: { name: input.type } },
      Content: { rich_text: [{ text: { content: input.content } }] },
      "Date Added": { date: { start: input.dateAddedIso } },
      "Added By": { rich_text: [{ text: { content: input.addedBy } }] },
      "Visible to Volunteer": { checkbox: input.visibleToVolunteer },
    };
    if (input.volunteerId) {
      properties.Volunteer = { relation: [{ id: input.volunteerId }] };
    }
    const res = await this.req<{ id: string }>("/pages", {
      method: "POST",
      body: JSON.stringify({ parent: { database_id: input.flagsDbId }, properties }),
    });
    return res.id;
  }
}

// ── Minimal Notion page-shape parsing helpers ──
interface NotionPage {
  id: string;
  properties: Record<string, NotionProp>;
}
type NotionProp = {
  type: string;
  title?: Array<{ plain_text: string }>;
  rich_text?: Array<{ plain_text: string }>;
  email?: string | null;
  select?: { name: string } | null;
  date?: { start: string | null } | null;
  relation?: Array<{ id: string }>;
};

function findProp(page: NotionPage, name: string): NotionProp | undefined {
  return page.properties[name];
}
function plainTitle(page: NotionPage): string {
  const t = Object.values(page.properties).find((p) => p.type === "title");
  return t?.title?.map((x) => x.plain_text).join("") ?? "";
}
function readEmail(page: NotionPage, name: string): string | null {
  return findProp(page, name)?.email ?? null;
}
function readSelect(page: NotionPage, name: string): string | null {
  return findProp(page, name)?.select?.name ?? null;
}
function readDateStart(page: NotionPage, name: string): string | null {
  return findProp(page, name)?.date?.start ?? null;
}
function readRelation(page: NotionPage, name: string): string[] {
  return (findProp(page, name)?.relation ?? []).map((r) => r.id);
}

function buildGroupProperties(input: GroupSyncInput): Record<string, unknown> {
  const props: Record<string, unknown> = {
    "Group Name": { title: [{ text: { content: input.groupName } }] },
    "Group Type": { select: { name: input.groupType } },
    Date: { date: { start: input.date } },
    Status: { select: { name: input.status } },
    "Calendly Event ID": {
      rich_text: [{ text: { content: input.calendlyEventUuid } }],
    },
  };
  if (input.language) {
    props.Language = { select: { name: input.language } };
  }
  if (input.hostVolunteerPageId) {
    props.Host = { relation: [{ id: input.hostVolunteerPageId }] };
  }
  if (input.replaceRelations || input.coHostVolunteerPageIds.length > 0) {
    props["Co-host"] = {
      relation: input.coHostVolunteerPageIds.map((id) => ({ id })),
    };
  }
  if (input.replaceRelations || input.shadowVolunteerPageIds.length > 0) {
    props.Shadow = {
      relation: input.shadowVolunteerPageIds.map((id) => ({ id })),
    };
  }
  return props;
}

function buildTrainingProperties(input: TrainingSyncInput): Record<string, unknown> {
  const props: Record<string, unknown> = {
    "Training Name": { title: [{ text: { content: input.trainingName } }] },
    "Training Type": { select: { name: input.trainingType } },
    Date: { date: { start: input.date } },
    Attendance: { select: { name: "Attended" } },
    Source: { select: { name: "Calendly sync" } },
    "Attendee Email": { email: input.attendeeEmail },
    "Calendly Event ID": { rich_text: [{ text: { content: input.calendlyEventUuid } }] },
  };
  if (input.tutor) {
    props["Tutor / Provider"] = { rich_text: [{ text: { content: input.tutor } }] };
  }
  if (input.volunteerPageId) {
    props.Volunteer = { relation: [{ id: input.volunteerPageId }] };
  }
  return props;
}
