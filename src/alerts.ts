// Daily alert orchestrator. Shared by the scheduled() Worker handler and the
// local dry-run script.
//
// Flow: fetch Notion snapshot → run pure rules → for each alert, skip if its
// dedupe key is already in KV, otherwise notify + mutate Notion + write an
// audit note + mark the dedupe key.

import { NotionClient } from "./notion.js";
import { Notifier } from "./notify.js";
import { runRules, type RuleConfig, type Alert } from "./rules.js";

// Minimal KV surface so this runs both in the Worker (real KVNamespace) and in
// the local script (in-memory shim).
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export interface AlertRunConfig {
  notion: NotionClient;
  notifier: Notifier;
  kv: KVLike;
  ruleConfig: RuleConfig;
  groupsDbId: string;
  volunteersDbId: string;
  flagsDbId: string;
  dryRun: boolean;
  // Baseline mode: mark every currently-eligible keyed alert as already-fired
  // WITHOUT notifying or mutating. Run once before going live so historical
  // milestones (e.g. someone already past 10 groups) don't blast out. Alerts
  // without a dedupe key (host-inactivity, safeguarding) are skipped entirely.
  seedDedupe?: boolean;
}

export interface AlertRunResult {
  scanned: { volunteers: number; groups: number; openFlags: number };
  fired: number;
  deduped: number;
  seeded: number;
  byRule: Record<string, number>;
  mutationsApplied: number;
  notesWritten: number;
  errors: string[];
  // Full per-alert detail for review/reporting (always populated).
  details: AlertDetail[];
}

export interface AlertDetail {
  rule: string;
  volunteerName: string;
  outcome: "would-fire" | "fired" | "deduped" | "seeded";
  statusChange?: string; // e.g. "→ Check in"
  messages: Array<{
    channels: string[];
    to: string[]; // resolved recipients (emails); Slack channel implied by webhook
    subject: string;
    body: string;
  }>;
}

export async function runDailyAlerts(cfg: AlertRunConfig): Promise<AlertRunResult> {
  const [volunteers, groups, openFlags] = await Promise.all([
    cfg.notion.listVolunteers(cfg.volunteersDbId),
    cfg.notion.listGroups(cfg.groupsDbId),
    cfg.notion.listOpenConcernFlags(cfg.flagsDbId),
  ]);

  const alerts = runRules(cfg.ruleConfig, volunteers, groups, openFlags);

  const result: AlertRunResult = {
    scanned: { volunteers: volunteers.length, groups: groups.length, openFlags: openFlags.length },
    fired: 0,
    deduped: 0,
    seeded: 0,
    byRule: {},
    mutationsApplied: 0,
    notesWritten: 0,
    errors: [],
    details: [],
  };

  for (const alert of alerts) {
    const detail: AlertDetail = {
      rule: alert.rule,
      volunteerName: alert.volunteerName,
      outcome: "would-fire",
      statusChange: alert.mutation ? `→ ${alert.mutation.status}` : undefined,
      messages: alert.messages.map((m) => ({
        channels: m.channels,
        to: m.emailTo ?? [],
        subject: m.subject,
        body: m.body,
      })),
    };
    result.details.push(detail);

    try {
      // Baseline mode: only mark keyed alerts as fired; never notify/mutate.
      if (cfg.seedDedupe) {
        if (alert.dedupeKey) {
          await cfg.kv.put(alert.dedupeKey, new Date().toISOString(), {
            expirationTtl: alert.dedupeTtlSec,
          });
          result.seeded++;
          detail.outcome = "seeded";
        }
        continue;
      }

      if (alert.dedupeKey && (await cfg.kv.get(alert.dedupeKey))) {
        result.deduped++;
        detail.outcome = "deduped";
        continue;
      }

      for (const msg of alert.messages) {
        await cfg.notifier.send(msg);
      }
      detail.outcome = cfg.dryRun ? "would-fire" : "fired";

      if (!cfg.dryRun) {
        if (alert.mutation) {
          await cfg.notion.updateVolunteerStatus(alert.volunteerId, alert.mutation.status);
          result.mutationsApplied++;
        }
        if (alert.note) {
          await cfg.notion.createNote({ flagsDbId: cfg.flagsDbId, ...alert.note });
          result.notesWritten++;
        }
        if (alert.dedupeKey) {
          await cfg.kv.put(alert.dedupeKey, new Date().toISOString(), {
            expirationTtl: alert.dedupeTtlSec,
          });
        }
      }

      result.fired++;
      result.byRule[alert.rule] = (result.byRule[alert.rule] ?? 0) + 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${alert.rule}/${alert.volunteerName}: ${msg}`);
    }
  }

  return result;
}
