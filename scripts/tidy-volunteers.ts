// Makes the Volunteers DB count fields legible to a coordinator.
//
//   - deletes two superseded calculated fields
//   - renames the counts so the suffix says what you can do with them
//   - writes a description on every count field explaining where the number
//     comes from and how to correct it
//
// Naming convention:
//   (auto)     calculated, read-only. Fix it at the source, not here.
//   (manual)   type into it freely. Never feeds the alerts.
//   relations  keep their names, and carry a description instead.
//
// The three relations are deliberately NOT renamed: the "Sessions Total (live)"
// formula refers to "Groups Hosted" and "Groups Co-hosted" by name in its
// expression, and renaming them through the API would break it silently.
//
// Idempotent: anything already renamed is skipped.
//
//   npm run tidy:volunteers -- --dry-run
//   npm run tidy:volunteers

import { requireEnv, optionalEnv } from "./_env.js";

const dryRun = process.argv.includes("--dry-run");
const token = requireEnv("NOTION_TOKEN");
const apiVersion = optionalEnv("NOTION_API_VERSION", "2022-06-28");
const dbId = requireEnv("NOTION_VOLUNTEERS_DB_ID");

interface PropSchema { id: string; name: string; type: string; description?: string | null }
interface Database { properties: Record<string, PropSchema> }

async function notion<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": apiVersion,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Notion ${init.method ?? "GET"} ${path} → ${res.status}\n${body}`);
  return JSON.parse(body) as T;
}

// Calculated from the relations, so deleting them loses no data.
const DELETE = [
  { name: "Shadow Sessions", why: "old approximation: counted hosted + co-hosted for anyone with Status = Shadow" },
  { name: "Groups Hosted Count", why: "duplicate of the Sessions hosted rollup" },
];

const RENAME: Array<{ from: string; to: string; description: string }> = [
  {
    from: "Sessions hosted",
    to: "Sessions hosted (auto)",
    description:
      "Counted automatically from the Groups Hosted list. Read-only. If it looks wrong, open that session in the Groups database and correct its Host.",
  },
  {
    from: "Sessions co-hosted",
    to: "Sessions co-hosted (auto)",
    description:
      "Counted automatically from the Groups Co-hosted list. Read-only. Correct it by editing the session in the Groups database.",
  },
  {
    from: "Sessions shadowed",
    to: "Sessions shadowed (auto)",
    description:
      "Counted automatically from the Groups Shadowed list, which comes from what the volunteer chose when booking. This is the figure the sign-off alerts use (prompt at 6, escalation at 8). Read-only.",
  },
  {
    from: "Last session hosted",
    to: "Last hosted (auto)",
    description:
      "The date of their most recent hosted session. Drives the 90-day inactivity alert. Read-only.",
  },
  {
    from: "Sessions Total (live)",
    to: "Sessions total (auto)",
    description:
      "Hosted plus co-hosted. Does not include shadowed sessions, which are counted separately. Read-only.",
  },
  {
    from: "Shadow Sessions (locked)",
    to: "Shadow count override (manual)",
    description:
      "Type a corrected figure here if the automatic count is wrong. For the coordinator's reference only: the alerts always use Sessions shadowed (auto) and ignore this field.",
  },
  {
    from: "Shadow Sessions (legacy count)",
    to: "Shadow count before tracker (manual)",
    description:
      "Shadow sessions from the old directory, before Calendly bookings were tracked. Historical. Not included in Sessions shadowed (auto).",
  },
  {
    from: "Groups Hosted (legacy text)",
    to: "Groups before tracker (manual)",
    description:
      "Free-text list of groups from the old directory. Historical. Superseded by the Groups Hosted relation.",
  },
];

// Named but not renamed: the relations. Description only.
const DESCRIBE: Array<{ name: string; description: string }> = [
  {
    name: "Groups Hosted",
    description:
      "Sessions this volunteer hosted. Written by the Calendly sync from their booking answer. You can edit it here, but the reliable fix is to correct the session in the Groups database, otherwise the next sync may overwrite you.",
  },
  {
    name: "Groups Co-hosted",
    description:
      "Sessions this volunteer co-hosted. Written by the Calendly sync. Correct it in the Groups database rather than here.",
  },
  {
    name: "Groups Shadowed",
    description:
      "Sessions this volunteer shadowed. Written by the Calendly sync from the booking question 'Are you joining as host / co-host / shadow host?'. Correct it in the Groups database rather than here.",
  },
];

async function main() {
  console.log(dryRun ? "DRY RUN — nothing will be written.\n" : "Tidying the Volunteers DB.\n");
  const db = await notion<Database>(`/databases/${dbId}`);
  const has = (n: string) => Boolean(db.properties[n]);

  const actions: string[] = [];
  const skipped: string[] = [];
  const properties: Record<string, unknown> = {};

  for (const d of DELETE) {
    if (!has(d.name)) { skipped.push(`"${d.name}" already gone`); continue; }
    properties[d.name] = null;
    actions.push(`delete   "${d.name}"  (${d.why})`);
  }

  for (const r of RENAME) {
    if (has(r.to)) { skipped.push(`"${r.to}" already renamed`); continue; }
    if (!has(r.from)) { skipped.push(`"${r.from}" not found — nothing to rename`); continue; }
    properties[r.from] = { name: r.to, description: r.description };
    actions.push(`rename   "${r.from}"  →  "${r.to}"`);
  }

  for (const d of DESCRIBE) {
    if (!has(d.name)) { skipped.push(`"${d.name}" not found — no description set`); continue; }
    if (db.properties[d.name]?.description) { skipped.push(`"${d.name}" already has a description`); continue; }
    properties[d.name] = { description: d.description };
    actions.push(`describe "${d.name}"`);
  }

  for (const s of skipped) console.log(`  skipped  ${s}`);
  for (const a of actions) console.log(`  ${dryRun ? "would " : ""}${a}`);

  if (!actions.length) { console.log("\nNothing to change."); return; }
  if (dryRun) { console.log(`\n${actions.length} change(s) would be made.`); return; }

  await notion(`/databases/${dbId}`, { method: "PATCH", body: JSON.stringify({ properties }) });

  // Show the result the way a coordinator would read it.
  const after = await notion<Database>(`/databases/${dbId}`);
  const counts = Object.values(after.properties).filter((p) =>
    /session|group|shadow|host/i.test(p.name) && !/language|buddy|lead|left/i.test(p.name),
  );
  console.log(`\n── The count fields now ──`);
  const auto = counts.filter((p) => p.name.includes("(auto)"));
  const manual = counts.filter((p) => p.name.includes("(manual)"));
  const rest = counts.filter((p) => !p.name.includes("(auto)") && !p.name.includes("(manual)"));
  console.log(`\n  Read-only, calculated:`);
  for (const p of auto) console.log(`    ${p.name}`);
  console.log(`\n  Christy types into these:`);
  for (const p of manual) console.log(`    ${p.name}`);
  console.log(`\n  The sessions themselves (fix in the Groups database):`);
  for (const p of rest) console.log(`    ${p.name}  [${p.type}]`);
  console.log();
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
