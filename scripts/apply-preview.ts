import { pathToFileURL } from "node:url"
import { applyAiPreview } from "./lib/apply/apply.js"
import { repoRoot } from "./lib/core.js"
import { loadProjectProfileWithEnvironment } from "./lib/project-profile.js"

export async function main(): Promise<void> {
  const project = await loadProjectProfileWithEnvironment(repoRoot)
  if (process.argv.length > 2) throw new Error("content:apply accepts no arguments")
  const result = await applyAiPreview({
    activation: {
      baselineGenerationDigest: process.env.CONTENTFUL_AI_PREVIEW_BASELINE_GENERATION_DIGEST,
      changesetDigest: process.env.CONTENTFUL_AI_PREVIEW_CHANGESET_DIGEST,
      cmaAttestation: process.env.CONTENTFUL_AI_PREVIEW_CMA_ATTESTATION,
      cmaToken: process.env.CONTENTFUL_AI_PREVIEW_CMA_TOKEN,
      gatsbyCommit: process.env.CONTENTFUL_AI_PREVIEW_GATSBY_COMMIT,
      cpaAttestation: process.env.CONTENTFUL_AI_PREVIEW_CPA_ATTESTATION,
      cpaToken: process.env.CONTENTFUL_AI_PREVIEW_CPA_TOKEN,
      workflowCommit: process.env.CONTENTFUL_AI_PREVIEW_WORKFLOW_COMMIT,
    },
    project,
    root: repoRoot,
  })
  console.log(`Verified preview apply ${result.changesetDigest} for ${result.entryIds.length} entries.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
