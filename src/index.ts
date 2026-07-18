// Cloudflare Worker entry point.
// Receives Calendly webhook deliveries, verifies signatures, syncs the
// referenced scheduled_event into the Notion Groups DB.

import { CalendlyClient, uuidFromUri, type CalendlyWebhookPayload } from "./calendly.js";
import { NotionClient } from "./notion.js";
import { verifyCalendlySignature } from "./signature.js";
import { syncScheduledEvent } from "./sync.js";
import { Notifier } from "./notify.js";
import { runDailyAlerts, type AlertRunConfig } from "./alerts.js";
import type { Thresholds } from "./rules.js";

export interface Env {
  // Secrets
  CALENDLY_PAT: string;
  CALENDLY_WEBHOOK_SIGNING_KEY: string;
  NOTION_TOKEN: string;
  SLACK_WEBHOOK_URL?: string;
  RESEND_API_KEY?: string;
  ALERTS_RUN_TOKEN?: string;

  // Vars (wrangler.toml)
  NOTION_GROUPS_DB_ID: string;
  NOTION_TRAINING_DB_ID: string;
  NOTION_VOLUNTEERS_DB_ID: string;
  NOTION_FLAGS_DB_ID: string;
  NOTION_API_VERSION: string;
  CALENDLY_API_BASE: string;
  DEFAULT_GROUP_STATUS: string;

  // Alert thresholds (strings from toml)
  HOST_INACTIVE_DAYS: string;
  SHADOW_INACTIVE_DAYS: string;
  IN_TRAINING_STALE_DAYS: string;
  MILESTONE_GROUPS: string;
  FREQUENT_WEEK_LIMIT: string;
  FREQUENT_MONTH_LIMIT: string;
  SHADOW_SIGNOFF_PROMPT: string;
  SHADOW_SIGNOFF_ESCALATE: string;
  SHADOW_READINESS_GROUPS: string;

  // Alert behaviour
  ALERTS_DRY_RUN: string;
  ALERT_EMAIL_COORDINATOR: string;
  ALERT_EMAIL_CEO: string;
  ALERT_EMAIL_DSL: string;
  ALERT_EMAIL_FROM: string;

  // Bindings
  ALERTS_KV: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, name: "calendly-notion-sync" });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }

    // Manual trigger for the daily alerts (testing). Protected by ALERTS_RUN_TOKEN
    // if set. `?dry=1` forces a dry run regardless of the ALERTS_DRY_RUN var.
    if (request.method === "GET" && url.pathname === "/run-alerts") {
      if (env.ALERTS_RUN_TOKEN && url.searchParams.get("token") !== env.ALERTS_RUN_TOKEN) {
        return new Response("unauthorized", { status: 401 });
      }
      const seed = url.searchParams.get("seed") === "1";
      const forceDry = url.searchParams.get("dry") === "1";
      const cfg = buildAlertConfig(env, forceDry);
      cfg.seedDedupe = seed;
      const result = await runDailyAlerts(cfg);
      return json(result);
    }

    return new Response("not found", { status: 404 });
  },

  // Daily cron (see [triggers] in wrangler.toml).
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const result = await runDailyAlerts(buildAlertConfig(env, parseBool(env.ALERTS_DRY_RUN)));
        console.log("daily alerts:", JSON.stringify(result));
      })(),
    );
  },
};

function parseBool(v: string | undefined): boolean {
  return (v ?? "").toLowerCase() === "true";
}
function num(v: string, fallback: number): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function buildAlertConfig(env: Env, dryRun: boolean): AlertRunConfig {
  const notion = new NotionClient({ token: env.NOTION_TOKEN, apiVersion: env.NOTION_API_VERSION });
  const notifier = new Notifier({
    slackWebhookUrl: env.SLACK_WEBHOOK_URL,
    resendApiKey: env.RESEND_API_KEY,
    emailFrom: env.ALERT_EMAIL_FROM,
    dryRun,
  });
  const thresholds: Thresholds = {
    hostInactiveDays: num(env.HOST_INACTIVE_DAYS, 90),
    shadowInactiveDays: num(env.SHADOW_INACTIVE_DAYS, 30),
    inTrainingStaleDays: num(env.IN_TRAINING_STALE_DAYS, 180),
    milestoneGroups: num(env.MILESTONE_GROUPS, 10),
    frequentWeekLimit: num(env.FREQUENT_WEEK_LIMIT, 1),
    frequentMonthLimit: num(env.FREQUENT_MONTH_LIMIT, 4),
    shadowSignoffPrompt: num(env.SHADOW_SIGNOFF_PROMPT, 6),
    shadowSignoffEscalate: num(env.SHADOW_SIGNOFF_ESCALATE, 8),
    shadowReadinessGroups: num(env.SHADOW_READINESS_GROUPS, 4),
  };
  return {
    notion,
    notifier,
    kv: env.ALERTS_KV,
    ruleConfig: {
      thresholds,
      recipients: {
        coordinator: env.ALERT_EMAIL_COORDINATOR,
        ceo: env.ALERT_EMAIL_CEO,
        dsl: env.ALERT_EMAIL_DSL,
      },
      now: new Date(),
    },
    groupsDbId: env.NOTION_GROUPS_DB_ID,
    volunteersDbId: env.NOTION_VOLUNTEERS_DB_ID,
    flagsDbId: env.NOTION_FLAGS_DB_ID,
    dryRun,
  };
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();

  const verify = await verifyCalendlySignature({
    rawBody,
    header: request.headers.get("Calendly-Webhook-Signature"),
    signingKey: env.CALENDLY_WEBHOOK_SIGNING_KEY,
  });
  if (!verify.ok) {
    console.warn("rejected webhook:", verify.reason);
    return new Response(verify.reason ?? "invalid signature", { status: 401 });
  }

  let payload: CalendlyWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }

  const calendly = new CalendlyClient(env.CALENDLY_PAT, env.CALENDLY_API_BASE);
  const notion = new NotionClient({ token: env.NOTION_TOKEN, apiVersion: env.NOTION_API_VERSION });

  const cfg = {
    calendly,
    notion,
    groupsDbId: env.NOTION_GROUPS_DB_ID,
    trainingDbId: env.NOTION_TRAINING_DB_ID,
    volunteersDbId: env.NOTION_VOLUNTEERS_DB_ID,
    defaultStatus: (env.DEFAULT_GROUP_STATUS as "Pending review" | "Confirmed") ?? "Pending review",
  };

  const eventUri = payload.payload.event;
  if (!eventUri) {
    return json({ ignored: true, reason: "no scheduled_event uri in payload" });
  }

  try {
    switch (payload.event) {
      case "invitee.created": {
        const result = await syncScheduledEvent(cfg, eventUri);
        return json({ ok: true, ...summarize(result) });
      }

      case "invitee.canceled": {
        // Re-sync first (so the row reflects the current invitee list); then,
        // for a peer-support group that's now fully canceled, mark it canceled.
        const result = await syncScheduledEvent(cfg, eventUri);
        if (result.kind === "group") {
          const event = await calendly.getScheduledEvent(eventUri);
          if (event.status === "canceled") {
            await notion.markGroupCanceled(env.NOTION_GROUPS_DB_ID, uuidFromUri(eventUri));
          }
        }
        return json({ ok: true, action: "canceled", ...summarize(result) });
      }

      default:
        return json({ ignored: true, reason: `unhandled event type: ${payload.event}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("sync failed:", msg);
    // Return 500 so Calendly retries; webhook deliveries are at-least-once.
    return new Response(`sync failed: ${msg}`, { status: 500 });
  }
}

function summarize(result: import("./sync.js").SyncOneResult): Record<string, unknown> {
  switch (result.kind) {
    case "skip":
      return { action: "skipped", reason: result.reason, event_name: result.groupName };
    case "training":
      return {
        action: "training",
        event_name: result.groupName,
        training_type: result.trainingType,
        rows_created: result.trainingRowsCreated,
        rows_updated: result.trainingRowsUpdated,
        unmatched_emails: result.unmatchedEmails,
      };
    case "group":
      return {
        action: result.created ? "created" : "updated",
        page_id: result.pageId,
        group_name: result.groupName,
        group_type: result.groupType,
        matched_host: result.matchedHost,
        matched_co_host_count: result.matchedCoHostCount,
        unmatched_emails: result.unmatchedEmails,
      };
  }
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}
