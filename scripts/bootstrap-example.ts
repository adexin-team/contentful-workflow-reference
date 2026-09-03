import { pathToFileURL } from "node:url"
import { repoRoot } from "./lib/core.js"
import { bootstrapGenerationState } from "./lib/generation.js"
import { loadProjectProfile } from "./lib/project-profile.js"

export async function main(): Promise<void> {
  if (process.argv.length > 2) throw new Error("content:bootstrap-example accepts no arguments")
  const digest = await bootstrapGenerationState(repoRoot, await loadProjectProfile(repoRoot))
  console.log(`Bootstrapped the shipped local example at baseline generation ${digest}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
