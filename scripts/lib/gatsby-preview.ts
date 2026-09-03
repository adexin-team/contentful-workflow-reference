import { execFile, spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { Dirent } from "node:fs"
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import type { Readable } from "node:stream"
import { promisify } from "node:util"
import { assertRepositoryState, type RepositoryGateResult } from "./apply/git.js"
import { attemptJournalPath, type AttemptJournal } from "./apply/journal.js"
import { deriveChangeset } from "./changeset.js"
import { DELIVERY_HOST, validateCredentialInput } from "./credentials.js"
import {
  assertExactKeys,
  assertExactLink,
  assertRecord,
  bytewiseCompare,
  canonicalJson,
  canonicalStringify,
  readJson,
  sha256Bytes,
} from "./core.js"
import { assertSynchronizedGeneration, resourcesFromTree, type GenerationResources } from "./generation.js"
import { writeReviewEvidence, type ReviewEvidence } from "./review-evidence.js"
import { withPhaseLock } from "./phase-lock.js"
import { assertProjectProfileBinding, LOOPBACK_REVIEW_HOST, projectProfileBinding, projectReviewOrigin, validateProjectProfile } from "./project-profile.js"
import type { ProjectProfile } from "./types.js"
import { entryContentType, entryFields } from "./validation.js"
import { assertSupportedNodeVersion } from "../check-runtime.mjs"

const execFileAsync = promisify(execFile)
const COMMIT = /^[a-f0-9]{40}$/
const DIGEST = /^[a-f0-9]{64}$/
const DEFAULT_TIMEOUT_MS = 600_000
const MAX_TIMEOUT_MS = 1_800_000
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export interface ReviewActivation {
  baselineGenerationDigest: unknown
  changesetDigest: unknown
  gatsbyCommit: unknown
  executionWorkflowCommit?: unknown
  workflowCommit: unknown
}

export interface StartActivation extends ReviewActivation {
  cdaAttestation: unknown
  cdaToken: unknown
  refreshToken: unknown
}

interface EntryChange {
  contentType: string
  entryId: string
  fields: Array<{ fieldId: string; locales: Array<{ after: unknown; before: unknown; locale: string }> }>
}

interface VerifiedReview {
  activation: { baselineGenerationDigest: string; changesetDigest: string; gatsbyCommit: string; workflowCommit: string }
  changes: EntryChange[]
  generation: Awaited<ReturnType<typeof assertSynchronizedGeneration>>
  journal: AttemptJournal
  repository: RepositoryGateResult
}

export interface CommandInvocation {
  args: string[]
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
}

export type RunCommand = (invocation: CommandInvocation) => Promise<void>

function exactString(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is malformed`)
  return value
}

function parseChanges(value: Record<string, unknown>): EntryChange[] {
  if (!Array.isArray(value.entries)) throw new Error("Changeset entries are malformed")
  return value.entries.map((rawEntry, entryIndex) => {
    const entry = assertRecord(rawEntry, `Changeset entry ${entryIndex}`)
    if (typeof entry.entryId !== "string" || typeof entry.contentType !== "string" || !Array.isArray(entry.fields)) {
      throw new Error(`Changeset entry ${entryIndex} is malformed`)
    }
    return {
      contentType: entry.contentType,
      entryId: entry.entryId,
      fields: entry.fields.map((rawField, fieldIndex) => {
        const field = assertRecord(rawField, `Changeset field ${fieldIndex}`)
        if (typeof field.fieldId !== "string" || !Array.isArray(field.locales)) throw new Error("Changeset field is malformed")
        return {
          fieldId: field.fieldId,
          locales: field.locales.map((rawLocale) => {
            const locale = assertRecord(rawLocale, "Changeset locale")
            if (typeof locale.locale !== "string") throw new Error("Changeset locale is malformed")
            return { after: locale.after, before: locale.before, locale: locale.locale }
          }),
        }
      }),
    }
  })
}

function assertVerifiedJournal(journal: AttemptJournal, expected: VerifiedReview["activation"], changes: EntryChange[], project: ProjectProfile): void {
  assertExactKeys(journal as unknown as Record<string, unknown>, ["entries", "identities", "profile", "schemaVersion", "status", "target"], "Apply journal")
  if (journal.schemaVersion !== 2 || journal.status !== "verified") throw new Error("Apply journal is not fully verified")
  assertProjectProfileBinding(journal.profile, project)
  if (journal.target.environmentId !== project.previewEnvironment || journal.target.spaceId !== project.spaceId) throw new Error("Apply journal target is wrong")
  assertExactKeys(journal.identities, ["baselineGenerationDigest", "changesetDigest", "gatsbyCommit", "workflowCommit"], "Apply journal identities")
  if (canonicalStringify(journal.identities) !== canonicalStringify(expected)) throw new Error("Apply journal identities do not match review activation")
  if (journal.entries.length !== changes.length || journal.entries.some((entry, index) => entry.entryId !== changes[index]?.entryId)) {
    throw new Error("Apply journal entries do not match the exact changeset")
  }
  for (const entry of journal.entries) {
    assertExactKeys(entry.actions, ["publish", "update", "verifyCma", "verifyCpa"], `Apply journal entry ${entry.entryId} actions`)
    for (const action of Object.values(entry.actions)) {
      if (action.state !== "succeeded" || typeof action.status !== "number" || action.status < 200 || action.status > 299) {
        throw new Error(`Apply journal entry ${entry.entryId} is not fully verified`)
      }
    }
  }
}

export async function verifyReviewGate(
  root: string,
  project: ProjectProfile,
  activationInput: ReviewActivation,
  repositoryGate?: () => Promise<RepositoryGateResult>,
): Promise<VerifiedReview> {
  const activation = {
    baselineGenerationDigest: exactString(activationInput.baselineGenerationDigest, DIGEST, "Baseline generation digest"),
    changesetDigest: exactString(activationInput.changesetDigest, DIGEST, "Changeset digest"),
    gatsbyCommit: exactString(activationInput.gatsbyCommit, COMMIT, "Gatsby commit"),
    workflowCommit: exactString(activationInput.workflowCommit, COMMIT, "Workflow commit"),
  }
  const executionWorkflowCommit = activationInput.executionWorkflowCommit === undefined
    ? activation.workflowCommit
    : exactString(activationInput.executionWorkflowCommit, COMMIT, "Execution workflow commit")
  // This must remain the first operation which can inspect either repository.
  const repository = await (repositoryGate ? repositoryGate() : assertRepositoryState(root, executionWorkflowCommit, activation.gatsbyCommit, project.gatsbyRepositoryPath))
  if (repository.workflowCommit !== executionWorkflowCommit || repository.gatsbyCommit !== activation.gatsbyCommit) {
    throw new Error("Repository gate returned contradictory identities")
  }
  const derived = await deriveChangeset(root, project)
  if (derived.baselineGenerationDigest !== activation.baselineGenerationDigest || derived.changesetDigest !== activation.changesetDigest) {
    throw new Error("Current baseline/working delta does not match review activation")
  }
  const changes = parseChanges(derived)
  if (changes.length === 0) throw new Error("Review changeset is empty")
  const generation = await assertSynchronizedGeneration(root, project, false)
  const journal = await readJson<AttemptJournal>(attemptJournalPath(root))
  assertVerifiedJournal(journal, activation, changes, project)
  return { activation, changes, generation, journal, repository }
}

async function directRun(invocation: CommandInvocation): Promise<void> {
  await execFileAsync(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env, maxBuffer: 16 * 1024 * 1024 })
}

export function assertSupportedGatsbyNodeVersion(version: string): void {
  assertSupportedNodeVersion(version)
}

export function redactGatsbyDiagnostics(value: string, secrets: readonly string[]): string {
  let redacted = value
  for (const secret of secrets) if (secret.length > 0) redacted = redacted.replaceAll(secret, "[REDACTED]")
  return redacted
    .replace(/\*{3,}[0-9A-Za-z._~+/-]*/g, "[REDACTED]")
    .replace(/((?:["']?Authorization["']?\s*:\s*["']?Bearer\s+))[^"'\s,}]+/gi, "$1[REDACTED]")
    .replace(/(\b(?:accessToken|deliveryToken|previewAccessToken|refreshToken)\s*:\s*["'])[^"'\r\n]*(["'])/gi, "$1[REDACTED]$2")
    .replace(/(\b(?:CONTENTFUL_(?:ACCESS|DELIVERY|PREVIEW_ACCESS)_TOKEN|GATSBY_REFRESH_TOKEN)\b\s*[:=]\s*["']?)[^"'\s,}\r\n]+/gi, "$1[REDACTED]")
}

async function directRunRedacted(invocation: CommandInvocation, secrets: readonly string[]): Promise<void> {
  try {
    await directRun(invocation)
  } catch (error: unknown) {
    throw new Error(redactGatsbyDiagnostics(error instanceof Error ? error.message : String(error), secrets))
  }
}

function forwardRedacted(stream: Readable, destination: NodeJS.WriteStream, secrets: readonly string[]): void {
  let pending = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk: string) => {
    pending += chunk
    for (;;) {
      const boundary = pending.search(/[\r\n]/)
      if (boundary < 0) break
      destination.write(redactGatsbyDiagnostics(pending.slice(0, boundary + 1), secrets))
      pending = pending.slice(boundary + 1)
    }
  })
  stream.on("end", () => { if (pending) destination.write(redactGatsbyDiagnostics(pending, secrets)) })
}

function spawnRedactedGatsby(invocation: CommandInvocation, secrets: readonly string[]): ChildProcess {
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    stdio: ["inherit", "pipe", "pipe"],
  })
  if (child.stdout) forwardRedacted(child.stdout, process.stdout, secrets)
  if (child.stderr) forwardRedacted(child.stderr, process.stderr, secrets)
  return child
}

function credentialFreeInstallerEnvironment(siteRoot: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = path.join(siteRoot, ".review-home")
  return {
    COREPACK_HOME: path.join(home, "corepack"),
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    NPM_CONFIG_USERCONFIG: path.join(home, "npmrc"),
    PATH: source.PATH ?? "/usr/bin:/bin",
    TMPDIR: path.join(home, "tmp"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_CONFIG_HOME: path.join(home, "config"),
  }
}

async function rejectSymlinks(root: string, directory = root): Promise<void> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, item.name)
    const metadata = await lstat(target)
    if (metadata.isSymbolicLink()) throw new Error(`Disposable Gatsby export contains a symlink: ${path.relative(root, target)}`)
    if (metadata.isDirectory()) await rejectSymlinks(root, target)
  }
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

async function assertNoSymlinkAncestors(target: string): Promise<void> {
  const absolute = path.resolve(target)
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    try {
      const metadata = await lstat(current)
      if (metadata.isSymbolicLink()) throw new Error(`Disposable Gatsby path ancestor is a symlink: ${current}`)
      if (!metadata.isDirectory()) throw new Error(`Disposable Gatsby path ancestor is not a directory: ${current}`)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
  }
}

async function existingRealPath(target: string): Promise<string | undefined> {
  try {
    return await realpath(target)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function assertPinnedAllowedRoot(allowedRoot: string, pinnedAllowedRoot: string): Promise<void> {
  await assertNoSymlinkAncestors(allowedRoot)
  if (await realpath(allowedRoot) !== pinnedAllowedRoot) throw new Error("Allowed disposable Gatsby root no longer matches its pinned realpath")
}

async function assertDisposableRealPath(allowedRoot: string, pinnedAllowedRoot: string, candidate: string, gatsbyRoot: string, label: string): Promise<void> {
  const logicalAllowed = path.resolve(allowedRoot)
  const logicalCandidate = path.resolve(candidate)
  if (!pathIsWithin(logicalAllowed, logicalCandidate)) throw new Error(`${label} is outside the allowed disposable Gatsby root`)
  const realCandidate = await realpath(logicalCandidate)
  if (!pathIsWithin(pinnedAllowedRoot, realCandidate)) throw new Error(`${label} resolves outside the pinned disposable Gatsby root`)
  const logicalGatsby = path.resolve(gatsbyRoot)
  const realGatsby = await existingRealPath(logicalGatsby) ?? logicalGatsby
  if (pathIsWithin(realGatsby, realCandidate) || pathIsWithin(realCandidate, realGatsby)) {
    throw new Error(`${label} overlaps the source Gatsby tree`)
  }
}

async function assertRegularNonSymlink(target: string, label: string): Promise<void> {
  const metadata = await lstat(target)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
}

async function assertDirectoryNonSymlink(target: string, label: string): Promise<void> {
  const metadata = await lstat(target)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`)
}

export interface StartOptions {
  activation: StartActivation
  gatsbyRoot?: string
  exportTracked?: (gatsbyRoot: string, commit: string, siteRoot: string) => Promise<void>
  processEnv?: NodeJS.ProcessEnv
  project: ProjectProfile
  repositoryGate?: () => Promise<RepositoryGateResult>
  root: string
  runCommand?: RunCommand
  spawnGatsby?: (invocation: CommandInvocation) => ChildProcess
}

export interface StartedPreview { child: ChildProcess; siteRoot: string }

async function exportTracked(
  sourceGitRoot: string,
  sourceRoot: string,
  sourceSubtree: string | undefined,
  commit: string,
  siteRoot: string,
  pinnedAllowedRoot: string,
): Promise<void> {
  const allowedRoot = path.dirname(path.dirname(siteRoot))
  const archive = path.join(path.dirname(siteRoot), "gatsby-source.tar")
  await assertDisposableRealPath(allowedRoot, pinnedAllowedRoot, path.dirname(siteRoot), sourceRoot, "Disposable Gatsby runtime")
  if (await realpath(sourceRoot) !== sourceRoot || (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: sourceGitRoot })).stdout.trim() !== commit) {
    throw new Error("Gatsby source identity changed before archive")
  }
  const treeish = sourceSubtree ? `${commit}:${sourceSubtree}` : commit
  await execFileAsync("git", ["archive", "--format=tar", `--output=${archive}`, treeish], { cwd: sourceGitRoot })
  if (!(await lstat(archive)).isFile()) throw new Error("Disposable Gatsby archive is not a regular file")
  await assertDisposableRealPath(allowedRoot, pinnedAllowedRoot, archive, sourceRoot, "Disposable Gatsby archive")
  await execFileAsync("tar", ["-xf", archive, "-C", siteRoot], { cwd: siteRoot })
  await rm(archive, { force: true })
}

async function startGatsbyPreviewUnlocked(options: StartOptions): Promise<StartedPreview> {
  assertSupportedGatsbyNodeVersion(process.versions.node)
  const project = validateProjectProfile(options.project)
  const origin = projectReviewOrigin(project)
  const port = String(project.reviewPort)
  const env = options.processEnv ?? process.env
  const verified = await verifyReviewGate(options.root, project, options.activation, options.repositoryGate)
  const adapter = path.join(options.root, "scripts/lib/legacy-contentful-preview-cda.cjs")
  await assertRegularNonSymlink(adapter, "Profile-bound legacy Contentful preview CDA adapter")
  if (await realpath(adapter) !== path.resolve(adapter)) throw new Error("Profile-bound legacy Contentful preview CDA adapter resolves through a symlink")
  const adapterDigest = sha256Bytes(await readFile(adapter))
  const gatsbyRoot = options.gatsbyRoot ?? verified.repository.gatsbyRoot ?? path.resolve(options.root, project.gatsbyRepositoryPath)
  const sourceGitRoot = verified.repository.gatsbyGitRoot ?? gatsbyRoot
  const allowedRoot = path.join(options.root, ".tmp/contentful-workflow/gatsby-preview")
  const runRoot = path.join(allowedRoot, randomUUID())
  const siteRoot = path.join(runRoot, "site")
  await assertNoSymlinkAncestors(siteRoot)
  await mkdir(siteRoot, { recursive: true })
  const pinnedAllowedRoot = await realpath(allowedRoot)
  await assertPinnedAllowedRoot(allowedRoot, pinnedAllowedRoot)
  await assertDisposableRealPath(allowedRoot, pinnedAllowedRoot, runRoot, gatsbyRoot, "Disposable Gatsby runtime")
  await assertDisposableRealPath(allowedRoot, pinnedAllowedRoot, siteRoot, gatsbyRoot, "Disposable Gatsby site")
  if (options.exportTracked) await options.exportTracked(gatsbyRoot, verified.activation.gatsbyCommit, siteRoot)
  else await exportTracked(sourceGitRoot, gatsbyRoot, verified.repository.gatsbySubtree, verified.activation.gatsbyCommit, siteRoot, pinnedAllowedRoot)
  await assertPinnedAllowedRoot(allowedRoot, pinnedAllowedRoot)
  await assertDisposableRealPath(allowedRoot, pinnedAllowedRoot, siteRoot, gatsbyRoot, "Disposable Gatsby site")
  await rejectSymlinks(siteRoot)
  for (const required of ["package.json", "package-lock.json"]) {
    const metadata = await lstat(path.join(siteRoot, required))
    if (!metadata.isFile()) throw new Error(`Disposable export is missing tracked ${required}`)
  }
  const installerEnv = credentialFreeInstallerEnvironment(siteRoot, env)
  const generatedDirectories = [installerEnv.HOME, installerEnv.TMPDIR, installerEnv.XDG_CACHE_HOME, installerEnv.XDG_CONFIG_HOME, installerEnv.COREPACK_HOME] as string[]
  await Promise.all(generatedDirectories.map((directory) => mkdir(directory, { recursive: true })))
  await Promise.all(generatedDirectories.map((directory) => assertDisposableRealPath(allowedRoot, pinnedAllowedRoot, directory, gatsbyRoot, "Disposable Gatsby generated directory")))
  const run = options.runCommand ?? directRun
  await run({
    args: ["ci", "--ignore-scripts"],
    command: "npm",
    cwd: siteRoot,
    env: installerEnv,
  })
  await assertPinnedAllowedRoot(allowedRoot, pinnedAllowedRoot)
  await assertNoSymlinkAncestors(siteRoot)
  await assertDisposableRealPath(allowedRoot, pinnedAllowedRoot, siteRoot, gatsbyRoot, "Disposable Gatsby site")
  await assertDirectoryNonSymlink(siteRoot, "Disposable Gatsby site")
  await Promise.all(generatedDirectories.map((directory) => assertDisposableRealPath(allowedRoot, pinnedAllowedRoot, directory, gatsbyRoot, "Disposable Gatsby generated directory")))
  await Promise.all(generatedDirectories.map((directory) => assertDirectoryNonSymlink(directory, "Disposable Gatsby generated directory")))
  await assertRegularNonSymlink(adapter, "Profile-bound legacy Contentful preview CDA adapter")
  if (await realpath(adapter) !== path.resolve(adapter) || sha256Bytes(await readFile(adapter)) !== adapterDigest) {
    throw new Error("Profile-bound legacy Contentful preview CDA adapter changed during disposable install")
  }
  const gatsbyCli = path.join(siteRoot, "node_modules/gatsby/cli.js")
  await assertDisposableRealPath(allowedRoot, pinnedAllowedRoot, gatsbyCli, gatsbyRoot, "Disposable Gatsby CLI")
  await assertRegularNonSymlink(gatsbyCli, "Disposable Gatsby CLI")
  // Credential resolution deliberately occurs only after the frozen installer succeeds.
  const cdaToken = validateCredentialInput(options.activation.cdaToken, options.activation.cdaAttestation, project)
  const refreshToken = typeof options.activation.refreshToken === "string" && options.activation.refreshToken.trim() !== ""
    ? options.activation.refreshToken
    : (() => { throw new Error("CONTENTFUL_AI_PREVIEW_GATSBY_REFRESH_TOKEN must be present and non-empty") })()
  const gatsbyEnv: NodeJS.ProcessEnv = {
    ...installerEnv,
    CONTENTFUL_ACCESS_TOKEN: "",
    CONTENTFUL_DELIVERY_TOKEN: cdaToken,
    CONTENTFUL_ENVIRONMENT: project.previewEnvironment,
    CONTENTFUL_HOST: DELIVERY_HOST,
    CONTENTFUL_PREVIEW_ACCESS_TOKEN: "",
    CONTENTFUL_SPACE_ID: project.spaceId,
    DEFAULT_LOCALE: project.defaultLocale,
    ENABLE_GATSBY_REFRESH_ENDPOINT: "true",
    GATSBY_CONTENT_PREVIEW_ONLY: "false",
    GATSBY_CONTENT_PREVIEW_URLS: "",
    GATSBY_REFRESH_TOKEN: refreshToken,
    GATSBY_TELEMETRY_DISABLED: "1",
    GOOGLE_TAG_MANAGER_ID: "",
    NODE_ENV: "development",
    NODE_OPTIONS: `--require=${adapter}`,
    SENTRY_AUTH_TOKEN: "",
    SENTRY_DSN: "",
    SENTRY_ENVIRONMENT: "",
    SENTRY_ORG: "",
    SENTRY_PROJECT: "",
    SENTRY_RELEASE: "",
    SITE_URL: "",
  }
  await assertDisposableRealPath(allowedRoot, pinnedAllowedRoot, gatsbyCli, gatsbyRoot, "Disposable Gatsby CLI")
  await assertRegularNonSymlink(gatsbyCli, "Disposable Gatsby CLI")
  const cleanInvocation = { args: [gatsbyCli, "clean"], command: process.execPath, cwd: siteRoot, env: gatsbyEnv }
  if (options.runCommand) await options.runCommand(cleanInvocation)
  else await directRunRedacted(cleanInvocation, [cdaToken, refreshToken])
  await assertPinnedAllowedRoot(allowedRoot, pinnedAllowedRoot)
  await assertNoSymlinkAncestors(siteRoot)
  await assertDisposableRealPath(allowedRoot, pinnedAllowedRoot, siteRoot, gatsbyRoot, "Disposable Gatsby site")
  await assertDirectoryNonSymlink(siteRoot, "Disposable Gatsby site")
  await assertDisposableRealPath(allowedRoot, pinnedAllowedRoot, gatsbyCli, gatsbyRoot, "Disposable Gatsby CLI")
  await assertRegularNonSymlink(gatsbyCli, "Disposable Gatsby CLI")
  await Promise.all(generatedDirectories.map((directory) => assertDisposableRealPath(allowedRoot, pinnedAllowedRoot, directory, gatsbyRoot, "Disposable Gatsby generated directory")))
  await Promise.all(generatedDirectories.map((directory) => assertDirectoryNonSymlink(directory, "Disposable Gatsby generated directory")))
  await assertRegularNonSymlink(adapter, "Profile-bound legacy Contentful preview CDA adapter")
  if (await realpath(adapter) !== path.resolve(adapter) || sha256Bytes(await readFile(adapter)) !== adapterDigest) {
    throw new Error("Profile-bound legacy Contentful preview CDA adapter changed during Gatsby clean")
  }
  const invocation = { args: [gatsbyCli, "develop", "--host", LOOPBACK_REVIEW_HOST, "--port", port], command: process.execPath, cwd: siteRoot, env: gatsbyEnv }
  const child = options.spawnGatsby ? options.spawnGatsby(invocation) : spawnRedactedGatsby(invocation, [cdaToken, refreshToken])
  if (!Number.isSafeInteger(child.pid) || (child.pid as number) <= 0) throw new Error("Disposable Gatsby process did not expose a valid pid")
  const sessionPath = path.join(runRoot, "session.json")
  await assertPinnedAllowedRoot(allowedRoot, pinnedAllowedRoot)
  await assertNoSymlinkAncestors(runRoot)
  await assertDisposableRealPath(allowedRoot, pinnedAllowedRoot, runRoot, gatsbyRoot, "Disposable Gatsby runtime")
  await writeFile(sessionPath, canonicalJson({ ...verified.activation, origin, pid: child.pid, profile: projectProfileBinding(project), schemaVersion: 2, siteRoot }), { flag: "wx" })
  await assertDisposableRealPath(allowedRoot, pinnedAllowedRoot, sessionPath, gatsbyRoot, "Disposable Gatsby session")
  return { child, siteRoot }
}

export async function startGatsbyPreview(options: StartOptions): Promise<StartedPreview> {
  return withPhaseLock(options.root, () => startGatsbyPreviewUnlocked(options))
}

export function reviewTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error("CONTENTFUL_AI_PREVIEW_GATSBY_REVIEW_TIMEOUT_MS must be raw positive ASCII integer milliseconds")
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value > MAX_TIMEOUT_MS) throw new Error("CONTENTFUL_AI_PREVIEW_GATSBY_REVIEW_TIMEOUT_MS exceeds 1800000")
  return value
}

export class ReviewDeadline {
  private readonly end: number
  constructor(durationMs: number, private readonly now: () => number = () => performance.now()) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("Review deadline duration must be positive")
    this.end = now() + durationMs
  }
  remaining(label: string): number {
    const remaining = this.end - this.now()
    if (remaining <= 0) throw new Error(`Gatsby review deadline exhausted during ${label}`)
    return remaining
  }
}

async function boundedFetch<T = Response>(
  fetchImpl: typeof fetch,
  deadline: ReviewDeadline,
  label: string,
  input: string,
  init: RequestInit = {},
  consume?: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deadline.remaining(label))
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error(`Gatsby review deadline exhausted during ${label}`)), { once: true })
  })
  try {
    const request = (async () => {
      const response = await fetchImpl(input, { ...init, redirect: "manual", signal: controller.signal })
      return consume ? consume(response) : response as T
    })()
    return await Promise.race([request, aborted])
  } catch (error: unknown) {
    if (controller.signal.aborted) throw new Error(`Gatsby review deadline exhausted during ${label}`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function sleepWithin(deadline: ReviewDeadline, milliseconds: number, sleep: (ms: number) => Promise<void>, label = "GraphQL convergence polling"): Promise<void> {
  const remaining = deadline.remaining(label)
  await sleep(Math.min(milliseconds, remaining))
  deadline.remaining(label)
}

interface LocaleDefinition { code: string; default: boolean; fallbackCode: string | null }

function localeDefinitions(resources: GenerationResources): LocaleDefinition[] {
  const locales: LocaleDefinition[] = []
  const seen = new Set<string>()
  for (const record of resources.locales.values()) {
    const code = record.code
    if (typeof code !== "string" || seen.has(code) || typeof record.default !== "boolean" || (record.fallbackCode !== null && typeof record.fallbackCode !== "string")) {
      throw new Error("Snapshot locale nodes are missing, ambiguous, or malformed")
    }
    seen.add(code)
    locales.push({ code, default: record.default, fallbackCode: record.fallbackCode as string | null })
  }
  if (locales.filter((locale) => locale.default).length !== 1) throw new Error("Snapshot must contain exactly one default locale")
  const byCode = new Map(locales.map((locale) => [locale.code, locale]))
  for (const locale of locales) {
    const visited = new Set<string>()
    let current: LocaleDefinition | undefined = locale
    while (current?.fallbackCode !== null) {
      if (visited.has(current.code)) throw new Error("Snapshot locale fallback cycle is not supported")
      visited.add(current.code)
      current = byCode.get(current.fallbackCode)
      if (!current) throw new Error("Snapshot locale fallback target is missing")
    }
  }
  return locales.sort((left, right) => bytewiseCompare(left.code, right.code))
}

function localized(fields: Record<string, unknown>, fieldId: string, locale: string, locales: LocaleDefinition[]): unknown {
  const values = fields[fieldId] === undefined ? {} : assertRecord(fields[fieldId], `Field ${fieldId}`)
  const byCode = new Map(locales.map((definition) => [definition.code, definition]))
  const visited = new Set<string>()
  let current: LocaleDefinition | undefined = byCode.get(locale)
  if (!current) throw new Error(`Unknown locale ${locale}`)
  while (current) {
    if (visited.has(current.code)) throw new Error("Locale fallback cycle is not supported")
    visited.add(current.code)
    if (Object.prototype.hasOwnProperty.call(values, current.code)) return values[current.code]
    current = current.fallbackCode === null ? undefined : byCode.get(current.fallbackCode)
  }
  return undefined
}

function rawResources(tree: Awaited<ReturnType<typeof assertSynchronizedGeneration>>["baseline"]): GenerationResources {
  const complete = resourcesFromTree(tree)
  return { assets: complete.assets, contentTypes: complete.contentTypes, entries: complete.entries, locales: complete.locales }
}

function validateRawPath(raw: unknown, origin: string): string {
  if (typeof raw !== "string" || raw.length === 0 || !raw.startsWith("/") || raw.startsWith("//") || /[?#\\\u0000-\u001f\u007f]/.test(raw) || /(?:^|\/)\.\.?\//.test(raw)) {
    throw new Error(`Gatsby returned a malformed raw page path: ${String(raw)}`)
  }
  const parsed = new URL(`${origin}${raw}`)
  if (parsed.origin !== origin || parsed.pathname !== raw || parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`Gatsby returned a raw page path that URL parsing would rewrite: ${raw}`)
  }
  return raw
}

interface SafeGraphQlError {
  code?: string
  locations?: Array<{ column: number; line: number }>
  message: string
  path?: Array<number | string>
}

function safeGraphQlErrors(rawErrors: unknown[]): SafeGraphQlError[] {
  return rawErrors.slice(0, 3).map((rawError) => {
    const error = rawError && typeof rawError === "object" && !Array.isArray(rawError) ? rawError as Record<string, unknown> : {}
    const safe: SafeGraphQlError = {
      message: typeof error.message === "string"
        ? redactGatsbyDiagnostics(error.message, []).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300)
        : "GraphQL error message is missing",
    }
    const extensions = error.extensions && typeof error.extensions === "object" && !Array.isArray(error.extensions)
      ? error.extensions as Record<string, unknown>
      : undefined
    if (typeof extensions?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(extensions.code)) safe.code = extensions.code
    if (Array.isArray(error.path) && error.path.length <= 16 && error.path.every((part) => (typeof part === "string" && /^[A-Za-z0-9_]{1,128}$/.test(part)) || (Number.isSafeInteger(part) && Number(part) >= 0))) {
      safe.path = error.path as Array<number | string>
    }
    if (Array.isArray(error.locations) && error.locations.length <= 8) {
      const locations = error.locations.flatMap((rawLocation) => {
        if (!rawLocation || typeof rawLocation !== "object" || Array.isArray(rawLocation)) return []
        const location = rawLocation as Record<string, unknown>
        return Number.isSafeInteger(location.line) && Number(location.line) > 0 && Number.isSafeInteger(location.column) && Number(location.column) > 0
          ? [{ column: Number(location.column), line: Number(location.line) }]
          : []
      })
      if (locations.length > 0) safe.locations = locations
    }
    return safe
  })
}

function graphQlBody(value: unknown, label: string): Record<string, unknown> {
  const record = assertRecord(value, label)
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    throw new Error(`${label} returned GraphQL errors: ${JSON.stringify(safeGraphQlErrors(record.errors))}`)
  }
  return assertRecord(record.data, `${label}.data`)
}

async function graphQl(fetchImpl: typeof fetch, deadline: ReviewDeadline, origin: string, query: string, label: string): Promise<Record<string, unknown>> {
  return boundedFetch(fetchImpl, deadline, label, `${origin}/___graphql`, { body: JSON.stringify({ query }), headers: { "content-type": "application/json" }, method: "POST" }, async (response) => {
    if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`)
    const body = await response.json()
    deadline.remaining(`${label} response body parsing`)
    return graphQlBody(body, label)
  })
}

const SCHEMA_QUERY = `query GatsbyReviewSchema { __schema { types { kind name fields { name type { kind name ofType { kind name ofType { kind name } } } } } } }`

type SchemaField = { name: string; type: { kind: string; name: string | null; ofType?: SchemaField["type"] | null } }
type SchemaType = { fields?: SchemaField[] | null; kind: string; name: string }

function namedType(type: SchemaField["type"]): { kind: string; name: string } {
  let current = type
  while (!current.name && current.ofType) current = current.ofType
  if (!current.name) throw new Error("GraphQL schema field has no named type")
  return { kind: current.kind, name: current.name }
}

function expectedGraphValue(value: unknown, type: { kind: string; name: string }, schema: Map<string, SchemaType>): unknown {
  if (value === null || value === undefined) return value ?? null
  if (type.kind === "SCALAR" || type.kind === "ENUM") return value
  const object = schema.get(type.name)
  const names = new Set(object?.fields?.map((field) => field.name) ?? [])
  if (names.has("contentful_id")) {
    const linkType = type.name === "ContentfulAsset" ? "Asset" : "Entry"
    if (Array.isArray(value)) return value.map((item, index) => ({ contentful_id: assertExactLink(item, linkType, `Linked value ${index}`) }))
    return { contentful_id: assertExactLink(value, linkType, "Linked value") }
  }
  if (names.has("raw")) return { raw: JSON.stringify(value) }
  throw new Error(`Changed GraphQL field type ${type.name} has no supported exact projection`)
}

function convergenceQuery(verified: VerifiedReview, resources: GenerationResources, schemaTypes: SchemaType[]): { expected: Record<string, unknown>; query: string } {
  const schema = new Map(schemaTypes.map((type) => [type.name, type]))
  const locales = localeDefinitions(resources)
  const selections: string[] = []
  const expected: Record<string, unknown> = {}
  for (const [entryIndex, change] of verified.changes.entries()) {
    const contentType = resources.contentTypes.get(change.contentType)
    if (!contentType || typeof contentType.name !== "string") throw new Error(`Content Type metadata is missing for ${change.contentType}`)
    const typeName = `Contentful${contentType.name.toLowerCase().replace(/(^|[^a-z0-9]+)([a-z0-9])/g, (_match, _prefix, character: string) => character.toUpperCase())}`
    const graphType = schema.get(typeName)
    const fields = new Map(graphType?.fields?.map((field) => [field.name, field]) ?? [])
    if (!fields.has("contentful_id") || !fields.has("node_locale")) throw new Error(`GraphQL schema is missing ${typeName}`)
    const entry = resources.entries.get(change.entryId)
    if (!entry) throw new Error(`Working entry is missing: ${change.entryId}`)
    const entryFieldValues = entryFields(entry, change.entryId)
    const fieldQueries: string[] = []
    for (const fieldChange of change.fields) {
      const graphField = fields.get(fieldChange.fieldId)
      if (!graphField) throw new Error(`GraphQL schema is missing changed field ${typeName}.${fieldChange.fieldId}`)
      const type = namedType(graphField.type)
      const nested = type.kind === "SCALAR" || type.kind === "ENUM" ? "" : schema.get(type.name)?.fields?.some((field) => field.name === "contentful_id") ? " { contentful_id }" : " { raw }"
      fieldQueries.push(`${fieldChange.fieldId}${nested}`)
    }
    const alias = `changed_${entryIndex}`
    selections.push(`${alias}: all${typeName}(filter: {contentful_id: {eq: ${JSON.stringify(change.entryId)}}}) { nodes { contentful_id node_locale ${fieldQueries.join(" ")} } }`)
    expected[alias] = locales.map((locale) => {
      const node: Record<string, unknown> = { contentful_id: change.entryId, node_locale: locale.code }
      for (const fieldChange of change.fields) {
        const graphField = fields.get(fieldChange.fieldId) as SchemaField
        node[fieldChange.fieldId] = expectedGraphValue(localized(entryFieldValues, fieldChange.fieldId, locale.code, locales), namedType(graphField.type), schema)
      }
      return node
    }).sort((left, right) => bytewiseCompare(String(left.node_locale), String(right.node_locale)))
  }
  return { expected, query: `query GatsbyReviewConvergence { ${selections.join(" ")} }` }
}

function normalizeConvergence(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([alias, raw]) => {
    const wrapper = assertRecord(raw, alias)
    if (!Array.isArray(wrapper.nodes)) throw new Error(`GraphQL convergence result ${alias} is malformed`)
    const nodes = wrapper.nodes.map((node) => assertRecord(node, alias)).sort((left, right) => bytewiseCompare(String(left.node_locale), String(right.node_locale)))
    return [alias, nodes]
  }))
}

export interface PreviewProcessIdentity {
  command: string
  cwd: string
  listener: { address: string; pid: number; port: number }
  pid: number
}

export interface PreviewProcessLineageRecord {
  command: string
  cwd: string
  pid: number
  ppid: number
}

export interface PreviewProcessInspection extends PreviewProcessIdentity {
  lineage: PreviewProcessLineageRecord[]
}

export type PreviewProcessInspector = (expected: PreviewProcessIdentity) => Promise<PreviewProcessInspection>

const MAX_GATSBY_PROCESS_LINEAGE = 16

async function inspectProcessRecord(pid: number): Promise<PreviewProcessLineageRecord> {
  const [processResult, cwdResult] = await Promise.all([
    execFileAsync("ps", ["-ww", "-p", String(pid), "-o", "ppid=", "-o", "command="], { maxBuffer: 1024 * 1024 }),
    execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { maxBuffer: 1024 * 1024 }),
  ])
  const processLines = processResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const cwdPaths = cwdResult.stdout.split(/\r?\n/).filter((line) => line.startsWith("n")).map((line) => line.slice(1))
  const processMatch = /^([0-9]+)\s+(.+)$/.exec(processLines[0] ?? "")
  if (processLines.length !== 1 || cwdPaths.length !== 1 || !processMatch) {
    throw new Error(`Authorized Gatsby process ${pid} inspection is ambiguous or malformed`)
  }
  const ppid = Number(processMatch[1])
  if (!Number.isSafeInteger(ppid) || ppid <= 0) throw new Error(`Authorized Gatsby process ${pid} parent pid is malformed`)
  return { command: processMatch[2] as string, cwd: cwdPaths[0] as string, pid, ppid }
}

function descendantScript(command: string, cwd: string, parentPid: number): string {
  const prefix = `${process.execPath} `
  if (!command.startsWith(prefix)) throw new Error("Authorized Gatsby descendant command is not the expected Node invocation")
  const script = command.slice(prefix.length)
  const basenameMatch = /^tmp-([1-9][0-9]*)-[0-9A-Za-z]{12}$/.exec(path.basename(script))
  if (
    script.includes(" ") ||
    path.dirname(script) !== path.join(cwd, ".cache") ||
    !basenameMatch ||
    Number(basenameMatch[1]) !== parentPid
  ) {
    throw new Error("Authorized Gatsby descendant command is not the expected disposable Gatsby lineage")
  }
  return script
}

export async function assertExpectedGatsbyDescendantScript(command: string, cwd: string, parentPid: number): Promise<void> {
  const script = descendantScript(command, cwd, parentPid)
  await assertNoSymlinkAncestors(path.dirname(script))
  try {
    await assertRegularNonSymlink(script, "Authorized Gatsby descendant script")
    if (await realpath(script) !== path.resolve(script)) throw new Error("Authorized Gatsby descendant script resolves through a symlink")
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
}

async function inspectPreviewProcess(expected: PreviewProcessIdentity): Promise<PreviewProcessInspection> {
  let listenerOutput: string
  try {
    listenerOutput = (await execFileAsync("lsof", ["-nP", `-iTCP:${expected.listener.port}`, "-sTCP:LISTEN", "-Fpn"], { maxBuffer: 1024 * 1024 })).stdout
  } catch (error: unknown) {
    throw new Error(`Authorized Gatsby preview process inspection is unavailable or stale: ${error instanceof Error ? error.message : String(error)}`)
  }
  const listenerPids = listenerOutput.split(/\r?\n/).filter((line) => line.startsWith("p")).map((line) => Number(line.slice(1)))
  const listeners = listenerOutput.split(/\r?\n/).filter((line) => line.startsWith("n")).map((line) => line.slice(1))
  if (listenerPids.length !== 1 || listeners.length !== 1 || !Number.isSafeInteger(listenerPids[0]) || (listenerPids[0] as number) <= 0) {
    throw new Error("Authorized Gatsby preview process inspection is ambiguous or malformed")
  }
  const listenerMatch = /^(127\.0\.0\.1):([1-9][0-9]{0,4})$/.exec(listeners[0] as string)
  if (!listenerMatch) throw new Error("Authorized Gatsby preview listener inspection is malformed")
  const lineage: PreviewProcessLineageRecord[] = []
  const visited = new Set<number>()
  let currentPid = listenerPids[0] as number
  try {
    while (lineage.length < MAX_GATSBY_PROCESS_LINEAGE) {
      if (visited.has(currentPid)) throw new Error("Authorized Gatsby process lineage contains a cycle")
      visited.add(currentPid)
      const record = await inspectProcessRecord(currentPid)
      lineage.push(record)
      if (currentPid === expected.pid) break
      currentPid = record.ppid
    }
  } catch (error: unknown) {
    throw new Error(`Authorized Gatsby preview process inspection is unavailable or stale: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parent = lineage.at(-1)
  if (!parent || parent.pid !== expected.pid) throw new Error("Authorized Gatsby listener is not a descendant of the recorded Gatsby process")
  for (const record of lineage.slice(0, -1)) {
    await assertExpectedGatsbyDescendantScript(record.command, expected.cwd, expected.pid)
  }
  return {
    command: parent.command,
    cwd: parent.cwd,
    lineage,
    listener: { address: listenerMatch[1] as string, pid: listenerPids[0] as number, port: Number(listenerMatch[2]) },
    pid: expected.pid,
  }
}

function assertPreviewProcessIdentity(actualInput: PreviewProcessInspection, expected: PreviewProcessIdentity): void {
  const actual = assertRecord(actualInput as unknown, "Gatsby preview process inspection")
  assertExactKeys(actual, ["command", "cwd", "lineage", "listener", "pid"], "Gatsby preview process inspection")
  const listener = assertRecord(actual.listener, "Gatsby preview listener inspection")
  assertExactKeys(listener, ["address", "pid", "port"], "Gatsby preview listener inspection")
  if (!Array.isArray(actual.lineage) || actual.lineage.length < 2 || actual.lineage.length > MAX_GATSBY_PROCESS_LINEAGE) {
    throw new Error("Authorized Gatsby preview process lineage is missing or malformed")
  }
  const lineage = actual.lineage.map((rawRecord, index) => {
    const record = assertRecord(rawRecord, `Gatsby preview process lineage ${index}`)
    assertExactKeys(record, ["command", "cwd", "pid", "ppid"], `Gatsby preview process lineage ${index}`)
    if (
      typeof record.command !== "string" || record.command.length === 0 ||
      typeof record.cwd !== "string" || record.cwd.length === 0 ||
      !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 ||
      !Number.isSafeInteger(record.ppid) || (record.ppid as number) <= 0
    ) throw new Error("Authorized Gatsby preview process lineage is malformed")
    return record as unknown as PreviewProcessLineageRecord
  })
  if (actual.pid !== expected.pid) throw new Error("Authorized Gatsby preview process pid does not match the session")
  if (actual.cwd !== expected.cwd) throw new Error("Authorized Gatsby preview process cwd does not match the disposable site")
  if (actual.command !== expected.command) throw new Error("Authorized Gatsby preview process command does not match the exact Gatsby invocation")
  if (listener.address !== expected.listener.address || listener.port !== expected.listener.port) {
    throw new Error("Authorized Gatsby preview listener does not match the fixed process-owned endpoint")
  }
  if (listener.pid !== lineage[0]?.pid || lineage.at(-1)?.pid !== expected.pid) {
    throw new Error("Authorized Gatsby preview listener lineage does not bind the fixed endpoint to the recorded process")
  }
  const seen = new Set<number>()
  for (const [index, record] of lineage.entries()) {
    if (seen.has(record.pid)) throw new Error("Authorized Gatsby preview process lineage contains a repeated pid")
    seen.add(record.pid)
    if (record.cwd !== expected.cwd) throw new Error("Authorized Gatsby preview process lineage cwd does not match the disposable site")
    if (index < lineage.length - 1) {
      descendantScript(record.command, expected.cwd, expected.pid)
      if (record.ppid !== lineage[index + 1]?.pid) throw new Error("Authorized Gatsby preview process lineage is not contiguous")
    }
  }
  const parent = lineage.at(-1) as PreviewProcessLineageRecord
  if (parent.command !== expected.command || actual.command !== parent.command || actual.cwd !== parent.cwd) {
    throw new Error("Authorized Gatsby preview process lineage does not end at the exact Gatsby invocation")
  }
}

async function requireAuthorizedPreviewSession(
  root: string,
  activation: VerifiedReview["activation"],
  project: ProjectProfile,
  inspectProcess: PreviewProcessInspector,
): Promise<void> {
  const allowedRoot = path.join(root, ".tmp/contentful-workflow/gatsby-preview")
  const gatsbyRoot = path.resolve(root, project.gatsbyRepositoryPath)
  const origin = projectReviewOrigin(project)
  const port = project.reviewPort
  await assertNoSymlinkAncestors(allowedRoot)
  const pinnedAllowedRoot = await existingRealPath(allowedRoot)
  if (!pinnedAllowedRoot) throw new Error("Authorized Gatsby preview session is missing")
  await assertPinnedAllowedRoot(allowedRoot, pinnedAllowedRoot)
  let runs: Dirent[]
  try {
    if (!(await lstat(allowedRoot)).isDirectory()) throw new Error("Authorized Gatsby preview session root is malformed")
    runs = await readdir(allowedRoot, { withFileTypes: true })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Authorized Gatsby preview session is missing")
    throw error
  }
  if (runs.length !== 1) throw new Error("Exactly one authorized Gatsby preview session is required")
  const run = runs[0]
  if (!run || !RUN_ID.test(run.name) || !run.isDirectory() || run.isSymbolicLink()) throw new Error("Authorized Gatsby preview session root is malformed")
  const runRoot = path.join(allowedRoot, run.name)
  const siteRoot = path.join(runRoot, "site")
  const sessionPath = path.join(runRoot, "session.json")
  await assertNoSymlinkAncestors(siteRoot)
  if (!(await lstat(siteRoot)).isDirectory()) throw new Error("Authorized Gatsby preview site is missing")
  const sessionMetadata = await lstat(sessionPath)
  if (!sessionMetadata.isFile() || sessionMetadata.isSymbolicLink()) throw new Error("Authorized Gatsby preview session is malformed")
  await assertDisposableRealPath(allowedRoot, pinnedAllowedRoot, runRoot, gatsbyRoot, "Authorized Gatsby preview runtime")
  await assertDisposableRealPath(allowedRoot, pinnedAllowedRoot, siteRoot, gatsbyRoot, "Authorized Gatsby preview site")
  await assertDisposableRealPath(allowedRoot, pinnedAllowedRoot, sessionPath, gatsbyRoot, "Authorized Gatsby preview session")
  const session = await readJson<Record<string, unknown>>(sessionPath)
  assertExactKeys(session, ["baselineGenerationDigest", "changesetDigest", "gatsbyCommit", "origin", "pid", "profile", "schemaVersion", "siteRoot", "workflowCommit"], "Gatsby preview session")
  assertProjectProfileBinding(session.profile, project)
  const identities = {
    baselineGenerationDigest: exactString(session.baselineGenerationDigest, DIGEST, "Session baseline generation digest"),
    changesetDigest: exactString(session.changesetDigest, DIGEST, "Session changeset digest"),
    gatsbyCommit: exactString(session.gatsbyCommit, COMMIT, "Session Gatsby commit"),
    workflowCommit: exactString(session.workflowCommit, COMMIT, "Session workflow commit"),
  }
  if (canonicalStringify(identities) !== canonicalStringify(activation)) throw new Error("Gatsby preview session identities do not match review activation")
  if (session.schemaVersion !== 2 || session.origin !== origin || session.siteRoot !== siteRoot) throw new Error("Gatsby preview session target is malformed or mismatched")
  if (!Number.isSafeInteger(session.pid) || (session.pid as number) <= 0) throw new Error("Gatsby preview session pid is malformed")
  const pid = session.pid as number
  const gatsbyCli = path.join(siteRoot, "node_modules/gatsby/cli.js")
  await assertDisposableRealPath(allowedRoot, pinnedAllowedRoot, gatsbyCli, gatsbyRoot, "Authorized Gatsby CLI")
  await assertRegularNonSymlink(gatsbyCli, "Authorized Gatsby CLI")
  const expected: PreviewProcessIdentity = {
    command: `${process.execPath} ${gatsbyCli} develop --host ${LOOPBACK_REVIEW_HOST} --port ${port}`,
    cwd: siteRoot,
    listener: { address: LOOPBACK_REVIEW_HOST, pid, port },
    pid,
  }
  let actual: PreviewProcessInspection
  try {
    actual = await inspectProcess(expected)
  } catch (error: unknown) {
    throw new Error(`Authorized Gatsby preview process inspection is unavailable or stale: ${error instanceof Error ? error.message : String(error)}`)
  }
  assertPreviewProcessIdentity(actual, expected)
}

export interface RefreshOptions {
  activation: ReviewActivation
  fetchImpl?: typeof fetch
  inspectProcess?: PreviewProcessInspector
  now?: () => number
  processEnv?: NodeJS.ProcessEnv
  project: ProjectProfile
  repositoryGate?: () => Promise<RepositoryGateResult>
  root: string
  sleep?: (milliseconds: number) => Promise<void>
  timeoutMs?: number
}

export interface RefreshResult { evidence: ReviewEvidence; requestedPaths: string[]; routeCount: number }

async function refreshGatsbyPreviewUnlocked(options: RefreshOptions): Promise<RefreshResult> {
  const project = validateProjectProfile(options.project)
  const origin = projectReviewOrigin(project)
  const env = options.processEnv ?? process.env
  const verified = await verifyReviewGate(options.root, project, options.activation, options.repositoryGate)
  await requireAuthorizedPreviewSession(options.root, verified.activation, project, options.inspectProcess ?? inspectPreviewProcess)
  const refreshToken = env.CONTENTFUL_AI_PREVIEW_GATSBY_REFRESH_TOKEN
  if (typeof refreshToken !== "string" || refreshToken.trim() === "") throw new Error("CONTENTFUL_AI_PREVIEW_GATSBY_REFRESH_TOKEN must be present and non-empty")
  const timeout = options.timeoutMs ?? reviewTimeoutMs(env.CONTENTFUL_AI_PREVIEW_GATSBY_REVIEW_TIMEOUT_MS)
  // The sole review deadline is created immediately before the refresh request.
  const deadline = new ReviewDeadline(timeout, options.now)
  const fetchImpl = options.fetchImpl ?? fetch
  const refresh = await boundedFetch(fetchImpl, deadline, "refresh", `${origin}/__refresh/gatsby-source-contentful`, { body: "{}", headers: { authorization: refreshToken, "content-type": "application/json" }, method: "POST" })
  if (!refresh.ok) throw new Error(`Gatsby refresh failed with HTTP ${refresh.status}`)
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const schemaData = await graphQl(fetchImpl, deadline, origin, SCHEMA_QUERY, "GraphQL schema inspection")
  const schemaWrapper = assertRecord(schemaData.__schema, "GraphQL schema")
  if (!Array.isArray(schemaWrapper.types)) throw new Error("GraphQL schema inspection is malformed")
  const workingResources = rawResources(verified.generation.working)
  const convergence = convergenceQuery(verified, workingResources, schemaWrapper.types as SchemaType[])
  while (true) {
    const data = normalizeConvergence(await graphQl(fetchImpl, deadline, origin, convergence.query, "GraphQL convergence"))
    if (canonicalStringify(data) === canonicalStringify(convergence.expected)) break
    await sleepWithin(deadline, 500, sleep)
  }
  const routesData = await graphQl(fetchImpl, deadline, origin, `query GatsbyReviewRoutes { allSitePage { totalCount nodes { path } } }`, "complete route enumeration")
  const allSitePage = assertRecord(routesData.allSitePage, "allSitePage")
  if (
    !Array.isArray(allSitePage.nodes) ||
    allSitePage.nodes.length === 0 ||
    !Number.isSafeInteger(allSitePage.totalCount) ||
    allSitePage.totalCount !== allSitePage.nodes.length
  ) throw new Error("Gatsby returned an empty, incomplete, or malformed route set")
  const rawPaths = allSitePage.nodes.map((node) => validateRawPath(assertRecord(node, "SitePage node").path, origin))
  const unique = new Set(rawPaths)
  if (unique.size !== rawPaths.length) throw new Error("Gatsby returned duplicate raw page paths")
  const paths = [...rawPaths].sort(bytewiseCompare)
  deadline.remaining("complete route health checks")
  for (const rawPath of paths) {
    deadline.remaining(`current route ${rawPath}`)
    const response = await boundedFetch(fetchImpl, deadline, `current route ${rawPath}`, `${origin}${rawPath}`)
    if (response.status !== 200) throw new Error(`Current route ${rawPath} returned HTTP ${response.status}`)
  }
  const evidence = await writeReviewEvidence(options.root, verified.activation, project, paths)
  return { evidence, requestedPaths: paths, routeCount: paths.length }
}

export async function refreshGatsbyPreview(options: RefreshOptions): Promise<RefreshResult> {
  return withPhaseLock(options.root, () => refreshGatsbyPreviewUnlocked(options))
}

export async function readProjectForPreview(root: string): Promise<ProjectProfile> {
  return validateProjectProfile(JSON.parse(await readFile(path.join(root, "config/project.json"), "utf8")))
}
