// Delete a webhook subscription by URI or UUID.
// Run:  npm run delete:webhook -- <uri-or-uuid>

import { requireEnv, optionalEnv } from "./_env.js";
import { CalendlyClient } from "../src/calendly.js";

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: tsx scripts/delete-webhook.ts <webhook-uri-or-uuid>");
    process.exit(1);
  }
  const pat = requireEnv("CALENDLY_PAT");
  const base = optionalEnv("CALENDLY_API_BASE", "https://api.calendly.com");
  const client = new CalendlyClient(pat, base);

  await client.deleteWebhookSubscription(target);
  console.log(`✅ Deleted ${target}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
