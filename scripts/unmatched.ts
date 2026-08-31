// Reports Calendly booking emails that don't match any Volunteers row, and
// tries to work out which are existing volunteers using a second address
// rather than people with no record at all.
//
// Read-only. Writes unmatched-report.md next to the repo root.
//
//   npm run unmatched -- --since=2025-04-01

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { requireEnv, optionalEnv } from "./_env.js";
import { CalendlyClient } from "../src/calendly.js";
import { NotionClient } from "../src/notion.js";
import { collectUnmatched } from "./_unmatched-core.js";

const sinceArg = process.argv.find((a) => a.startsWith("--since="));
const since = sinceArg ? sinceArg.slice("--since=".length) : "2025-04-01";

async function main() {
  const calendly = new CalendlyClient(
    requireEnv("CALENDLY_PAT"),
    optionalEnv("CALENDLY_API_BASE", "https://api.calendly.com"),
  );
  const notion = new NotionClient({
    token: requireEnv("NOTION_TOKEN"),
    apiVersion: optionalEnv("NOTION_API_VERSION", "2022-06-28"),
  });

  console.log("Reading Volunteers from Notion…");
  const me = await calendly.me();
  console.log(`Walking Calendly bookings since ${since}…`);

  const { events, linked, newPeople } = await collectUnmatched({
    calendly,
    notion,
    volunteersDbId: requireEnv("NOTION_VOLUNTEERS_DB_ID"),
    organization: optionalEnv("CALENDLY_ORG_URI", me.current_organization),
    since,
    log: (m) => console.log(m),
  });

  const total = linked.length + newPeople.length;
  console.log(`  ${events} sessions scanned, ${total} unmatched email(s)\n`);

  console.log(`── Probably an existing volunteer's second address (${linked.length}) ──`);
  for (const { s, sug } of linked) {
    console.log(
      `  ${String(s.sessions.length).padStart(2)} sessions  ${s.email.padEnd(34)} → ${sug.volunteer.name} (${sug.confidence}: ${sug.reason})`,
    );
  }
  console.log(`\n── No matching volunteer found (${newPeople.length}) ──`);
  for (const s of newPeople) {
    console.log(
      `  ${String(s.sessions.length).padStart(2)} sessions  ${s.email.padEnd(34)} ${s.names.join(" / ")}`,
    );
  }

  const md: string[] = [];
  md.push(`# Unmatched booking emails`);
  md.push(``);
  md.push(
    `Generated ${new Date().toISOString().slice(0, 10)} · bookings since ${since} · ` +
      `${events} sessions · ${total} emails with no Volunteers row.`,
  );
  md.push(``);
  md.push(`## Add the address to an existing record (${linked.length})`);
  md.push(``);
  md.push(`Suggestions, not certainties. Check each before editing.`);
  md.push(``);
  md.push(`| Booking email | Booked as | Sessions | Last | Likely who | Why | Confidence |`);
  md.push(`|---|---|---|---|---|---|---|`);
  for (const { s, sug } of linked) {
    md.push(
      `| \`${s.email}\` | ${s.names.join(" / ") || "—"} | ${s.sessions.length} | ${s.last} | ${sug.volunteer.name} | ${sug.reason} | ${sug.confidence} |`,
    );
  }
  md.push(``);
  md.push(`## No matching volunteer (${newPeople.length})`);
  md.push(``);
  md.push(`Either they need a Volunteers record, or they are staff or guests who don't need one.`);
  md.push(``);
  md.push(`| Booking email | Booked as | Sessions | First | Last |`);
  md.push(`|---|---|---|---|---|`);
  for (const s of newPeople) {
    md.push(`| \`${s.email}\` | ${s.names.join(" / ") || "—"} | ${s.sessions.length} | ${s.first} | ${s.last} |`);
  }
  md.push(``);
  md.push(`## Sessions affected`);
  md.push(``);
  for (const s of [...linked.map((l) => l.s), ...newPeople]) {
    md.push(`**${s.email}** (${s.names.join(" / ") || "no name"})`);
    md.push(``);
    for (const line of [...s.sessions].sort()) md.push(`- ${line}`);
    md.push(``);
  }
  md.push(`---`);
  md.push(``);
  md.push(
    `After fixing records in Notion, re-run \`npm run backfill -- --since=${since}\` ` +
      `to link the sessions. The backfill is idempotent and leaves Status and ` +
      `[CANCELED] titles alone.`,
  );

  const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "unmatched-report.md");
  writeFileSync(out, md.join("\n"), "utf8");
  console.log(`\n📄 Report written to: ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
