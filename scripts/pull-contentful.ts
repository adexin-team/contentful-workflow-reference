import { pathToFileURL } from "node:url"
import { repoRoot } from "./lib/core.js"
import { loadProjectProfileWithEnvironment } from "./lib/project-profile.js"
import { synchronize } from "./lib/sync.js"

export async function main(): Promise<void> {
  const project = await loadProjectProfileWithEnvironment(repoRoot)
  const args = process.argv.slice(2)
  if (args.some((argument) => argument !== "--initial")) throw new Error("content:sync accepts only --initial")
  const result = await synchronize({
    attestation: process.env.CONTENTFUL_AI_PREVIEW_CDA_ATTESTATION,
    initial: args.includes("--initial"), project, root: repoRoot, token: process.env.CONTENTFUL_AI_PREVIEW_CDA_TOKEN,
  })
  console.log(`Installed preview generation ${result.generationDigest}.`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
