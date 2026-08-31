// Creates (or refreshes) a Notion page for the volunteer coordinator: the
// email records that need fixing, plus a short note on how the counts work.
//
// Built from live data each time, so re-running keeps it current.
//
//   npm run christy:page -- --parent=<notion page url or id> --dry-run
//   npm run christy:page -- --parent=<notion page url or id>
//
// The parent is whichever Notion page the new page should sit under. Open that
// page in Notion, copy the URL from the address bar, and paste it in.

import { requireEnv, optionalEnv } from "./_env.js";
import { CalendlyClient } from "../src/calendly.js";
import { NotionClient } from "../src/notion.js";
import { collectUnmatched, type Seen, type Suggestion } from "./_unmatched-core.js";

const PAGE_TITLE = "Volunteer tracker — what needs updating";

const arg = (name: string) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : undefined;
};
const dryRun = process.argv.includes("--dry-run");
const since = arg("since") ?? "2025-04-01";
const parentRaw = arg("parent");

if (!parentRaw) {
  console.error(
    "Missing --parent.\n\n" +
      "Open the Notion page this should sit under, copy the URL, and pass it:\n" +
      "  npm run christy:page -- --parent=https://www.notion.so/Your-Page-abc123...\n",
  );
  process.exit(1);
}

// A Notion URL ends in a 32-character id, sometimes with dashes.
function toPageId(input: string): string {
  const match = input.replace(/-/g, "").match(/([0-9a-f]{32})(?!.*[0-9a-f]{32})/i);
  if (!match) {
    console.error(`Couldn't find a page id in "${input}". Paste the full Notion page URL.`);
    process.exit(1);
  }
  return match[1]!;
}
const parentId = toPageId(parentRaw);

const token = requireEnv("NOTION_TOKEN");
const apiVersion = optionalEnv("NOTION_API_VERSION", "2022-06-28");

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

// ── block helpers ──
const text = (content: string, bold = false) => ({
  type: "text" as const,
  text: { content },
  annotations: { bold },
});
const para = (...rt: unknown[]) => ({ object: "block", type: "paragraph", paragraph: { rich_text: rt } });
const h2 = (s: string) => ({ object: "block", type: "heading_2", heading_2: { rich_text: [text(s)] } });
const h3 = (s: string) => ({ object: "block", type: "heading_3", heading_3: { rich_text: [text(s)] } });
const todo = (...rt: unknown[]) => ({
  object: "block",
  type: "to_do",
  to_do: { rich_text: rt, checked: false },
});
const bullet = (...rt: unknown[]) => ({
  object: "block",
  type: "bulleted_list_item",
  bulleted_list_item: { rich_text: rt },
});
const callout = (s: string, emoji: string) => ({
  object: "block",
  type: "callout",
  callout: { rich_text: [text(s)], icon: { type: "emoji", emoji } },
});
const divider = () => ({ object: "block", type: "divider", divider: {} });

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function linkedLine(s: Seen, sug: Suggestion) {
  return todo(
    text(s.email, true),
    text(
      ` — booked as ${s.names.join(" / ") || "no name"}, ${plural(s.sessions.length, "session", "sessions")}. ` +
        `Looks like ${sug.volunteer.name} (${sug.reason}). Add this address to their record.`,
    ),
  );
}

function newLine(s: Seen) {
  return todo(
    text(s.email, true),
    text(
      ` — booked as ${s.names.join(" / ") || "no name"}, ${plural(s.sessions.length, "session", "sessions")}, ` +
        `last on ${s.last}. No record found. Create one, or tell Anna if they don't need one.`,
    ),
  );
}

async function main() {
  const calendly = new CalendlyClient(
    requireEnv("CALENDLY_PAT"),
    optionalEnv("CALENDLY_API_BASE", "https://api.calendly.com"),
  );
  const notionClient = new NotionClient({ token, apiVersion });

  console.log(`Reading live data…`);
  const me = await calendly.me();
  const result = await collectUnmatched({
    calendly,
    notion: notionClient,
    volunteersDbId: requireEnv("NOTION_VOLUNTEERS_DB_ID"),
    organization: optionalEnv("CALENDLY_ORG_URI", me.current_organization),
    since,
    log: (m) => console.log(m),
  });

  const total = result.linked.length + result.newPeople.length;
  console.log(`  ${result.events} sessions, ${total} email(s) not matching a volunteer\n`);

  const blocks: unknown[] = [];

  blocks.push(
    callout(
      "The tracker links each Calendly booking to a volunteer record by email address. " +
        `These ${total} addresses don't match anyone, so those sessions aren't being counted for them.`,
      "📮",
    ),
  );

  blocks.push(h2("Emails to fix"));

  if (result.linked.length) {
    blocks.push(h3("Add the address to an existing record"));
    blocks.push(para(text("Best guesses. Check each one before editing.")));
    for (const { s, sug } of result.linked) blocks.push(linkedLine(s, sug));
  }

  if (result.newPeople.length) {
    blocks.push(h3("No record found"));
    blocks.push(para(text("Either they need a volunteer record, or they're staff or a guest who doesn't.")));
    for (const s of result.newPeople) blocks.push(newLine(s));
  }

  blocks.push(divider());
  blocks.push(h2("When you're done"));
  blocks.push(para(text("Tell Anna. She re-runs the sync and the sessions attach themselves.")));
  blocks.push(
    callout(
      "Don't add people to sessions by hand before that run. It refreshes every session from Calendly and " +
        "would wipe those edits.",
      "⚠️",
    ),
  );

  blocks.push(divider());
  blocks.push(h2("How the counts work"));
  blocks.push(
    bullet(text("Roles come from what the volunteer picked when booking: host, co-host or shadow host.")),
  );
  blocks.push(
    bullet(
      text("(auto)", true),
      text(" fields are counted from the sessions. You can't type into them."),
    ),
  );
  blocks.push(
    bullet(
      text("(manual)", true),
      text(" fields are yours. Nothing overwrites them, and the alerts ignore them."),
    ),
  );
  blocks.push(
    bullet(
      text("If a session is wrong, fix it on the session in the Groups database, not on the volunteer."),
    ),
  );
  blocks.push(
    bullet(text("Alerts run every morning at 9am and go to Slack. Nothing emails a volunteer yet.")),
  );

  if (dryRun) {
    console.log(`DRY RUN — would create "${PAGE_TITLE}" with ${blocks.length} blocks under ${parentId}.`);
    console.log(`\n  ${result.linked.length} to add to an existing record`);
    console.log(`  ${result.newPeople.length} with no record found`);
    return;
  }

  // Notion accepts 100 children per request.
  const first = blocks.slice(0, 100);
  const rest = blocks.slice(100);

  const page = await notion<{ id: string; url: string }>("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { page_id: parentId },
      icon: { type: "emoji", emoji: "📋" },
      properties: { title: [{ text: { content: PAGE_TITLE } }] },
      children: first,
    }),
  });

  for (let i = 0; i < rest.length; i += 100) {
    await notion(`/blocks/${page.id}/children`, {
      method: "PATCH",
      body: JSON.stringify({ children: rest.slice(i, i + 100) }),
    });
  }

  console.log(`Created: ${page.url}`);
  console.log(`  ${result.linked.length} to add to an existing record`);
  console.log(`  ${result.newPeople.length} with no record found`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
