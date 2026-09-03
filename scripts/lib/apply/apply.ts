import { readFile } from "node:fs/promises"
import path from "node:path"
import { deriveChangeset } from "../changeset.js"
import {
  assertRecord,
  assertSafeId,
  bytewiseCompare,
  canonicalStringify,
} from "../core.js"
import {
  assertLocaleRecord,
  assertReturnedTargetIdentity,
  assertSynchronizedGeneration,
  resourcesFromTree,
} from "../generation.js"
import { projectProfileBinding, validateProjectProfile } from "../project-profile.js"
import type { ProjectProfile } from "../types.js"
import { withPhaseLock } from "../phase-lock.js"
import {
  entryContentType,
  entryFields,
  validateChangedFieldValue,
  validateGenerationResources,
} from "../validation.js"
import {
  managementApiRoot,
  previewApiRoot,
  validateApplyCredential,
} from "./credentials.js"
import { assertRepositoryState, type RepositoryGateResult } from "./git.js"
import {
  assertNoExistingAttempt,
  journalPersistence,
  type ActionName,
  type AttemptJournal,
  type PersistJournal,
} from "./journal.js"

interface LocaleChange { after: unknown; before: unknown; locale: string }
interface FieldChange { fieldId: string; locales: LocaleChange[] }
interface EntryChange { contentType: string; entryId: string; fields: FieldChange[] }

export interface ApplyActivation {
  baselineGenerationDigest: unknown
  changesetDigest: unknown
  cmaAttestation: unknown
  cmaToken: unknown
  gatsbyCommit: unknown
  cpaAttestation: unknown
  cpaToken: unknown
  workflowCommit: unknown
}

export interface ApplyOptions {
  activation: ApplyActivation
  fetchImpl?: typeof fetch
  persistJournal?: PersistJournal
  project: ProjectProfile
  repositoryGate?: () => Promise<RepositoryGateResult>
  root: string
  skipExistingAttemptCheck?: boolean
}

export interface ApplyResult {
  changesetDigest: string
  entryIds: string[]
  journal: AttemptJournal
}

class ResponseFailure extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

class HttpFailure extends ResponseFailure {
  constructor(status: number, label: string) {
    super(status, `${label} failed with HTTP ${status}`)
  }
}

function validateResponse(
  result: { body: Record<string, unknown>; status: number },
  validation: () => void,
): void {
  try {
    validation()
  } catch (error: unknown) {
    throw new ResponseFailure(
      result.status,
      error instanceof Error ? error.message : "Contentful response validation failed",
    )
  }
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be an exact lowercase SHA-256 digest`)
  }
  return value
}

function parseChangeset(value: Record<string, unknown>): {
  baselineGenerationDigest: string
  changesetDigest: string
  entries: EntryChange[]
} {
  const baselineGenerationDigest = requireDigest(value.baselineGenerationDigest, "Changeset baseline generation digest")
  const changesetDigest = requireDigest(value.changesetDigest, "Changeset digest")
  if (!Array.isArray(value.entries)) throw new Error("Changeset entries are malformed")
  const entries = value.entries.map((rawEntry, entryIndex): EntryChange => {
    const record = assertRecord(rawEntry, `Changeset entry ${entryIndex}`)
    const entryId = assertSafeId(record.entryId, `Changeset entry ${entryIndex} ID`)
    const contentType = assertSafeId(record.contentType, `Changeset entry ${entryId} Content Type`)
    if (!Array.isArray(record.fields)) throw new Error(`Changeset entry ${entryId} fields are malformed`)
    const fields = record.fields.map((rawField, fieldIndex): FieldChange => {
      const field = assertRecord(rawField, `Changeset entry ${entryId} field ${fieldIndex}`)
      const fieldId = assertSafeId(field.fieldId, `Changeset entry ${entryId} field ID`)
      if (!Array.isArray(field.locales)) throw new Error(`Changeset entry ${entryId} field ${fieldId} locales are malformed`)
      const locales = field.locales.map((rawLocale, localeIndex): LocaleChange => {
        const locale = assertRecord(rawLocale, `Changeset entry ${entryId} locale ${localeIndex}`)
        return {
          after: locale.after,
          before: locale.before,
          locale: assertSafeId(locale.locale, `Changeset entry ${entryId} locale`),
        }
      })
      return { fieldId, locales }
    })
    return { contentType, entryId, fields }
  })
  const ordered = [...entries].sort((left, right) => bytewiseCompare(left.entryId, right.entryId))
  if (entries.some((entry, index) => entry.entryId !== ordered[index]?.entryId)) {
    throw new Error("Changeset entries are not in canonical order")
  }
  return { baselineGenerationDigest, changesetDigest, entries }
}

function version(sys: Record<string, unknown>, label: string): number {
  if (!Number.isSafeInteger(sys.version) || (sys.version as number) < 1) {
    throw new Error(`${label} has an invalid sys.version`)
  }
  return sys.version as number
}

function assertPublished(entry: Record<string, unknown>, label: string): number {
  const sys = assertRecord(entry.sys, `${label}.sys`)
  const currentVersion = version(sys, label)
  if (
    !Number.isSafeInteger(sys.publishedVersion) ||
    (sys.publishedVersion as number) < 1 ||
    currentVersion !== (sys.publishedVersion as number) + 1 ||
    sys.archivedVersion !== undefined
  ) {
    throw new Error(`${label} is not published without a newer draft`)
  }
  return currentVersion
}

function assertPreviewPublished(entry: Record<string, unknown>, label: string): void {
  const sys = assertRecord(entry.sys, `${label}.sys`)
  if (!Number.isSafeInteger(sys.publishedVersion) || (sys.publishedVersion as number) < 1) {
    throw new Error(`${label} does not prove published state through CPA`)
  }
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
  if (!response.ok) throw new HttpFailure(response.status, label)
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new ResponseFailure(response.status, `${label} returned malformed JSON`)
  }
  let body: Record<string, unknown>
  try {
    body = assertRecord(parsed, `${label} response`)
  } catch (error: unknown) {
    throw new ResponseFailure(response.status, error instanceof Error ? error.message : `${label} response is malformed`)
  }
  return { body, status: response.status }
}

function metadata(entry: Record<string, unknown>, label: string): Record<string, unknown> {
  return assertRecord(entry.metadata, `${label}.metadata`)
}

function mergeFields(liveFields: Record<string, unknown>, change: EntryChange): Record<string, unknown> {
  const merged = structuredClone(liveFields)
  for (const fieldChange of change.fields) {
    const localized = assertRecord(merged[fieldChange.fieldId], `Live field ${fieldChange.fieldId}`)
    for (const localeChange of fieldChange.locales) localized[localeChange.locale] = localeChange.after
  }
  return merged
}

function assertExpectedEntry(
  entry: Record<string, unknown>,
  expectedFields: Record<string, unknown>,
  expectedMetadata: Record<string, unknown> | undefined,
  project: ProjectProfile,
  label: string,
): void {
  assertReturnedTargetIdentity(entry, project, label)
  assertPublished(entry, label)
  if (canonicalStringify(entryFields(entry, label)) !== canonicalStringify(expectedFields)) {
    throw new Error(`${label} fields do not match the reviewed update`)
  }
  if (
    expectedMetadata !== undefined &&
    canonicalStringify(metadata(entry, label)) !== canonicalStringify(expectedMetadata)
  ) {
    throw new Error(`${label} metadata changed`)
  }
}

function newJournal(
  identities: AttemptJournal["identities"],
  project: ProjectProfile,
  entryIds: string[],
): AttemptJournal {
  const action = () => ({ state: "pending" as const, status: null, version: null })
  return {
    entries: entryIds.map((entryId) => ({
      actions: {
        publish: action(),
        update: action(),
        verifyCma: action(),
        verifyCpa: action(),
      },
      entryId,
    })),
    identities,
    profile: projectProfileBinding(project),
    schemaVersion: 2,
    status: "applying",
    target: { environmentId: project.previewEnvironment, spaceId: project.spaceId },
  }
}

async function performAction<T extends { status: number; body: Record<string, unknown> }>(
  journal: AttemptJournal,
  entryIndex: number,
  actionName: ActionName,
  persist: PersistJournal,
  operation: () => Promise<T>,
  resultVersion: (body: Record<string, unknown>) => number | null,
): Promise<T> {
  const action = journal.entries[entryIndex]?.actions[actionName]
  if (!action) throw new Error("Attempt journal action is missing")
  action.state = "in_flight"
  action.status = "unknown"
  action.version = null
  await persist(journal)
  let result: T
  try {
    result = await operation()
  } catch (error: unknown) {
    action.state = "failed"
    action.status = error instanceof ResponseFailure ? error.status : "unknown"
    journal.status = "failed"
    await persist(journal)
    throw error
  }
  action.state = "succeeded"
  action.status = result.status
  action.version = resultVersion(result.body)
  await persist(journal)
  return result
}

async function applyAiPreviewUnlocked(options: ApplyOptions): Promise<ApplyResult> {
  const { activation, project, root } = options
  const cmaToken = validateApplyCredential("CMA", activation.cmaToken, activation.cmaAttestation, project)
  const cpaToken = validateApplyCredential("CPA", activation.cpaToken, activation.cpaAttestation, project)
  const expectedBaselineDigest = requireDigest(activation.baselineGenerationDigest, "Authorized baseline generation digest")
  const expectedChangesetDigest = requireDigest(activation.changesetDigest, "Authorized changeset digest")
  const repository = await (options.repositoryGate
    ? options.repositoryGate()
    : assertRepositoryState(root, activation.workflowCommit, activation.gatsbyCommit, project.gatsbyRepositoryPath))
  if (!options.skipExistingAttemptCheck) await assertNoExistingAttempt(root)

  const derived = parseChangeset(await deriveChangeset(root, project))
  if (derived.baselineGenerationDigest !== expectedBaselineDigest) {
    throw new Error("Baseline generation digest does not match owner authorization")
  }
  if (derived.changesetDigest !== expectedChangesetDigest) {
    throw new Error("Changeset digest does not match owner authorization")
  }
  if (derived.entries.length === 0) throw new Error("Changeset contains no entry updates")

  const generation = await assertSynchronizedGeneration(root, project, false)
  const resources = resourcesFromTree(generation.baseline)
  const fetchImpl = options.fetchImpl ?? fetch
  const cmaRoot = managementApiRoot(project)
  const cpaRoot = previewApiRoot(project)
  const preflight = new Map<string, {
    fields: Record<string, unknown>
    metadata: Record<string, unknown>
    mergedFields: Record<string, unknown>
    version: number
  }>()

  for (const change of derived.entries) {
    const live = (await requestJson(fetchImpl, `${cmaRoot}/entries/${change.entryId}`, cmaToken, `CMA preflight entry ${change.entryId}`)).body
    assertReturnedTargetIdentity(live, project, `CMA preflight entry ${change.entryId}`)
    if (entryContentType(live, change.entryId) !== change.contentType) {
      throw new Error(`CMA preflight entry ${change.entryId} changed Content Type`)
    }
    const baseline = resources.entries.get(change.entryId)
    if (!baseline) throw new Error(`Baseline entry is missing: ${change.entryId}`)
    const liveFields = entryFields(live, change.entryId)
    if (canonicalStringify(liveFields) !== canonicalStringify(entryFields(baseline, change.entryId))) {
      throw new Error(`CMA preflight entry ${change.entryId} complete field body drifted from baseline`)
    }
    for (const fieldChange of change.fields) {
      const localized = assertRecord(liveFields[fieldChange.fieldId], `CMA preflight entry ${change.entryId} field ${fieldChange.fieldId}`)
      for (const localeChange of fieldChange.locales) {
        if (canonicalStringify(localized[localeChange.locale]) !== canonicalStringify(localeChange.before)) {
          throw new Error(`CMA preflight entry ${change.entryId} changed before-value drifted`)
        }
      }
    }
    preflight.set(change.entryId, {
      fields: liveFields,
      mergedFields: mergeFields(liveFields, change),
      metadata: structuredClone(metadata(live, `CMA preflight entry ${change.entryId}`)),
      version: assertPublished(live, `CMA preflight entry ${change.entryId}`),
    })
    resources.entries.set(change.entryId, live)
  }

  for (const typeId of [...new Set(derived.entries.map((entry) => entry.contentType))].sort(bytewiseCompare)) {
    const liveType = (await requestJson(fetchImpl, `${cmaRoot}/content_types/${typeId}`, cmaToken, `CMA Content Type ${typeId}`)).body
    assertReturnedTargetIdentity(liveType, project, `CMA Content Type ${typeId}`)
    resources.contentTypes.set(typeId, liveType)
  }
  const localePage = (await requestJson(fetchImpl, `${cmaRoot}/locales?limit=1000`, cmaToken, "CMA locales")).body
  if (!Array.isArray(localePage.items) || !Number.isSafeInteger(localePage.total) || (localePage.total as number) > localePage.items.length) {
    throw new Error("CMA locale response is incomplete or malformed")
  }
  const liveLocales = new Map<string, Record<string, unknown>>()
  for (const [index, value] of localePage.items.entries()) {
    const locale = assertRecord(value, `CMA locale ${index}`)
    assertReturnedTargetIdentity(locale, project, `CMA locale ${index}`)
    liveLocales.set(assertLocaleRecord(locale, `CMA locale ${index}`), locale)
  }
  resources.locales.clear()
  for (const [code, localeRecord] of liveLocales) resources.locales.set(code, localeRecord)
  for (const change of derived.entries) {
    const prepared = preflight.get(change.entryId) as NonNullable<ReturnType<typeof preflight.get>>
    for (const fieldChange of change.fields) {
      for (const localeChange of fieldChange.locales) {
        if (!liveLocales.has(localeChange.locale)) {
          throw new Error(`Changed locale is absent from live CMA locale data: ${localeChange.locale}`)
        }
        validateChangedFieldValue(
          resources,
          change.contentType,
          fieldChange.fieldId,
          localeChange.after,
          `Proposed entry ${change.entryId} field ${fieldChange.fieldId} locale ${localeChange.locale}`,
        )
      }
    }
    const baseline = resources.entries.get(change.entryId) as Record<string, unknown>
    resources.entries.set(change.entryId, { ...baseline, fields: prepared.mergedFields })
  }
  validateGenerationResources(resources, project)

  const journal = newJournal({
    baselineGenerationDigest: expectedBaselineDigest,
    changesetDigest: expectedChangesetDigest,
    gatsbyCommit: repository.gatsbyCommit,
    workflowCommit: repository.workflowCommit,
  }, project, derived.entries.map((entry) => entry.entryId))
  const persist = options.persistJournal ?? journalPersistence(root)
  await persist(journal)

  for (const [entryIndex, change] of derived.entries.entries()) {
    const prepared = preflight.get(change.entryId) as NonNullable<ReturnType<typeof preflight.get>>
    const entryUrl = `${cmaRoot}/entries/${change.entryId}`
    const update = await performAction(journal, entryIndex, "update", persist, async () => {
      const result = await requestJson(
        fetchImpl,
        entryUrl,
        cmaToken,
        `CMA update entry ${change.entryId}`,
        {
          body: canonicalStringify({ fields: prepared.mergedFields, metadata: prepared.metadata }),
          headers: {
            "Content-Type": "application/vnd.contentful.management.v1+json",
            "X-Contentful-Version": String(prepared.version),
          },
          method: "PUT",
        },
      )
      validateResponse(result, () => {
        assertReturnedTargetIdentity(result.body, project, `CMA update entry ${change.entryId}`)
        if (canonicalStringify(metadata(result.body, `CMA update entry ${change.entryId}`)) !== canonicalStringify(prepared.metadata)) {
          throw new Error(`CMA update entry ${change.entryId} metadata changed`)
        }
        if (canonicalStringify(entryFields(result.body, change.entryId)) !== canonicalStringify(prepared.mergedFields)) {
          throw new Error(`CMA update entry ${change.entryId} fields changed`)
        }
      })
      return result
    }, (body) => version(assertRecord(body.sys, `CMA update entry ${change.entryId}.sys`), `CMA update entry ${change.entryId}`))
    const updatedVersion = version(assertRecord(update.body.sys, `CMA update entry ${change.entryId}.sys`), `CMA update entry ${change.entryId}`)

    await performAction(journal, entryIndex, "publish", persist, async () => {
      const result = await requestJson(
        fetchImpl,
        `${entryUrl}/published`,
        cmaToken,
        `CMA publish entry ${change.entryId}`,
        { headers: { "X-Contentful-Version": String(updatedVersion) }, method: "PUT" },
      )
      validateResponse(result, () => {
        assertExpectedEntry(result.body, prepared.mergedFields, prepared.metadata, project, `CMA publish entry ${change.entryId}`)
      })
      return result
    }, (body) => version(assertRecord(body.sys, `CMA publish entry ${change.entryId}.sys`), `CMA publish entry ${change.entryId}`))

    await performAction(journal, entryIndex, "verifyCma", persist, async () => {
      const result = await requestJson(fetchImpl, entryUrl, cmaToken, `CMA verify entry ${change.entryId}`)
      validateResponse(result, () => {
        assertExpectedEntry(result.body, prepared.mergedFields, prepared.metadata, project, `CMA verify entry ${change.entryId}`)
      })
      return result
    }, (body) => version(assertRecord(body.sys, `CMA verify entry ${change.entryId}.sys`), `CMA verify entry ${change.entryId}`))

    await performAction(journal, entryIndex, "verifyCpa", persist, async () => {
      const result = await requestJson(fetchImpl, `${cpaRoot}/entries/${change.entryId}?locale=*`, cpaToken, `CPA verify entry ${change.entryId}`)
      validateResponse(result, () => {
        assertReturnedTargetIdentity(result.body, project, `CPA verify entry ${change.entryId}`)
        assertPreviewPublished(result.body, `CPA verify entry ${change.entryId}`)
        if (canonicalStringify(entryFields(result.body, change.entryId)) !== canonicalStringify(prepared.mergedFields)) {
          throw new Error(`CPA verify entry ${change.entryId} fields do not match the reviewed update`)
        }
      })
      return result
    }, () => null)
  }
  journal.status = "verified"
  await persist(journal)
  return { changesetDigest: expectedChangesetDigest, entryIds: derived.entries.map((entry) => entry.entryId), journal }
}

export async function applyAiPreview(options: ApplyOptions): Promise<ApplyResult> {
  return withPhaseLock(options.root, () => applyAiPreviewUnlocked(options))
}

export async function readProject(root: string): Promise<ProjectProfile> {
  return validateProjectProfile(JSON.parse(await readFile(path.join(root, "config/project.json"), "utf8")))
}
