// Quick read-only check: how many Group rows now have Host / Co-host populated.
import { requireEnv, optionalEnv } from "./_env.js";
import { NotionClient } from "../src/notion.js";

async function main() {
  const notion = new NotionClient({
    token: requireEnv("NOTION_TOKEN"),
    apiVersion: optionalEnv("NOTION_API_VERSION", "2022-06-28"),
  });
  const groups = await notion.listGroups(requireEnv("NOTION_GROUPS_DB_ID"));
  const withHost = groups.filter((g) => g.hostIds.length > 0).length;
  const withCoHost = groups.filter((g) => g.coHostIds.length > 0).length;
  const withEither = groups.filter((g) => g.hostIds.length > 0 || g.coHostIds.length > 0).length;
  console.log(`Total group rows:      ${groups.length}`);
  console.log(`  with Host:           ${withHost}`);
  console.log(`  with Co-host:        ${withCoHost}`);
  console.log(`  with Host or Co-host:${withEither}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
