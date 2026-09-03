import { randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  assertExactKeys,
  assertRecord,
  canonicalJson,
  canonicalStringify,
  isNodeError,
  readJson,
  sha256Bytes,
} from "./core.js"
import { localGenerationIdentity } from "./generation.js"
import { verifyReviewGate, type ReviewActivation } from "./gatsby-preview.js"
import {
  assertVerifiedPromotionJournal,
  promotionCandidatePath,
  promotionJournalPath,
  readPromotionCandidate,
} from "./promotion.js"
import { readReviewEvidence, reviewEvidencePath } from "./review-evidence.js"
import { withPhaseLock } from "./phase-lock.js"
import { assertProjectProfileBinding, projectProfileBinding, validateProjectProfile } from "./project-profile.js"
import { synchronize } from "./sync.js"
import type { ProjectProfile } from "./types.js"

interface CloseActivation extends ReviewActivation {
  cdaAttestation: unknown
  cdaToken: unknown
}

export interface CloseCycleJournal {
  identities: {
    baselineGenerationDigest: string
    changesetDigest: string
    gatsbyCommit: string
    executionWorkflowCommit: string
    reviewEvidenceDigest: string
    workflowCommit: string
  }
  newGenerationDigest: string | null
  profile: ReturnType<typeof projectProfileBinding>
  productionCandidateDigest: string
  schemaVersion: 2
  status: "closing" | "failed" | "verified"
  target: { environmentId: string; spaceId: string }
}

export interface CloseCycleOptions {
  activation: CloseActivation
  fetchImpl?: typeof fetch
  processExists?: (pid: number) => boolean
  project: ProjectProfile
  repositoryGate?: () => Promise<{ gatsbyCommit: string; workflowCommit: string }>
  root: string
}

function closeJournalPath(root: string): string {
  return path.join(root, ".tmp/contentful-workflow/cycle-close.json")
}

async function exists(target: string): Promise<boolean> {
  try { await lstat(target); return true } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return false
    throw error
  }
}

function activeArtifactPaths(root: string): string[] {
  return [
    path.join(root, ".tmp/contentful-workflow/apply-attempt.json"),
    path.join(root, ".tmp/contentful-workflow/changeset.json"),
    reviewEvidencePath(root),
    promotionCandidatePath(root),
    promotionJournalPath(root),
  ]
}

async function artifactSnapshot(root: string): Promise<Map<string, string | null>> {
  const snapshot = new Map<string, string | null>()
  for (const target of activeArtifactPaths(root)) {
    try {
      const metadata = await lstat(target)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Active cycle artifact is not a regular file: ${target}`)
      snapshot.set(target, await readFile(target, "utf8"))
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") snapshot.set(target, null)
      else throw error
    }
  }
  return snapshot
}

async function assertArtifactSnapshot(expected: Map<string, string | null>): Promise<void> {
  for (const [target, bytes] of expected) {
    let current: string | null
    try {
      const metadata = await lstat(target)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Active cycle artifact changed shape: ${target}`)
      current = await readFile(target, "utf8")
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") current = null
      else throw error
    }
    if (current !== bytes) throw new Error("Active cycle evidence changed during close; refusing cleanup")
  }
}

async function atomicWrite(output: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true })
  const temporary = path.join(path.dirname(output), `.cycle-close-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, canonicalJson(value), { flag: "wx" })
    await rename(temporary, output)
  } finally { await rm(temporary, { force: true }) }
}

function defaultProcessExists(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ESRCH") return false
    return true
  }
}

async function assertDisposablePreviewStopped(root: string, processExists: (pid: number) => boolean): Promise<string | undefined> {
  const previewRoot = path.join(root, ".tmp/contentful-workflow/gatsby-preview")
  if (!(await exists(previewRoot))) return undefined
  const runs = await readdir(previewRoot, { withFileTypes: true })
  for (const run of runs) {
    if (!run.isDirectory() || run.isSymbolicLink()) throw new Error("Disposable Gatsby review state is malformed")
    const session = assertRecord(await readJson(path.join(previewRoot, run.name, "session.json")), "Disposable Gatsby session")
    if (!Number.isSafeInteger(session.pid) || (session.pid as number) < 1) throw new Error("Disposable Gatsby session pid is malformed")
    if (processExists(session.pid as number)) throw new Error("Stop the disposable Gatsby process before closing the cycle")
  }
  return previewRoot
}

async function verifiedPromotionDigest(
  root: string,
  expectedIdentities: CloseCycleJournal["identities"],
  project: ProjectProfile,
): Promise<string> {
  const candidateFile = promotionCandidatePath(root)
  const journalFile = promotionJournalPath(root)
  const [hasCandidate, hasJournal] = await Promise.all([exists(candidateFile), exists(journalFile)])
  if (!hasCandidate && !hasJournal) throw new Error("A fully verified production promotion is required before cycle close")
  if (hasCandidate !== hasJournal) throw new Error("An incomplete production promotion candidate/attempt blocks cycle close")
  const candidate = await readPromotionCandidate(root, project)
  const expectedCandidateIdentities = {
    baselineGenerationDigest: expectedIdentities.baselineGenerationDigest,
    changesetDigest: expectedIdentities.changesetDigest,
    gatsbyCommit: expectedIdentities.gatsbyCommit,
    executionWorkflowCommit: expectedIdentities.executionWorkflowCommit,
    reviewEvidenceDigest: expectedIdentities.reviewEvidenceDigest,
    workflowCommit: expectedIdentities.workflowCommit,
  }
  if (canonicalStringify(candidate.identities) !== canonicalStringify(expectedCandidateIdentities)) {
    throw new Error("Production candidate identities do not match the current verified review")
  }
  assertVerifiedPromotionJournal(await readJson(journalFile), candidate, project)
  return candidate.candidateDigest
}

async function assertNoUnresolvedCloseAttempt(root: string, project: ProjectProfile): Promise<void> {
  const target = closeJournalPath(root)
  if (!(await exists(target))) return
  try {
    const previous = assertRecord(await readJson(target), "Previous cycle-close journal")
    assertExactKeys(previous, ["identities", "newGenerationDigest", "productionCandidateDigest", "profile", "schemaVersion", "status", "target"], "Previous cycle-close journal")
    assertProjectProfileBinding(previous.profile, project)
    const identities = assertRecord(previous.identities, "Previous cycle-close identities")
    assertExactKeys(identities, ["baselineGenerationDigest", "changesetDigest", "gatsbyCommit", "executionWorkflowCommit", "reviewEvidenceDigest", "workflowCommit"], "Previous cycle-close identities")
    const targetRecord = assertRecord(previous.target, "Previous cycle-close target")
    assertExactKeys(targetRecord, ["environmentId", "spaceId"], "Previous cycle-close target")
    for (const key of ["baselineGenerationDigest", "changesetDigest", "reviewEvidenceDigest"] as const) {
      if (typeof identities[key] !== "string" || !/^[a-f0-9]{64}$/.test(identities[key])) throw new Error("malformed digest")
    }
    for (const key of ["gatsbyCommit", "executionWorkflowCommit", "workflowCommit"] as const) {
      if (typeof identities[key] !== "string" || !/^[a-f0-9]{40}$/.test(identities[key])) throw new Error("malformed commit")
    }
    if (
      previous.schemaVersion !== 2 ||
      previous.status !== "verified" ||
      typeof previous.newGenerationDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(previous.newGenerationDigest) ||
      typeof previous.productionCandidateDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(previous.productionCandidateDigest) ||
      targetRecord.environmentId !== project.previewEnvironment ||
      targetRecord.spaceId !== project.spaceId
    ) throw new Error("unverified")
  } catch {
    throw new Error("An unresolved cycle-close attempt journal exists; owner direction is required")
  }
}

async function closeCycleUnlocked(options: CloseCycleOptions): Promise<CloseCycleJournal> {
  await assertNoUnresolvedCloseAttempt(options.root, options.project)
  const reviewedLocalIdentity = await localGenerationIdentity(options.root)
  const artifacts = await artifactSnapshot(options.root)
  const verified = await verifyReviewGate(options.root, options.project, options.activation, options.repositoryGate)
  const review = await readReviewEvidence(options.root, options.project, verified.activation)
  if ((await localGenerationIdentity(options.root)) !== reviewedLocalIdentity) {
    throw new Error("Local generation changed during the close-cycle reviewed gate")
  }
  const closeIdentities = {
    ...verified.activation,
    executionWorkflowCommit: verified.repository.workflowCommit,
    reviewEvidenceDigest: sha256Bytes(canonicalStringify(review)),
  }
  const productionCandidateDigest = await verifiedPromotionDigest(options.root, closeIdentities, options.project)
  const previewRoot = await assertDisposablePreviewStopped(options.root, options.processExists ?? defaultProcessExists)
  await assertArtifactSnapshot(artifacts)
  const journal: CloseCycleJournal = {
    identities: closeIdentities,
    newGenerationDigest: null,
    profile: projectProfileBinding(options.project),
    productionCandidateDigest,
    schemaVersion: 2,
    status: "closing",
    target: { environmentId: options.project.previewEnvironment, spaceId: options.project.spaceId },
  }
  const journalPath = closeJournalPath(options.root)
  await atomicWrite(journalPath, journal)
  try {
    const result = await synchronize({
      allowReviewedWorkingReplacement: true,
      attestation: options.activation.cdaAttestation,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      expectedLocalIdentity: reviewedLocalIdentity,
      initial: true,
      project: options.project,
      root: options.root,
      token: options.activation.cdaToken,
    })
    journal.newGenerationDigest = result.generationDigest
    await atomicWrite(journalPath, journal)
    await assertArtifactSnapshot(artifacts)
    await assertDisposablePreviewStopped(options.root, options.processExists ?? defaultProcessExists)
    await Promise.all([
      rm(path.join(options.root, ".tmp/contentful-workflow/apply-attempt.json"), { force: true }),
      rm(path.join(options.root, ".tmp/contentful-workflow/changeset.json"), { force: true }),
      rm(reviewEvidencePath(options.root), { force: true }),
      rm(promotionCandidatePath(options.root), { force: true }),
      rm(promotionJournalPath(options.root), { force: true }),
      ...(previewRoot ? [rm(previewRoot, { force: true, recursive: true })] : []),
    ])
    journal.status = "verified"
    await atomicWrite(journalPath, journal)
  } catch (error: unknown) {
    journal.status = "failed"
    await atomicWrite(journalPath, journal)
    throw error
  }
  return journal
}

export async function closeCycle(options: CloseCycleOptions): Promise<CloseCycleJournal> {
  return withPhaseLock(options.root, () => closeCycleUnlocked(options))
}

export async function readProjectForClose(root: string): Promise<ProjectProfile> {
  return validateProjectProfile(JSON.parse(await readFile(path.join(root, "config/project.json"), "utf8")))
}
