import { pathToFileURL } from "node:url"
import { repoRoot } from "./lib/core.js"
import { startGatsbyPreview } from "./lib/gatsby-preview.js"
import { loadProjectProfileWithEnvironment } from "./lib/project-profile.js"

export async function main(): Promise<void> {
  const project = await loadProjectProfileWithEnvironment(repoRoot)
  const { child, siteRoot } = await startGatsbyPreview({
    activation: {
      baselineGenerationDigest: process.env.CONTENTFUL_AI_PREVIEW_BASELINE_GENERATION_DIGEST,
      changesetDigest: process.env.CONTENTFUL_AI_PREVIEW_CHANGESET_DIGEST,
      gatsbyCommit: process.env.CONTENTFUL_AI_PREVIEW_GATSBY_COMMIT,
      executionWorkflowCommit: process.env.CONTENTFUL_WORKFLOW_EXECUTION_COMMIT,
      cdaAttestation: process.env.CONTENTFUL_AI_PREVIEW_CDA_ATTESTATION,
      cdaToken: process.env.CONTENTFUL_AI_PREVIEW_CDA_TOKEN,
      refreshToken: process.env.CONTENTFUL_AI_PREVIEW_GATSBY_REFRESH_TOKEN,
      workflowCommit: process.env.CONTENTFUL_AI_PREVIEW_WORKFLOW_COMMIT,
    }, project, root: repoRoot,
  })
  console.log(`Disposable Gatsby review started at ${siteRoot}; no production continuation exists.`)
  child.on("exit", (code) => { process.exitCode = code ?? 1 })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
