import { pathToFileURL } from "node:url"
import { closeCycle } from "./lib/close-cycle.js"
import { repoRoot } from "./lib/core.js"
import { loadProjectProfileWithEnvironment } from "./lib/project-profile.js"

export async function main(): Promise<void> {
  const project = await loadProjectProfileWithEnvironment(repoRoot)
  const result = await closeCycle({ activation: {
    baselineGenerationDigest: process.env.CONTENTFUL_AI_PREVIEW_BASELINE_GENERATION_DIGEST,
    cdaAttestation: process.env.CONTENTFUL_AI_PREVIEW_CDA_ATTESTATION,
    cdaToken: process.env.CONTENTFUL_AI_PREVIEW_CDA_TOKEN,
    changesetDigest: process.env.CONTENTFUL_AI_PREVIEW_CHANGESET_DIGEST,
    gatsbyCommit: process.env.CONTENTFUL_AI_PREVIEW_GATSBY_COMMIT,
    executionWorkflowCommit: process.env.CONTENTFUL_WORKFLOW_EXECUTION_COMMIT,
    workflowCommit: process.env.CONTENTFUL_AI_PREVIEW_WORKFLOW_COMMIT,
  }, project, root: repoRoot })
  console.log(`Closed reviewed cycle into generation ${result.newGenerationDigest}; Git remains separately authorized.`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
