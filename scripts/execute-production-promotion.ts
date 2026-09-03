import { pathToFileURL } from "node:url"
import { repoRoot } from "./lib/core.js"
import { executeProductionPromotion } from "./lib/promotion.js"
import { loadProjectProfileWithEnvironment } from "./lib/project-profile.js"

export async function main(): Promise<void> {
  const project = await loadProjectProfileWithEnvironment(repoRoot)
  const args = process.argv.slice(2)
  if (args.length !== 1 || !args[0]?.startsWith("--confirm=PROMOTE:")) throw new Error("One exact --confirm argument is required")
  const journal = await executeProductionPromotion({ activation: {
    baselineGenerationDigest: process.env.CONTENTFUL_AI_PREVIEW_BASELINE_GENERATION_DIGEST,
    cdaAttestation: process.env.CONTENTFUL_PRODUCTION_CDA_ATTESTATION,
    cdaToken: process.env.CONTENTFUL_PRODUCTION_CDA_TOKEN,
    changesetDigest: process.env.CONTENTFUL_AI_PREVIEW_CHANGESET_DIGEST,
    cmaAttestation: process.env.CONTENTFUL_PRODUCTION_CMA_ATTESTATION,
    cmaReadToken: process.env.CONTENTFUL_PRODUCTION_CMA_READ_TOKEN,
    cmaWriteToken: process.env.CONTENTFUL_PRODUCTION_CMA_WRITE_TOKEN,
    gatsbyCommit: process.env.CONTENTFUL_AI_PREVIEW_GATSBY_COMMIT,
    executionWorkflowCommit: process.env.CONTENTFUL_WORKFLOW_EXECUTION_COMMIT,
    workflowCommit: process.env.CONTENTFUL_AI_PREVIEW_WORKFLOW_COMMIT,
  }, confirmation: args[0].slice("--confirm=".length), project, root: repoRoot })
  console.log(`Verified production promotion ${journal.candidateDigest}; the alias was not mutated.`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
