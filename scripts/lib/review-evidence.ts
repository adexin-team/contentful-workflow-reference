import { randomUUID } from "node:crypto"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  assertExactKeys,
  assertRecord,
  canonicalJson,
  canonicalStringify,
  readJson,
  sha256Bytes,
} from "./core.js"
import { assertProjectProfileBinding, projectProfileBinding, projectReviewOrigin } from "./project-profile.js"
import type { ProjectProfile } from "./types.js"

const COMMIT = /^[a-f0-9]{40}$/
const DIGEST = /^[a-f0-9]{64}$/

export interface ReviewIdentities {
  baselineGenerationDigest: string
  changesetDigest: string
  gatsbyCommit: string
  workflowCommit: string
}

export interface ReviewEvidence {
  identities: ReviewIdentities
  profile: ReturnType<typeof projectProfileBinding>
  routes: { count: number; digest: string }
  schemaVersion: 2
  status: "verified"
  target: { environmentId: string; origin: string }
}

export function reviewEvidencePath(root: string): string {
  return path.join(root, ".tmp/contentful-workflow/review-evidence.json")
}

function validateIdentities(value: unknown): ReviewIdentities {
  const identities = assertRecord(value, "Review evidence identities")
  assertExactKeys(
    identities,
    ["baselineGenerationDigest", "changesetDigest", "gatsbyCommit", "workflowCommit"],
    "Review evidence identities",
  )
  for (const key of ["baselineGenerationDigest", "changesetDigest"] as const) {
    if (typeof identities[key] !== "string" || !DIGEST.test(identities[key])) {
      throw new Error(`Review evidence ${key} is malformed`)
    }
  }
  for (const key of ["gatsbyCommit", "workflowCommit"] as const) {
    if (typeof identities[key] !== "string" || !COMMIT.test(identities[key])) {
      throw new Error(`Review evidence ${key} is malformed`)
    }
  }
  return identities as unknown as ReviewIdentities
}

export function assertReviewEvidence(
  value: unknown,
  project: ProjectProfile,
  expected?: ReviewIdentities,
): ReviewEvidence {
  const evidence = assertRecord(value, "Review evidence")
  assertExactKeys(evidence, ["identities", "profile", "routes", "schemaVersion", "status", "target"], "Review evidence")
  const identities = validateIdentities(evidence.identities)
  assertProjectProfileBinding(evidence.profile, project)
  const routes = assertRecord(evidence.routes, "Review evidence routes")
  assertExactKeys(routes, ["count", "digest"], "Review evidence routes")
  if (!Number.isSafeInteger(routes.count) || (routes.count as number) < 1) {
    throw new Error("Review evidence route count is malformed")
  }
  if (typeof routes.digest !== "string" || !DIGEST.test(routes.digest)) {
    throw new Error("Review evidence route digest is malformed")
  }
  const target = assertRecord(evidence.target, "Review evidence target")
  assertExactKeys(target, ["environmentId", "origin"], "Review evidence target")
  if (
    evidence.schemaVersion !== 2 ||
    evidence.status !== "verified" ||
    target.environmentId !== project.previewEnvironment ||
    target.origin !== projectReviewOrigin(project)
  ) {
    throw new Error("Review evidence is not a verified fixed-target review")
  }
  if (expected && canonicalStringify(identities) !== canonicalStringify(expected)) {
    throw new Error("Review evidence identities do not match the exact candidate")
  }
  return evidence as unknown as ReviewEvidence
}

export async function readReviewEvidence(
  root: string,
  project: ProjectProfile,
  expected?: ReviewIdentities,
): Promise<ReviewEvidence> {
  return assertReviewEvidence(await readJson(reviewEvidencePath(root)), project, expected)
}

export async function writeReviewEvidence(
  root: string,
  identities: ReviewIdentities,
  project: ProjectProfile,
  requestedPaths: string[],
): Promise<ReviewEvidence> {
  const evidence: ReviewEvidence = {
    identities,
    profile: projectProfileBinding(project),
    routes: {
      count: requestedPaths.length,
      digest: sha256Bytes(canonicalStringify(requestedPaths)),
    },
    schemaVersion: 2,
    status: "verified",
    target: { environmentId: project.previewEnvironment, origin: projectReviewOrigin(project) },
  }
  assertReviewEvidence(evidence, project, identities)
  const output = reviewEvidencePath(root)
  const temporary = path.join(path.dirname(output), `.review-evidence-${randomUUID()}.tmp`)
  await mkdir(path.dirname(output), { recursive: true })
  try {
    await writeFile(temporary, canonicalJson(evidence), { flag: "wx" })
    await rename(temporary, output)
  } finally {
    await rm(temporary, { force: true })
  }
  return evidence
}
