// Read-only audit of the Volunteers DB schema.
//
// Lists every property, what type it is, whether a coordinator can type into
// it, and for the calculated ones, where the number actually comes from.
//
//   npm run audit:volunteers

import { requireEnv, optionalEnv } from "./_env.js";

const token = requireEnv("NOTION_TOKEN");
const apiVersion = optionalEnv("NOTION_API_VERSION", "2022-06-28");
const volunteersDbId = requireEnv("NOTION_VOLUNTEERS_DB_ID");
const groupsDbId = optionalEnv("NOTION_GROUPS_DB_ID", "");
const trainingDbId = optionalEnv("NOTION_TRAINING_DB_ID", "");
const flagsDbId = optionalEnv("NOTION_FLAGS_DB_ID", "");

interface PropSchema {
  id: string;
  name: string;
  type: string;
  description?: string | null;
  relation?: { database_id: string; type?: string; dual_property?: { synced_property_name?: string } };
  rollup?: { relation_property_name?: string; rollup_property_name?: string; function?: string };
  formula?: { expression?: string };
  number?: { format?: string };
  select?: { options: Array<{ name: string }> };
}

const EDITABLE = new Set([
  "title", "rich_text", "number", "select", "multi_select", "status", "date",
  "people", "files", "checkbox", "url", "email", "phone_number", "relation",
]);

function dbName(id: string): string {
  const clean = id.replace(/-/g, "");
  if (clean === groupsDbId.replace(/-/g, "")) return "Groups";
  if (clean === trainingDbId.replace(/-/g, "")) return "Training Log";
  if (clean === flagsDbId.replace(/-/g, "")) return "Notes & Flags";
  if (clean === volunteersDbId.replace(/-/g, "")) return "Volunteers";
  return id;
}

async function main() {
  const res = await fetch(`https://api.notion.com/v1/databases/${volunteersDbId}`, {
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": apiVersion },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Notion GET → ${res.status}\n${body}`);
  const db = JSON.parse(body) as { properties: Record<string, PropSchema> };

  const props = Object.values(db.properties);
  const manual = props.filter((p) => EDITABLE.has(p.type));
  const calculated = props.filter((p) => !EDITABLE.has(p.type));

  const line = (p: PropSchema) => {
    let detail = "";
    if (p.type === "rollup") {
      detail = `${p.rollup?.function} of "${p.rollup?.rollup_property_name}" over "${p.rollup?.relation_property_name}"`;
    } else if (p.type === "formula") {
      detail = (p.formula?.expression ?? "").replace(/\s+/g, " ").slice(0, 110);
    } else if (p.type === "relation") {
      detail = `→ ${dbName(p.relation?.database_id ?? "")}${p.relation?.type === "dual_property" ? " (two-way)" : " (one-way)"}`;
    } else if (p.type === "select" || p.type === "multi_select") {
      detail = (p.select?.options ?? []).map((o) => o.name).join(", ").slice(0, 90);
    }
    const desc = p.description ? `  [desc: ${p.description}]` : "";
    return `  ${p.name.padEnd(34)} ${p.type.padEnd(16)} ${detail}${desc}`;
  };

  console.log(`\nVolunteers DB — ${props.length} properties\n`);
  console.log(`── Coordinator can edit these (${manual.length}) ──`);
  for (const p of manual.sort((a, b) => a.name.localeCompare(b.name))) console.log(line(p));
  console.log(`\n── Calculated, read-only in the row (${calculated.length}) ──`);
  for (const p of calculated.sort((a, b) => a.name.localeCompare(b.name))) console.log(line(p));

  // Flag the confusing ones: several properties whose names overlap.
  const buckets = new Map<string, PropSchema[]>();
  for (const p of props) {
    const key = p.name.toLowerCase().replace(/[^a-z]/g, "").replace(/s$/, "");
    for (const term of ["shadow", "host", "cohost", "session", "group"]) {
      if (key.includes(term)) {
        if (!buckets.has(term)) buckets.set(term, []);
        buckets.get(term)!.push(p);
      }
    }
  }
  console.log(`\n── Overlapping names, likely to confuse ──`);
  for (const [term, list] of buckets) {
    if (list.length < 2) continue;
    console.log(`  "${term}" appears in ${list.length}: ${list.map((p) => `${p.name} (${p.type})`).join(" · ")}`);
  }
  console.log();
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
