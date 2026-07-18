// One-time: register the Calendly webhook subscription that points at the Worker.
//
// Run:  npm run setup:webhook
// Reads CALENDLY_PAT, WORKER_URL, CALENDLY_WEBHOOK_SIGNING_KEY from .env.

import { requireEnv, optionalEnv } from "./_env.js";
import { CalendlyClient } from "../src/calendly.js";

async function main() {
  const pat = requireEnv("CALENDLY_PAT");
  const workerUrl = requireEnv("WORKER_URL");
  const signingKey = requireEnv("CALENDLY_WEBHOOK_SIGNING_KEY");
  const base = optionalEnv("CALENDLY_API_BASE", "https://api.calendly.com");

  const callbackUrl = workerUrl.replace(/\/$/, "") + "/webhook";

  const client = new CalendlyClient(pat, base);
  const me = await client.me();
  const userUri = optionalEnv("CALENDLY_USER_URI", me.uri);
  const orgUri = optionalEnv("CALENDLY_ORG_URI", me.current_organization);

  console.log("Registering webhook subscription:");
  console.log(`  callback_url: ${callbackUrl}`);
  console.log(`  scope:        user`);
  console.log(`  user:         ${userUri}`);
  console.log(`  organization: ${orgUri}`);
  console.log(`  events:       invitee.created, invitee.canceled\n`);

  const sub = await client.createWebhookSubscription({
    callbackUrl,
    events: ["invitee.created", "invitee.canceled"],
    scope: "user",
    user: userUri,
    organization: orgUri,
    signingKey,
  });

  console.log("✅ Subscription created");
  console.log(`   URI:   ${sub.uri}`);
  console.log(`   State: ${sub.state}`);
  console.log("\nTest it by booking a fake slot on a Calendly event type and");
  console.log("then checking `wrangler tail` for the delivery.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
