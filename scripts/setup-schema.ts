// One-time Notion schema setup for shadow sessions.
//
// Adds, if they aren't already there:
//   1. Groups DB      → "Shadow" relation pointing at Volunteers (two-way, so
//                       Volunteers gets a back-relation you can roll up)
//   2. Training Log   → "Shadow session" option on the "Training Type" select
//
// Also reports whether the existing Host / Co-host relations are two-way,
// since one-way relations can't be rolled up onto a Volunteers row.
//
// Safe to run more than once: it checks before it changes anything, and it
// never removes or renames an existing property or option.
//
//   npm run setup:schema -- --dry-run   # show what would change, write nothing
//   npm run setup:schema                # apply

import { requireEnv, optionalEnv } from "./_env.js";

const dryRun = process.argv.includes("--dry-run");

const token = requireEnv("NOTION_TOKEN");
const apiVersion = optionalEnv("NOTION_API_VERSION", "2022-06-28");
const groupsDbId = requireEnv("NOTION_GROUPS_DB_ID");
const trainingDbId = requireEnv("NOTION_TRAINING_DB_ID");
const volunteersDbId = requireEnv("NOTION_VOLUNTEERS_DB_ID");

interface NotionDatabase {
  id: string;
  title?: Array<{ plain_text: string }>;
  properties: Record<string, NotionPropertySchema>;
}
interface NotionPropertySchema {
  id: string;
  name: string;
  type: string;
  relation?: {
    database_id: string;
    type?: "single_property" | "dual_property";
    dual_property?: Record<string, unknown>;
  };
  select?: { options: Array<{ id?: string; name: string; color?: string }> };
}

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
  if (!res.ok) {
    throw new Error(`Notion ${init.method ?? "GET"} ${path} → ${res.status}\n${body}`);
  }
  return JSON.parse(body) as T;
}

function dbTitle(db: NotionDatabase): string {
  return db.title?.map((t) => t.plain_text).join("") || db.id;
}

const changes: string[] = [];
const skipped: string[] = [];

async function main() {
  console.log(dryRun ? "DRY RUN — nothing will be written.\n" : "Applying schema changes.\n");

  // ── 1. Groups DB: "Shadow" relation ──
  const groups = await notion<NotionDatabase>(`/databases/${groupsDbId}`);
  console.log(`Groups DB: ${dbTitle(groups)}`);

  const relationReport = (name: string) => {
    const p = groups.properties[name];
    if (!p) return `  ${name.padEnd(10)} MISSING`;
    if (p.type !== "relation") return `  ${name.padEnd(10)} exists but is a ${p.type}, not a relation`;
    const twoWay = p.relation?.type === "dual_property";
    const target = p.relation?.database_id === volunteersDbId ? "→ Volunteers" : `→ ${p.relation?.database_id}`;
    return `  ${name.padEnd(10)} relation ${target}, ${twoWay ? "two-way (rollups possible)" : "ONE-WAY (no rollup on Volunteers)"}`;
  };
  console.log(relationReport("Host"));
  console.log(relationReport("Co-host"));
  console.log(relationReport("Shadow"));

  const existingShadow = groups.properties["Shadow"];
  if (existingShadow) {
    if (existingShadow.type !== "relation") {
      throw new Error(
        `Groups DB already has a property called "Shadow" of type "${existingShadow.type}". ` +
          `Rename or remove it first — this script will not overwrite it.`,
      );
    }
    if (existingShadow.relation?.database_id !== volunteersDbId) {
      throw new Error(
        `Groups DB "Shadow" is a relation but points at ${existingShadow.relation?.database_id}, ` +
          `not the Volunteers DB (${volunteersDbId}). Fix it in Notion, or point this script at the right DB.`,
      );
    }
    skipped.push(`Groups DB already has a "Shadow" relation to Volunteers`);
  } else {
    changes.push(`Groups DB: add "Shadow" relation → Volunteers (two-way)`);
    if (!dryRun) {
      await notion(`/databases/${groupsDbId}`, {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            Shadow: {
              relation: {
                database_id: volunteersDbId,
                type: "dual_property",
                dual_property: {},
              },
            },
          },
        }),
      });
    }
  }

  // ── 2. Training Log: "Shadow session" option on Training Type ──
  const training = await notion<NotionDatabase>(`/databases/${trainingDbId}`);
  console.log(`\nTraining Log DB: ${dbTitle(training)}`);

  const trainingType = training.properties["Training Type"];
  if (!trainingType) {
    throw new Error(`Training Log DB has no "Training Type" property. Expected a select.`);
  }
  if (trainingType.type !== "select") {
    throw new Error(`Training Log "Training Type" is a ${trainingType.type}, expected a select.`);
  }
  const options = trainingType.select?.options ?? [];
  console.log(`  Training Type options: ${options.map((o) => o.name).join(", ") || "(none)"}`);

  if (options.some((o) => o.name === "Shadow session")) {
    skipped.push(`Training Log "Training Type" already has a "Shadow session" option`);
  } else {
    changes.push(`Training Log: add "Shadow session" to the "Training Type" select`);
    if (!dryRun) {
      // Notion replaces the option list wholesale, so send the existing options
      // back (by id, which preserves them) plus the new one.
      await notion(`/databases/${trainingDbId}`, {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            "Training Type": {
              select: {
                options: [
                  ...options.map((o) => ({ id: o.id })),
                  { name: "Shadow session", color: "yellow" },
                ],
              },
            },
          },
        }),
      });
    }
  }

  // ── Summary ──
  console.log("\n── Summary ──");
  for (const s of skipped) console.log(`  already done  ${s}`);
  for (const c of changes) console.log(`  ${dryRun ? "would do     " : "done         "} ${c}`);
  if (!changes.length) console.log("  Nothing to change. Schema is ready.");

  if (!dryRun && changes.length) {
    console.log(
      `\nNext: in Notion, open the Volunteers DB and add rollups over the new\n` +
        `back-relations if you want the counts visible there (Sessions shadowed,\n` +
        `Sessions hosted). The alert engine does not need them.`,
    );
  }
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
