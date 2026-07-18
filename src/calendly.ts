// Thin typed wrapper around the Calendly v2 REST API.
// Docs: https://developer.calendly.com/api-docs

export interface CalendlyUser {
  uri: string;
  name: string;
  email: string;
  current_organization: string;
}

export interface CalendlyEventType {
  uri: string;
  name: string;
  active: boolean;
  scheduling_url: string;
}

export interface CalendlyScheduledEvent {
  uri: string;
  name: string;
  status: "active" | "canceled";
  start_time: string;
  end_time: string;
  event_type: string;
  location?: {
    type: string;
    location?: string;
    join_url?: string;
  };
  event_memberships?: Array<{ user: string; user_email: string; user_name: string }>;
  invitees_counter?: { total: number; active: number; limit: number };
}

export interface CalendlyInvitee {
  uri: string;
  email: string;
  name: string;
  first_name?: string;
  last_name?: string;
  status: "active" | "canceled";
  created_at: string;
  updated_at: string;
  questions_and_answers?: Array<{ question: string; answer: string; position: number }>;
  event: string; // URI of scheduled event
  rescheduled?: boolean;
  cancel_url?: string;
}

export interface CalendlyWebhookSubscription {
  uri: string;
  callback_url: string;
  events: string[];
  scope: "user" | "organization";
  state: "active" | "disabled";
}

// Payload shape Calendly posts to our worker.
export interface CalendlyWebhookPayload {
  event: "invitee.created" | "invitee.canceled" | "invitee_no_show.created" | string;
  created_at: string;
  created_by: string;
  payload: {
    // For invitee.* events, the payload is the invitee resource.
    uri: string;
    email: string;
    name: string;
    status: "active" | "canceled";
    created_at: string;
    updated_at: string;
    event: string; // scheduled_event URI
    rescheduled?: boolean;
    questions_and_answers?: Array<{ question: string; answer: string; position: number }>;
    [key: string]: unknown;
  };
}

interface ListResponse<T> {
  collection: T[];
  pagination: { count: number; next_page?: string | null; next_page_token?: string | null };
}

export class CalendlyClient {
  constructor(
    private readonly token: string,
    private readonly base = "https://api.calendly.com",
  ) {}

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.base}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Calendly ${init.method ?? "GET"} ${path} failed ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  async me(): Promise<CalendlyUser> {
    const { resource } = await this.req<{ resource: CalendlyUser }>("/users/me");
    return resource;
  }

  async getScheduledEvent(uriOrUuid: string): Promise<CalendlyScheduledEvent> {
    const uri = this.toUri(uriOrUuid, "scheduled_events");
    const { resource } = await this.req<{ resource: CalendlyScheduledEvent }>(uri);
    return resource;
  }

  async listScheduledEvents(opts: {
    user?: string;
    organization?: string;
    minStartTime?: string;
    maxStartTime?: string;
    status?: "active" | "canceled";
    // Follow Calendly's pagination.next_page URL verbatim — reconstructing the
    // request from a page_token alongside the other filters returns 400.
    nextPageUrl?: string;
  }): Promise<ListResponse<CalendlyScheduledEvent>> {
    if (opts.nextPageUrl) return this.req(opts.nextPageUrl);
    const params = new URLSearchParams();
    if (opts.user) params.set("user", opts.user);
    if (opts.organization) params.set("organization", opts.organization);
    if (opts.minStartTime) params.set("min_start_time", opts.minStartTime);
    if (opts.maxStartTime) params.set("max_start_time", opts.maxStartTime);
    if (opts.status) params.set("status", opts.status);
    params.set("count", "100");
    return this.req(`/scheduled_events?${params}`);
  }

  async getInvitee(eventUriOrUuid: string, inviteeUriOrUuid: string): Promise<CalendlyInvitee> {
    const eventUri = this.toUri(eventUriOrUuid, "scheduled_events");
    const inviteeUuid = this.toUuid(inviteeUriOrUuid);
    const { resource } = await this.req<{ resource: CalendlyInvitee }>(
      `${eventUri}/invitees/${inviteeUuid}`,
    );
    return resource;
  }

  async listInvitees(eventUriOrUuid: string): Promise<CalendlyInvitee[]> {
    const eventUri = this.toUri(eventUriOrUuid, "scheduled_events");
    const out: CalendlyInvitee[] = [];
    let nextUrl: string | undefined = `${eventUri}/invitees?count=100`;
    while (nextUrl) {
      const res: ListResponse<CalendlyInvitee> = await this.req(nextUrl);
      out.push(...res.collection);
      nextUrl = res.pagination.next_page ?? undefined;
    }
    return out;
  }

  async listEventTypes(opts: { user?: string; organization?: string }): Promise<CalendlyEventType[]> {
    const params = new URLSearchParams({ count: "100" });
    if (opts.user) params.set("user", opts.user);
    if (opts.organization) params.set("organization", opts.organization);
    const { collection } = await this.req<ListResponse<CalendlyEventType>>(
      `/event_types?${params}`,
    );
    return collection;
  }

  // Webhook subscription CRUD.
  async createWebhookSubscription(opts: {
    callbackUrl: string;
    events: string[];
    scope: "user" | "organization";
    user?: string;
    organization: string;
    signingKey?: string;
  }): Promise<CalendlyWebhookSubscription> {
    const body: Record<string, unknown> = {
      url: opts.callbackUrl,
      events: opts.events,
      organization: opts.organization,
      scope: opts.scope,
    };
    if (opts.user) body.user = opts.user;
    if (opts.signingKey) body.signing_key = opts.signingKey;
    const { resource } = await this.req<{ resource: CalendlyWebhookSubscription }>(
      "/webhook_subscriptions",
      { method: "POST", body: JSON.stringify(body) },
    );
    return resource;
  }

  async listWebhookSubscriptions(opts: {
    scope: "user" | "organization";
    user?: string;
    organization: string;
  }): Promise<CalendlyWebhookSubscription[]> {
    const params = new URLSearchParams({
      organization: opts.organization,
      scope: opts.scope,
      count: "100",
    });
    if (opts.user) params.set("user", opts.user);
    const { collection } = await this.req<ListResponse<CalendlyWebhookSubscription>>(
      `/webhook_subscriptions?${params}`,
    );
    return collection;
  }

  async deleteWebhookSubscription(uriOrUuid: string): Promise<void> {
    const uri = this.toUri(uriOrUuid, "webhook_subscriptions");
    const res = await fetch(uri.startsWith("http") ? uri : `${this.base}${uri}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(`Calendly DELETE ${uri} failed ${res.status}: ${await res.text()}`);
    }
  }

  // ---- Helpers ----
  private toUri(idOrUri: string, resource: string): string {
    if (idOrUri.startsWith("http")) return idOrUri;
    return `${this.base}/${resource}/${idOrUri}`;
  }

  private toUuid(idOrUri: string): string {
    if (!idOrUri.startsWith("http")) return idOrUri;
    const parts = idOrUri.split("/");
    return parts[parts.length - 1] ?? idOrUri;
  }
}

// Extract the UUID at the end of a Calendly URI like
// https://api.calendly.com/scheduled_events/AAAA-BBBB-CCCC
export function uuidFromUri(uri: string): string {
  const parts = uri.split("/");
  return parts[parts.length - 1] ?? uri;
}
