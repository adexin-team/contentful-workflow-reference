import { pathToFileURL } from "node:url"
import { deriveChangeset } from "./lib/changeset.js"
import { repoRoot } from "./lib/core.js"
import { loadProjectProfile } from "./lib/project-profile.js"

export async function main(): Promise<void> {
  const changeset = await deriveChangeset(repoRoot, await loadProjectProfile(repoRoot))
  console.log(`Working generation is valid; ${(changeset.entries as unknown[]).length} changed entries.`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
