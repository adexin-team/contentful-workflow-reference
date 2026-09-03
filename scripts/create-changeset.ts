import { pathToFileURL } from "node:url"
import { createChangeset } from "./lib/changeset.js"
import { repoRoot } from "./lib/core.js"
import { loadProjectProfile } from "./lib/project-profile.js"

export async function main(): Promise<void> {
  const changeset = await createChangeset(repoRoot, await loadProjectProfile(repoRoot))
  console.log(`Created deterministic changeset ${String(changeset.changesetDigest)}.`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
