// Debug: list all webhook subscriptions on the current Calendly account.

import { requireEnv, optionalEnv } from "./_env.js";
import { CalendlyClient } from "../src/calendly.js";

async function main() {
  const pat = requireEnv("CALENDLY_PAT");
  const base = optionalEnv("CALENDLY_API_BASE", "https://api.calendly.com");
  const client = new CalendlyClient(pat, base);

  const me = await client.me();
  const orgUri = optionalEnv("CALENDLY_ORG_URI", me.current_organization);
  const userUri = optionalEnv("CALENDLY_USER_URI", me.uri);

  const userSubs = await client.listWebhookSubscriptions({
    scope: "user",
    user: userUri,
    organization: orgUri,
  });
  const orgSubs = await client.listWebhookSubscriptions({
    scope: "organization",
    organization: orgUri,
  });

  console.log(`User-scoped subscriptions (${userSubs.length}):`);
  for (const s of userSubs) {
    console.log(`  - ${s.uri}`);
    console.log(`      callback: ${s.callback_url}`);
    console.log(`      events:   ${s.events.join(", ")}`);
    console.log(`      state:    ${s.state}`);
  }

  console.log(`\nOrg-scoped subscriptions (${orgSubs.length}):`);
  for (const s of orgSubs) {
    console.log(`  - ${s.uri}`);
    console.log(`      callback: ${s.callback_url}`);
    console.log(`      events:   ${s.events.join(", ")}`);
    console.log(`      state:    ${s.state}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
