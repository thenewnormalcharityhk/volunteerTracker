// Sanity-check the Calendly PAT and print user + organization URIs.
// Run: pnpm calendly:whoami   (or  npm run calendly:whoami)

import { requireEnv, optionalEnv } from "./_env.js";
import { CalendlyClient } from "../src/calendly.js";

async function main() {
  const pat = requireEnv("CALENDLY_PAT");
  const base = optionalEnv("CALENDLY_API_BASE", "https://api.calendly.com");
  const client = new CalendlyClient(pat, base);

  const me = await client.me();
  console.log("Calendly user:");
  console.log(`  Name:         ${me.name}`);
  console.log(`  Email:        ${me.email}`);
  console.log(`  User URI:     ${me.uri}`);
  console.log(`  Organization: ${me.current_organization}`);

  const types = await client.listEventTypes({ user: me.uri });
  console.log(`\nEvent types (${types.length}):`);
  for (const t of types) {
    console.log(`  - ${t.name}  ${t.active ? "" : "(inactive)"}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
