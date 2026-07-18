// Local runner for the daily alert engine. Defaults to a DRY RUN: it reads
// live Notion data, computes which alerts would fire, and prints them — without
// sending notifications or changing any Notion records.
//
//   npm run alerts            # dry run (no sends, no mutations)
//   npm run alerts -- --live  # actually notify + mutate (same as the cron)
//
// The --live path still respects whether SLACK_WEBHOOK_URL / RESEND_API_KEY are
// set; unconfigured channels are skipped with a log line.

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { requireEnv, optionalEnv } from "./_env.js";
import { NotionClient } from "../src/notion.js";
import { Notifier } from "../src/notify.js";
import { runDailyAlerts, type KVLike, type AlertDetail } from "../src/alerts.js";
import type { Thresholds } from "../src/rules.js";

const RULE_TITLES: Record<string, string> = {
  "safeguarding-on-hold": "Scenario 5 — Safeguarding flag → On Hold",
  "host-inactivity": "Scenario 3 — Host inactivity → Check in",
  "frequent-host": "Scenario 7 — Frequent host",
  "in-training-stale": "Scenario 2 — In Training too long",
  "shadow-inactivity": "Scenario 2 — Shadow inactivity",
  "shadow-signoff-prompt": "Scenario 8 — Shadow sign-off prompt",
  "shadow-signoff-escalate": "Scenario 8b — Shadow sign-off escalation",
  "shadow-readiness": "Scenario 9 — Shadow readiness check",
  "milestone-first-group": "Scenario 4 — First group hosted",
  "milestone-10-groups": "Scenario 4 — 10 groups milestone",
};

function writeReport(details: AlertDetail[], path: string): void {
  const lines: string[] = [];
  lines.push(`# TNN Volunteer Tracker — daily alert preview`);
  lines.push(``);
  lines.push(`Generated ${new Date().toISOString()} · ${details.length} alerts · **DRY RUN — nothing was sent or changed.**`);
  lines.push(``);

  // 1) Volunteer-facing messages (emails that go to the volunteer themselves).
  const toVolunteers = details.flatMap((d) =>
    d.messages
      .filter((m) => m.channels.includes("email") && m.to.length && !d.rule.startsWith("safeguarding"))
      .filter((m) => isVolunteerFacing(d.rule))
      .map((m) => ({ name: d.volunteerName, m })),
  );
  lines.push(`## 1. Messages volunteers would receive (email)`);
  lines.push(``);
  if (!toVolunteers.length) {
    lines.push(`_None._`);
  } else {
    for (const { name, m } of toVolunteers) {
      lines.push(`### ${name} — ${m.to.join(", ")}`);
      lines.push(`**Subject:** ${m.subject}`);
      lines.push(``);
      lines.push("```");
      lines.push(m.body);
      lines.push("```");
      lines.push(``);
    }
  }

  // 2) Coordinator / staff alerts, grouped by scenario.
  lines.push(`## 2. Alerts the coordinator (and CEO/DSL) would receive`);
  lines.push(``);
  const byRule = new Map<string, AlertDetail[]>();
  for (const d of details) {
    if (!byRule.has(d.rule)) byRule.set(d.rule, []);
    byRule.get(d.rule)!.push(d);
  }
  for (const [rule, items] of byRule) {
    lines.push(`### ${RULE_TITLES[rule] ?? rule}  (${items.length})`);
    lines.push(``);
    for (const d of items) {
      const staffMsg = d.messages.find((m) => m.channels.includes("slack")) ?? d.messages[0];
      if (!staffMsg) continue;
      const recip = staffMsg.to.length ? ` · to: ${staffMsg.to.join(", ")}` : "";
      const status = d.statusChange ? ` · **${d.statusChange}**` : "";
      lines.push(`- **${d.volunteerName}**${status}${recip}`);
      lines.push(`  - ${staffMsg.subject}`);
      lines.push(`  - ${staffMsg.body.replace(/\n/g, " ")}`);
    }
    lines.push(``);
  }

  writeFileSync(path, lines.join("\n"), "utf8");
}

function isVolunteerFacing(rule: string): boolean {
  return rule === "milestone-10-groups";
}

// In-memory KV shim for local runs (no dedupe persistence across runs).
function memKV(): KVLike {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => void m.set(k, v),
  };
}

function num(name: string, fallback: number): number {
  const n = parseInt(optionalEnv(name, ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  const live = process.argv.includes("--live");
  const dryRun = !live;

  const notion = new NotionClient({
    token: requireEnv("NOTION_TOKEN"),
    apiVersion: optionalEnv("NOTION_API_VERSION", "2022-06-28"),
  });
  const notifier = new Notifier({
    slackWebhookUrl: optionalEnv("SLACK_WEBHOOK_URL") || undefined,
    resendApiKey: optionalEnv("RESEND_API_KEY") || undefined,
    emailFrom: optionalEnv("ALERT_EMAIL_FROM") || undefined,
    dryRun,
  });
  const thresholds: Thresholds = {
    hostInactiveDays: num("HOST_INACTIVE_DAYS", 90),
    shadowInactiveDays: num("SHADOW_INACTIVE_DAYS", 30),
    inTrainingStaleDays: num("IN_TRAINING_STALE_DAYS", 180),
    milestoneGroups: num("MILESTONE_GROUPS", 10),
    frequentWeekLimit: num("FREQUENT_WEEK_LIMIT", 1),
    frequentMonthLimit: num("FREQUENT_MONTH_LIMIT", 4),
    shadowSignoffPrompt: num("SHADOW_SIGNOFF_PROMPT", 6),
    shadowSignoffEscalate: num("SHADOW_SIGNOFF_ESCALATE", 8),
    shadowReadinessGroups: num("SHADOW_READINESS_GROUPS", 4),
  };

  console.log(`Running daily alerts — mode: ${dryRun ? "DRY RUN (no sends/mutations)" : "LIVE"}\n`);

  const result = await runDailyAlerts({
    notion,
    notifier,
    kv: memKV(),
    ruleConfig: {
      thresholds,
      recipients: {
        coordinator: optionalEnv("ALERT_EMAIL_COORDINATOR", "coordinator@example.org"),
        ceo: optionalEnv("ALERT_EMAIL_CEO", "ceo@example.org"),
        dsl: optionalEnv("ALERT_EMAIL_DSL", "dsl@example.org"),
      },
      now: new Date(),
    },
    groupsDbId: requireEnv("NOTION_GROUPS_DB_ID"),
    volunteersDbId: requireEnv("NOTION_VOLUNTEERS_DB_ID"),
    flagsDbId: requireEnv("NOTION_FLAGS_DB_ID"),
    dryRun,
  });

  // Write a shareable report next to the project root.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const reportPath = resolve(__dirname, "..", "alert-preview.md");
  writeReport(result.details, reportPath);

  console.log("\n── Summary ──");
  console.log(`Scanned: ${result.scanned.volunteers} volunteers, ${result.scanned.groups} groups, ${result.scanned.openFlags} open flags`);
  console.log(`Alerts fired: ${result.fired}  (deduped: ${result.deduped})`);
  console.log(`By rule:`, result.byRule);
  console.log(`\n📄 Full preview written to: ${reportPath}`);
  if (!dryRun) {
    console.log(`Notion status changes: ${result.mutationsApplied}, notes written: ${result.notesWritten}`);
  }
  if (result.errors.length) {
    console.log(`Errors (${result.errors.length}):`);
    for (const e of result.errors) console.log(`  ! ${e}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
