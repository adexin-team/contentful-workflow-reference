import { pathToFileURL } from "node:url"
import { repoRoot } from "./lib/core.js"
import { refreshGatsbyPreview } from "./lib/gatsby-preview.js"
import { loadProjectProfileWithEnvironment } from "./lib/project-profile.js"

export async function main(): Promise<void> {
  const project = await loadProjectProfileWithEnvironment(repoRoot)
  const result = await refreshGatsbyPreview({ activation: {
    baselineGenerationDigest: process.env.CONTENTFUL_AI_PREVIEW_BASELINE_GENERATION_DIGEST,
    changesetDigest: process.env.CONTENTFUL_AI_PREVIEW_CHANGESET_DIGEST,
    gatsbyCommit: process.env.CONTENTFUL_AI_PREVIEW_GATSBY_COMMIT,
    executionWorkflowCommit: process.env.CONTENTFUL_WORKFLOW_EXECUTION_COMMIT,
    workflowCommit: process.env.CONTENTFUL_AI_PREVIEW_WORKFLOW_COMMIT,
  }, project, root: repoRoot })
  console.log(`Local Gatsby review passed for ${result.routeCount} routes; production remains separately authorized.`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
