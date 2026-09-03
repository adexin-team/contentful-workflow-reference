import { randomUUID } from "node:crypto"
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { deriveChangeset } from "./changeset.js"
import {
  assertExactKeys,
  assertExactLink,
  assertRecord,
  assertSafeId,
  bytewiseCompare,
  canonicalJson,
  canonicalStringify,
  isNodeError,
  readJson,
  sha256Bytes,
} from "./core.js"
import {
  assertLocaleRecord,
  resourcesFromTree,
  type GenerationResources,
} from "./generation.js"
import { verifyReviewGate, type ReviewActivation } from "./gatsby-preview.js"
import { readReviewEvidence } from "./review-evidence.js"
import { withPhaseLock } from "./phase-lock.js"
import { assertProjectProfileBinding, projectProfileBinding, validateProjectProfile } from "./project-profile.js"
import type { ProjectProfile } from "./types.js"
import {
  entryContentType,
  entryFields,
  validateChangedFieldValue,
  validateGenerationResources,
} from "./validation.js"

const MANAGEMENT_HOST = "api.contentful.com"
const DELIVERY_HOST = "cdn.contentful.com"
const DIGEST = /^[a-f0-9]{64}$/

interface ProductionActivation extends ReviewActivation {
  cdaAttestation: unknown
  cdaToken: unknown
  cmaAttestation: unknown
  cmaReadToken: unknown
  cmaWriteToken?: unknown
}

interface LocaleChange { after: unknown; before: unknown; locale: string }
interface FieldChange { fieldId: string; locales: LocaleChange[] }
interface EntryChange { contentType: string; entryId: string; fields: FieldChange[] }

interface CandidateEntry {
  contentType: string
  entryId: string
  expectedFieldsDigest: string
  expectedMetadataDigest: string
  expectedVersion: number
  mergedFieldsDigest: string
}

export interface PromotionCandidate {
  candidateDigest: string
  entries: CandidateEntry[]
  identities: {
    baselineGenerationDigest: string
    changesetDigest: string
    gatsbyCommit: string
    executionWorkflowCommit: string
    reviewEvidenceDigest: string
    workflowCommit: string
  }
  profile: ReturnType<typeof projectProfileBinding>
  schemaVersion: 2
  target: { aliasId: string; environmentId: string; spaceId: string }
}

type PromotionActionName = "publish" | "update" | "verifyCda" | "verifyCma"
type JournalAction = { state: "pending" | "in_flight" | "succeeded" | "failed"; status: number | "unknown" | null; version: number | null }

export interface PromotionJournal {
  alias: {
    after: JournalAction
    before: JournalAction
    expectedEnvironmentId: string
  }
  candidateDigest: string
  entries: Array<{ actions: Record<PromotionActionName, JournalAction>; entryId: string }>
  profile: ReturnType<typeof projectProfileBinding>
  schemaVersion: 2
  status: "promoting" | "failed" | "verified"
  target: { environmentId: string; spaceId: string }
}

interface PreparedEntry {
  change: EntryChange
  fields: Record<string, unknown>
  mergedFields: Record<string, unknown>
  metadata: Record<string, unknown>
  version: number
}

interface PreflightResult {
  candidate: PromotionCandidate
  prepared: Map<string, PreparedEntry>
  cdaToken: string
  cmaReadToken: string
}

export interface PromotionOptions {
  activation: ProductionActivation
  fetchImpl?: typeof fetch
  project: ProjectProfile
  repositoryGate?: () => Promise<{ gatsbyCommit: string; workflowCommit: string }>
  root: string
}

export interface ExecutePromotionOptions extends PromotionOptions {
  cdaVerificationTimeoutMs?: number
  confirmation: unknown
  now?: () => number
  persistJournal?: (journal: PromotionJournal) => Promise<void>
  skipExistingAttemptCheck?: boolean
  sleep?: (milliseconds: number) => Promise<void>
}

class ResponseFailure extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function managementRoot(project: ProjectProfile): string {
  return `https://${MANAGEMENT_HOST}/spaces/${project.spaceId}/environments/${project.productionEnvironment}`
}

function deliveryRoot(project: ProjectProfile): string {
  return `https://${DELIVERY_HOST}/spaces/${project.spaceId}/environments/${project.productionEnvironment}`
}

function validateCredential(
  service: "CDA" | "CMA",
  tokenInput: unknown,
  attestationInput: unknown,
  project: ProjectProfile,
  tokenName = `CONTENTFUL_PRODUCTION_${service}_TOKEN`,
): string {
  if (typeof tokenInput !== "string" || tokenInput.trim() === "") {
    throw new Error(`${tokenName} must be present and non-empty`)
  }
  let parsed: unknown = attestationInput
  if (typeof attestationInput === "string") {
    try { parsed = JSON.parse(attestationInput) } catch { throw new Error(`CONTENTFUL_PRODUCTION_${service}_ATTESTATION is malformed JSON`) }
  }
  const attestation = assertRecord(parsed, `Production ${service} credential attestation`)
  assertExactKeys(attestation, ["apiRoot", "environmentId", "host", "spaceId"], `Production ${service} credential attestation`)
  const host = service === "CMA" ? MANAGEMENT_HOST : DELIVERY_HOST
  const root = service === "CMA" ? managementRoot(project) : deliveryRoot(project)
  if (
    attestation.host !== host ||
    attestation.spaceId !== project.spaceId ||
    attestation.environmentId !== project.productionEnvironment ||
    attestation.apiRoot !== root
  ) {
    throw new Error(`Production ${service} credential attestation targets the wrong fixed environment`)
  }
  return tokenInput
}

function assertProductionIdentity(resource: Record<string, unknown>, project: ProjectProfile, label: string): void {
  const sys = assertRecord(resource.sys, `${label}.sys`)
  if (
    assertExactLink(sys.space, "Space", `${label}.sys.space`) !== project.spaceId ||
    assertExactLink(sys.environment, "Environment", `${label}.sys.environment`) !== project.productionEnvironment
  ) {
    throw new Error(`${label} returned the wrong production identity`)
  }
}

function assertProductionEntry(resource: Record<string, unknown>, project: ProjectProfile, entryId: string, label: string): void {
  assertProductionIdentity(resource, project, label)
  const sys = assertRecord(resource.sys, `${label}.sys`)
  if (sys.type !== "Entry" || sys.id !== entryId) throw new Error(`${label} returned the wrong Entry identity`)
}

function version(entry: Record<string, unknown>, label: string): number {
  const sys = assertRecord(entry.sys, `${label}.sys`)
  if (!Number.isSafeInteger(sys.version) || (sys.version as number) < 1) throw new Error(`${label} has an invalid version`)
  return sys.version as number
}

function assertPublished(entry: Record<string, unknown>, label: string): number {
  const current = version(entry, label)
  const sys = assertRecord(entry.sys, `${label}.sys`)
  if (
    !Number.isSafeInteger(sys.publishedVersion) ||
    (sys.publishedVersion as number) < 1 ||
    current !== (sys.publishedVersion as number) + 1 ||
    sys.archivedVersion !== undefined
  ) throw new Error(`${label} is not published without a newer draft`)
  return current
}

function metadata(entry: Record<string, unknown>, label: string): Record<string, unknown> {
  return assertRecord(entry.metadata, `${label}.metadata`)
}

function mergeFields(liveFields: Record<string, unknown>, change: EntryChange): Record<string, unknown> {
  const merged = structuredClone(liveFields)
  for (const fieldChange of change.fields) {
    const localized = assertRecord(merged[fieldChange.fieldId], `Production field ${fieldChange.fieldId}`)
    for (const localeChange of fieldChange.locales) localized[localeChange.locale] = localeChange.after
  }
  return merged
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  label: string,
  init: RequestInit = {},
): Promise<{ body: Record<string, unknown>; status: number }> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> | undefined),
    },
    redirect: "error",
  })
  if (!response.ok) throw new ResponseFailure(response.status, `${label} failed with HTTP ${response.status}`)
  try {
    return { body: assertRecord(await response.json(), `${label} response`), status: response.status }
  } catch (error: unknown) {
    if (error instanceof ResponseFailure) throw error
    throw new ResponseFailure(response.status, error instanceof Error ? error.message : `${label} returned malformed JSON`)
  }
}

async function assertAlias(
  fetchImpl: typeof fetch,
  project: ProjectProfile,
  token: string,
  label: string,
): Promise<{ body: Record<string, unknown>; status: number }> {
  const result = await requestJson(
    fetchImpl,
    `https://${MANAGEMENT_HOST}/spaces/${project.spaceId}/environment_aliases/${project.productionAlias}`,
    token,
    label,
  )
  const alias = result.body
  const sys = assertRecord(alias.sys, `${label}.sys`)
  if (sys.id !== project.productionAlias || sys.type !== "EnvironmentAlias") throw new Error(`${label} returned the wrong alias`)
  const environment = assertRecord(alias.environment, `${label}.environment`)
  if (assertExactLink(environment, "Environment", `${label}.environment`) !== project.productionEnvironment) {
    throw new Error(`Production alias no longer points to ${project.productionEnvironment}`)
  }
  return result
}

function parseChangeset(value: Record<string, unknown>): EntryChange[] {
  if (!Array.isArray(value.entries)) throw new Error("Changeset entries are malformed")
  return value.entries.map((rawEntry, entryIndex) => {
    const entry = assertRecord(rawEntry, `Changeset entry ${entryIndex}`)
    const entryId = assertSafeId(entry.entryId, `Changeset entry ${entryIndex} ID`)
    const contentType = assertSafeId(entry.contentType, `Changeset entry ${entryId} Content Type`)
    if (!Array.isArray(entry.fields)) throw new Error(`Changeset entry ${entryId} fields are malformed`)
    const fields = entry.fields.map((rawField, fieldIndex) => {
      const field = assertRecord(rawField, `Changeset entry ${entryId} field ${fieldIndex}`)
      const fieldId = assertSafeId(field.fieldId, `Changeset entry ${entryId} field ID`)
      if (!Array.isArray(field.locales)) throw new Error(`Changeset entry ${entryId} locales are malformed`)
      return {
        fieldId,
        locales: field.locales.map((rawLocale, localeIndex) => {
          const locale = assertRecord(rawLocale, `Changeset entry ${entryId} locale ${localeIndex}`)
          return { after: locale.after, before: locale.before, locale: assertSafeId(locale.locale, "Changed locale") }
        }),
      }
    })
    return { contentType, entryId, fields }
  })
}

function candidateWithDigest(candidate: Omit<PromotionCandidate, "candidateDigest">): PromotionCandidate {
  return { ...candidate, candidateDigest: sha256Bytes(canonicalStringify(candidate)) }
}

export function assertPromotionCandidate(value: unknown, project: ProjectProfile): PromotionCandidate {
  const candidate = assertRecord(value, "Promotion candidate")
  assertExactKeys(candidate, ["candidateDigest", "entries", "identities", "profile", "schemaVersion", "target"], "Promotion candidate")
  if (candidate.schemaVersion !== 2 || typeof candidate.candidateDigest !== "string" || !DIGEST.test(candidate.candidateDigest)) {
    throw new Error("Promotion candidate header is malformed")
  }
  assertProjectProfileBinding(candidate.profile, project)
  if (!Array.isArray(candidate.entries) || candidate.entries.length === 0) throw new Error("Promotion candidate entries are malformed")
  const entries = candidate.entries.map((rawEntry, index) => {
    const entry = assertRecord(rawEntry, `Promotion candidate entry ${index}`)
    assertExactKeys(entry, ["contentType", "entryId", "expectedFieldsDigest", "expectedMetadataDigest", "expectedVersion", "mergedFieldsDigest"], `Promotion candidate entry ${index}`)
    assertSafeId(entry.contentType, `Promotion candidate entry ${index} Content Type`)
    assertSafeId(entry.entryId, `Promotion candidate entry ${index} ID`)
    for (const key of ["expectedFieldsDigest", "expectedMetadataDigest", "mergedFieldsDigest"] as const) {
      if (typeof entry[key] !== "string" || !DIGEST.test(entry[key])) throw new Error(`Promotion candidate entry ${index} ${key} is malformed`)
    }
    if (!Number.isSafeInteger(entry.expectedVersion) || (entry.expectedVersion as number) < 1) throw new Error(`Promotion candidate entry ${index} version is malformed`)
    return entry
  })
  const ordered = [...entries].sort((left, right) => bytewiseCompare(String(left.entryId), String(right.entryId)))
  if (entries.some((entry, index) => entry.entryId !== ordered[index]?.entryId)) throw new Error("Promotion candidate entries are not in canonical order")
  const identities = assertRecord(candidate.identities, "Promotion candidate identities")
  assertExactKeys(identities, ["baselineGenerationDigest", "changesetDigest", "gatsbyCommit", "executionWorkflowCommit", "reviewEvidenceDigest", "workflowCommit"], "Promotion candidate identities")
  for (const key of ["baselineGenerationDigest", "changesetDigest", "reviewEvidenceDigest"] as const) {
    if (typeof identities[key] !== "string" || !DIGEST.test(identities[key])) throw new Error(`Promotion candidate ${key} is malformed`)
  }
  for (const key of ["gatsbyCommit", "executionWorkflowCommit", "workflowCommit"] as const) {
    if (typeof identities[key] !== "string" || !/^[a-f0-9]{40}$/.test(identities[key])) throw new Error(`Promotion candidate ${key} is malformed`)
  }
  const target = assertRecord(candidate.target, "Promotion candidate target")
  assertExactKeys(target, ["aliasId", "environmentId", "spaceId"], "Promotion candidate target")
  if (target.aliasId !== project.productionAlias || target.environmentId !== project.productionEnvironment || target.spaceId !== project.spaceId) {
    throw new Error("Promotion candidate target is wrong")
  }
  const withoutDigest = Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== "candidateDigest"))
  if (sha256Bytes(canonicalStringify(withoutDigest)) !== candidate.candidateDigest) throw new Error("Promotion candidate digest does not match its bytes")
  return candidate as unknown as PromotionCandidate
}

function assertSucceededAction(value: unknown, label: string, expectedVersion: number | null): void {
  const action = assertRecord(value, label)
  assertExactKeys(action, ["state", "status", "version"], label)
  if (action.state !== "succeeded" || typeof action.status !== "number" || action.status < 200 || action.status > 299) {
    throw new Error(`${label} is not verified`)
  }
  if (action.version !== expectedVersion) throw new Error(`${label} version does not match the exact candidate sequence`)
}

export function assertVerifiedPromotionJournal(
  value: unknown,
  candidate: PromotionCandidate,
  project: ProjectProfile,
): PromotionJournal {
  const journal = assertRecord(value, "Promotion journal")
  assertExactKeys(journal, ["alias", "candidateDigest", "entries", "profile", "schemaVersion", "status", "target"], "Promotion journal")
  assertProjectProfileBinding(journal.profile, project)
  const target = assertRecord(journal.target, "Promotion journal target")
  assertExactKeys(target, ["environmentId", "spaceId"], "Promotion journal target")
  if (
    journal.schemaVersion !== 2 ||
    journal.status !== "verified" ||
    journal.candidateDigest !== candidate.candidateDigest ||
    target.environmentId !== project.productionEnvironment ||
    target.spaceId !== candidate.target.spaceId
  ) throw new Error("Production promotion journal is not verified for the exact fixed candidate")
  const alias = assertRecord(journal.alias, "Promotion journal alias")
  assertExactKeys(alias, ["after", "before", "expectedEnvironmentId"], "Promotion journal alias")
  if (alias.expectedEnvironmentId !== project.productionEnvironment) throw new Error("Promotion journal alias target is wrong")
  assertSucceededAction(alias.before, "Promotion journal alias preflight", null)
  assertSucceededAction(alias.after, "Promotion journal alias postflight", null)
  if (!Array.isArray(journal.entries) || journal.entries.length !== candidate.entries.length) throw new Error("Promotion journal entries do not match the exact candidate")
  for (const [index, rawEntry] of journal.entries.entries()) {
    const entry = assertRecord(rawEntry, `Promotion journal entry ${index}`)
    assertExactKeys(entry, ["actions", "entryId"], `Promotion journal entry ${index}`)
    if (entry.entryId !== candidate.entries[index]?.entryId) throw new Error("Promotion journal entries do not match the exact candidate")
    const actions = assertRecord(entry.actions, `Promotion journal entry ${entry.entryId} actions`)
    assertExactKeys(actions, ["publish", "update", "verifyCda", "verifyCma"], `Promotion journal entry ${entry.entryId} actions`)
    const candidateEntry = candidate.entries[index] as CandidateEntry
    assertSucceededAction(actions.update, `Promotion journal entry ${entry.entryId} update`, candidateEntry.expectedVersion + 1)
    assertSucceededAction(actions.publish, `Promotion journal entry ${entry.entryId} publish`, candidateEntry.expectedVersion + 2)
    assertSucceededAction(actions.verifyCma, `Promotion journal entry ${entry.entryId} verifyCma`, candidateEntry.expectedVersion + 2)
    assertSucceededAction(actions.verifyCda, `Promotion journal entry ${entry.entryId} verifyCda`, null)
  }
  return journal as unknown as PromotionJournal
}

export async function readPromotionCandidate(root: string, project: ProjectProfile): Promise<PromotionCandidate> {
  return assertPromotionCandidate(await readJson(promotionCandidatePath(root)), project)
}

export function promotionCandidatePath(root: string): string {
  return path.join(root, ".tmp/contentful-workflow/promotion-candidate.json")
}

export function promotionJournalPath(root: string): string {
  return path.join(root, ".tmp/contentful-workflow/promotion-attempt.json")
}

async function atomicWrite(output: string, value: unknown, prefix: string): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true })
  const temporary = path.join(path.dirname(output), `.${prefix}-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, canonicalJson(value), { flag: "wx" })
    await rename(temporary, output)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function preflight(options: PromotionOptions): Promise<PreflightResult> {
  const { activation, project } = options
  const cmaReadToken = validateCredential("CMA", activation.cmaReadToken, activation.cmaAttestation, project, "CONTENTFUL_PRODUCTION_CMA_READ_TOKEN")
  const cdaToken = validateCredential("CDA", activation.cdaToken, activation.cdaAttestation, project)
  const verified = await verifyReviewGate(options.root, project, activation, options.repositoryGate)
  const review = await readReviewEvidence(options.root, options.project, verified.activation)
  const derived = await deriveChangeset(options.root, project)
  const changes = parseChangeset(derived)
  if (changes.length === 0) throw new Error("Reviewed changeset is empty")
  const fetchImpl = options.fetchImpl ?? fetch
  await assertAlias(fetchImpl, project, cmaReadToken, "Production alias preflight")

  const resources = resourcesFromTree(verified.generation.baseline)
  const prepared = new Map<string, PreparedEntry>()
  for (const change of changes) {
    const result = await requestJson(fetchImpl, `${managementRoot(project)}/entries/${change.entryId}`, cmaReadToken, `Production preflight entry ${change.entryId}`)
    const live = result.body
    assertProductionEntry(live, project, change.entryId, `Production preflight entry ${change.entryId}`)
    if (entryContentType(live, change.entryId) !== change.contentType) throw new Error(`Production entry ${change.entryId} changed Content Type`)
    const baseline = resources.entries.get(change.entryId)
    if (!baseline || canonicalStringify(entryFields(live, change.entryId)) !== canonicalStringify(entryFields(baseline, change.entryId))) {
      throw new Error(`Production entry ${change.entryId} complete field body drifted from the reviewed baseline`)
    }
    const delivered = (await requestJson(fetchImpl, `${deliveryRoot(project)}/entries/${change.entryId}?locale=*`, cdaToken, `Production CDA preflight entry ${change.entryId}`)).body
    assertProductionEntry(delivered, project, change.entryId, `Production CDA preflight entry ${change.entryId}`)
    if (
      entryContentType(delivered, change.entryId) !== change.contentType ||
      canonicalStringify(entryFields(delivered, change.entryId)) !== canonicalStringify(entryFields(baseline, change.entryId))
    ) throw new Error(`Production CDA entry ${change.entryId} drifted from the reviewed published baseline`)
    const liveFields = entryFields(live, change.entryId)
    for (const fieldChange of change.fields) {
      const localized = assertRecord(liveFields[fieldChange.fieldId], `Production entry ${change.entryId} field ${fieldChange.fieldId}`)
      for (const localeChange of fieldChange.locales) {
        if (canonicalStringify(localized[localeChange.locale]) !== canonicalStringify(localeChange.before)) {
          throw new Error(`Production entry ${change.entryId} changed before-value drifted`)
        }
      }
    }
    const mergedFields = mergeFields(liveFields, change)
    prepared.set(change.entryId, {
      change,
      fields: liveFields,
      mergedFields,
      metadata: structuredClone(metadata(live, `Production preflight entry ${change.entryId}`)),
      version: assertPublished(live, `Production preflight entry ${change.entryId}`),
    })
    resources.entries.set(change.entryId, { ...live, fields: mergedFields })
  }

  for (const typeId of [...new Set(changes.map((change) => change.contentType))].sort(bytewiseCompare)) {
    const type = (await requestJson(fetchImpl, `${managementRoot(project)}/content_types/${typeId}`, cmaReadToken, `Production Content Type ${typeId}`)).body
    assertProductionIdentity(type, project, `Production Content Type ${typeId}`)
    resources.contentTypes.set(typeId, type)
  }
  const localePage = (await requestJson(fetchImpl, `${managementRoot(project)}/locales?limit=1000`, cmaReadToken, "Production locales")).body
  if (!Array.isArray(localePage.items) || !Number.isSafeInteger(localePage.total) || localePage.total !== localePage.items.length) {
    throw new Error("Production locale response is incomplete or malformed")
  }
  const locales = new Map<string, Record<string, unknown>>()
  for (const [index, raw] of localePage.items.entries()) {
    const locale = assertRecord(raw, `Production locale ${index}`)
    assertProductionIdentity(locale, project, `Production locale ${index}`)
    locales.set(assertLocaleRecord(locale, `Production locale ${index}`), locale)
  }
  resources.locales.clear()
  for (const [code, locale] of locales) resources.locales.set(code, locale)
  for (const change of changes) {
    for (const fieldChange of change.fields) {
      for (const localeChange of fieldChange.locales) {
        if (!locales.has(localeChange.locale)) throw new Error(`Changed locale is absent from production: ${localeChange.locale}`)
        validateChangedFieldValue(resources, change.contentType, fieldChange.fieldId, localeChange.after, `Production proposed entry ${change.entryId}`)
      }
    }
  }
  validateGenerationResources(resources, project)

  const candidate = candidateWithDigest({
    entries: changes.map((change) => {
      const item = prepared.get(change.entryId) as PreparedEntry
      return {
        contentType: change.contentType,
        entryId: change.entryId,
        expectedFieldsDigest: sha256Bytes(canonicalStringify(item.fields)),
        expectedMetadataDigest: sha256Bytes(canonicalStringify(item.metadata)),
        expectedVersion: item.version,
        mergedFieldsDigest: sha256Bytes(canonicalStringify(item.mergedFields)),
      }
    }),
    identities: {
      ...verified.activation,
      executionWorkflowCommit: verified.repository.workflowCommit,
      reviewEvidenceDigest: sha256Bytes(canonicalStringify(review)),
    },
    profile: projectProfileBinding(project),
    schemaVersion: 2,
    target: { aliasId: project.productionAlias, environmentId: project.productionEnvironment, spaceId: project.spaceId },
  })
  return { candidate, prepared, cdaToken, cmaReadToken }
}

export async function prepareProductionPromotion(options: PromotionOptions): Promise<PromotionCandidate> {
  return withPhaseLock(options.root, async () => {
    await assertNoPromotionAttempt(options.root)
    const result = await preflight(options)
    await atomicWrite(promotionCandidatePath(options.root), result.candidate, "promotion-candidate")
    return result.candidate
  })
}

async function assertNoPromotionAttempt(root: string): Promise<void> {
  try { await lstat(promotionJournalPath(root)) } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return
    throw error
  }
  throw new Error("A production promotion attempt journal already exists; owner direction is required")
}

function journalPersistence(root: string): (journal: PromotionJournal) => Promise<void> {
  const output = promotionJournalPath(root)
  let created = false
  return async (journal) => {
    await mkdir(path.dirname(output), { recursive: true })
    const temporary = path.join(path.dirname(output), `.promotion-attempt-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, canonicalJson(journal), { flag: "wx" })
      if (created) await rename(temporary, output)
      else { await link(temporary, output); created = true }
    } finally { await rm(temporary, { force: true }) }
  }
}

async function performAction<T extends { body: Record<string, unknown>; status: number }>(
  journal: PromotionJournal,
  action: JournalAction,
  persist: (journal: PromotionJournal) => Promise<void>,
  operation: () => Promise<T>,
  resultVersion: (body: Record<string, unknown>) => number | null,
): Promise<T> {
  action.state = "in_flight"
  action.status = "unknown"
  action.version = null
  await persist(journal)
  try {
    const result = await operation()
    action.state = "succeeded"
    action.status = result.status
    action.version = resultVersion(result.body)
    await persist(journal)
    return result
  } catch (error: unknown) {
    action.state = "failed"
    action.status = error instanceof ResponseFailure ? error.status : "unknown"
    journal.status = "failed"
    await persist(journal)
    throw error
  }
}

function assertExpectedEntry(
  entry: Record<string, unknown>,
  entryId: string,
  expectedFields: Record<string, unknown>,
  expectedMetadata: Record<string, unknown> | undefined,
  project: ProjectProfile,
  label: string,
): void {
  assertProductionEntry(entry, project, entryId, label)
  assertPublished(entry, label)
  if (canonicalStringify(entryFields(entry, label)) !== canonicalStringify(expectedFields)) throw new Error(`${label} fields do not match the reviewed update`)
  if (expectedMetadata && canonicalStringify(metadata(entry, label)) !== canonicalStringify(expectedMetadata)) throw new Error(`${label} metadata changed`)
}

async function executeProductionPromotionUnlocked(options: ExecutePromotionOptions): Promise<PromotionJournal> {
  if (!options.skipExistingAttemptCheck) await assertNoPromotionAttempt(options.root)
  const stored = await readPromotionCandidate(options.root, options.project)
  const expectedConfirmation = `PROMOTE:${stored.candidateDigest}:TO:${options.project.productionEnvironment}`
  if (options.confirmation !== expectedConfirmation) {
    throw new Error(`Exact production confirmation is required: ${expectedConfirmation}`)
  }
  const live = await preflight(options)
  if (canonicalStringify(live.candidate) !== canonicalStringify(stored)) {
    throw new Error("Production candidate changed during whole-batch re-preflight; prepare and approve a new candidate")
  }
  const cmaWriteToken = validateCredential(
    "CMA",
    options.activation.cmaWriteToken,
    options.activation.cmaAttestation,
    options.project,
    "CONTENTFUL_PRODUCTION_CMA_WRITE_TOKEN",
  )
  if (cmaWriteToken === live.cmaReadToken) {
    throw new Error("Production CMA read and write credentials must be distinct")
  }
  const cdaVerificationTimeoutMs = options.cdaVerificationTimeoutMs ?? 30_000
  if (!Number.isSafeInteger(cdaVerificationTimeoutMs) || cdaVerificationTimeoutMs < 1 || cdaVerificationTimeoutMs > 120_000) {
    throw new Error("Production CDA verification timeout is malformed")
  }
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const action = (): JournalAction => ({ state: "pending", status: null, version: null })
  const journal: PromotionJournal = {
    alias: { after: action(), before: { state: "succeeded", status: 200, version: null }, expectedEnvironmentId: options.project.productionEnvironment },
    candidateDigest: stored.candidateDigest,
    entries: stored.entries.map(({ entryId }) => ({ actions: { publish: action(), update: action(), verifyCda: action(), verifyCma: action() }, entryId })),
    profile: projectProfileBinding(options.project),
    schemaVersion: 2,
    status: "promoting",
    target: { environmentId: options.project.productionEnvironment, spaceId: options.project.spaceId },
  }
  const persist = options.persistJournal ?? journalPersistence(options.root)
  await persist(journal)
  const fetchImpl = options.fetchImpl ?? fetch
  let promotionFailed = false
  let promotionFailure: unknown
  try {
    for (const [index, candidateEntry] of stored.entries.entries()) {
    const prepared = live.prepared.get(candidateEntry.entryId) as PreparedEntry
    const actions = journal.entries[index]?.actions
    if (!actions) throw new Error("Promotion journal entry is missing")
    const entryUrl = `${managementRoot(options.project)}/entries/${candidateEntry.entryId}`
    const updated = await performAction(journal, actions.update, persist, async () => {
      const result = await requestJson(
        fetchImpl,
        entryUrl,
        cmaWriteToken,
        `Production update entry ${candidateEntry.entryId}`,
        {
          body: canonicalStringify({ fields: prepared.mergedFields, metadata: prepared.metadata }),
          headers: { "Content-Type": "application/vnd.contentful.management.v1+json", "X-Contentful-Version": String(prepared.version) },
          method: "PUT",
        },
      )
      assertProductionEntry(result.body, options.project, candidateEntry.entryId, `Production update entry ${candidateEntry.entryId}`)
      if (
        sha256Bytes(canonicalStringify(entryFields(result.body, candidateEntry.entryId))) !== candidateEntry.mergedFieldsDigest ||
        sha256Bytes(canonicalStringify(metadata(result.body, candidateEntry.entryId))) !== candidateEntry.expectedMetadataDigest
      ) throw new Error(`Production update entry ${candidateEntry.entryId} returned unexpected fields or metadata`)
      if (version(result.body, `Production update entry ${candidateEntry.entryId}`) !== candidateEntry.expectedVersion + 1) throw new Error(`Production update entry ${candidateEntry.entryId} returned an unexpected version`)
      return result
    }, (body) => version(body, `Production update entry ${candidateEntry.entryId}`))
    const updatedVersion = version(updated.body, `Production update entry ${candidateEntry.entryId}`)
    await performAction(journal, actions.publish, persist, async () => {
      const result = await requestJson(fetchImpl, `${entryUrl}/published`, cmaWriteToken, `Production publish entry ${candidateEntry.entryId}`, { headers: { "X-Contentful-Version": String(updatedVersion) }, method: "PUT" })
      assertExpectedEntry(result.body, candidateEntry.entryId, prepared.mergedFields, prepared.metadata, options.project, `Production publish entry ${candidateEntry.entryId}`)
      if (version(result.body, `Production publish entry ${candidateEntry.entryId}`) !== candidateEntry.expectedVersion + 2) throw new Error(`Production publish entry ${candidateEntry.entryId} returned an unexpected version`)
      return result
    }, (body) => version(body, `Production publish entry ${candidateEntry.entryId}`))
    await performAction(journal, actions.verifyCma, persist, async () => {
      const result = await requestJson(fetchImpl, entryUrl, live.cmaReadToken, `Production CMA verify entry ${candidateEntry.entryId}`)
      assertExpectedEntry(result.body, candidateEntry.entryId, prepared.mergedFields, prepared.metadata, options.project, `Production CMA verify entry ${candidateEntry.entryId}`)
      if (version(result.body, `Production CMA verify entry ${candidateEntry.entryId}`) !== candidateEntry.expectedVersion + 2) throw new Error(`Production CMA verify entry ${candidateEntry.entryId} returned an unexpected version`)
      return result
    }, (body) => version(body, `Production CMA verify entry ${candidateEntry.entryId}`))
      await performAction(journal, actions.verifyCda, persist, async () => {
        const started = now()
        while (true) {
          const elapsedBeforeRequest = now() - started
          if (!Number.isFinite(elapsedBeforeRequest) || elapsedBeforeRequest < 0 || elapsedBeforeRequest >= cdaVerificationTimeoutMs) {
            throw new Error(`Production CDA verify entry ${candidateEntry.entryId} did not converge before its deadline`)
          }
          const abort = new AbortController()
          const abortTimer = setTimeout(() => abort.abort(), Math.max(1, cdaVerificationTimeoutMs - elapsedBeforeRequest))
          let result: Awaited<ReturnType<typeof requestJson>>
          try {
            const request = requestJson(
              fetchImpl,
              `${deliveryRoot(options.project)}/entries/${candidateEntry.entryId}?locale=*`,
              live.cdaToken,
              `Production CDA verify entry ${candidateEntry.entryId}`,
              { signal: abort.signal },
            )
            const deadline = new Promise<never>((_resolve, reject) => {
              abort.signal.addEventListener("abort", () => reject(new Error(`Production CDA verify entry ${candidateEntry.entryId} did not converge before its deadline`)), { once: true })
            })
            result = await Promise.race([request, deadline])
          } catch (error: unknown) {
            if (abort.signal.aborted) throw new Error(`Production CDA verify entry ${candidateEntry.entryId} did not converge before its deadline`)
            throw error
          } finally {
            clearTimeout(abortTimer)
          }
          assertProductionEntry(result.body, options.project, candidateEntry.entryId, `Production CDA verify entry ${candidateEntry.entryId}`)
          if (canonicalStringify(entryFields(result.body, candidateEntry.entryId)) === canonicalStringify(prepared.mergedFields)) return result
          const elapsed = now() - started
          if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= cdaVerificationTimeoutMs) {
            throw new Error(`Production CDA verify entry ${candidateEntry.entryId} did not converge before its deadline`)
          }
          await sleep(Math.min(500, cdaVerificationTimeoutMs - elapsed))
        }
      }, () => null)
    }
  } catch (error: unknown) {
    promotionFailed = true
    promotionFailure = error
    if (journal.status !== "failed") {
      journal.status = "failed"
      await persist(journal)
    }
  }
  try {
    await performAction(journal, journal.alias.after, persist, () => assertAlias(fetchImpl, options.project, live.cmaReadToken, "Production alias postflight"), () => null)
  } catch (error: unknown) {
    if (!promotionFailed) {
      promotionFailed = true
      promotionFailure = error
    }
  }
  if (promotionFailed) {
    throw promotionFailure
  }
  journal.status = "verified"
  await persist(journal)
  return journal
}

export async function executeProductionPromotion(options: ExecutePromotionOptions): Promise<PromotionJournal> {
  return withPhaseLock(options.root, () => executeProductionPromotionUnlocked(options))
}

export async function readProjectForPromotion(root: string): Promise<ProjectProfile> {
  return validateProjectProfile(JSON.parse(await readFile(path.join(root, "config/project.json"), "utf8")))
}
