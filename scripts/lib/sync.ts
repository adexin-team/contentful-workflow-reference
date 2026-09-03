import { mkdir, rmdir } from "node:fs/promises"
import path from "node:path"
import {
  assertRecord,
  assertSafeId,
  bytewiseCompare,
  isNodeError,
} from "./core.js"
import {
  deliveryApiRoot,
  validateCredentialInput,
} from "./credentials.js"
import { validateProjectProfile } from "./project-profile.js"
import {
  assertLocaleRecord,
  assertRepositoryGenerationBoundary,
  assertReturnedTargetIdentity,
  assertSynchronizedGeneration,
  installGeneration,
  LOCAL_BOOTSTRAP_SYNC_TOKEN,
  localGenerationIdentity,
  resourcesFromTree,
  workingMatchesBaselineBytes,
  type GenerationResources,
} from "./generation.js"
import type { ProjectProfile } from "./types.js"
import {
  entryContentType,
  referencedContentTypeIds,
  usedLocaleCodes,
  validateGenerationResources,
} from "./validation.js"

export interface SynchronizeOptions {
  allowReviewedWorkingReplacement?: boolean
  root: string
  project: ProjectProfile
  initial: boolean
  token: unknown
  attestation: unknown
  fetchImpl?: typeof fetch
  expectedLocalIdentity?: string
}

interface SyncResult {
  generationDigest: string
  counts: {
    entries: number
    assets: number
    contentTypes: number
    locales: number
  }
}

function sysRecord(resource: Record<string, unknown>, label: string): Record<string, unknown> {
  return assertRecord(resource.sys, `${label}.sys`)
}

function returnedResourceId(
  resource: Record<string, unknown>,
  expectedType: string,
  project: ProjectProfile,
): string {
  const sys = sysRecord(resource, expectedType)
  if (sys.type !== expectedType) throw new Error(`Unexpected Sync item type: ${String(sys.type)}`)
  const id = assertSafeId(sys.id, `${expectedType} ID`)
  assertReturnedTargetIdentity(resource, project, `${expectedType} ${id}`)
  return id
}

function tombstoneId(resource: Record<string, unknown>, expectedType: string): string {
  const sys = sysRecord(resource, expectedType)
  if (sys.type !== expectedType) throw new Error(`Unexpected Sync tombstone: ${String(sys.type)}`)
  return assertSafeId(sys.id, `${expectedType} ID`)
}

function continuationToken(rawUrl: unknown, apiRoot: string, label: string): string {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) throw new Error(`${label} is missing`)
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`${label} is malformed`)
  }
  const expected = new URL(`${apiRoot}/sync`)
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== expected.hostname ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== expected.pathname
  ) {
    throw new Error(`${label} leaves the configured preview Sync target`)
  }
  const tokenValues = parsed.searchParams.getAll("sync_token")
  const localeValues = parsed.searchParams.getAll("locale")
  const keys = [...parsed.searchParams.keys()]
  if (
    tokenValues.length !== 1 ||
    localeValues.length > 1 ||
    keys.length !== 1 + localeValues.length ||
    keys.some((key) => key !== "sync_token" && key !== "locale") ||
    (localeValues.length === 1 && localeValues[0] !== "*")
  ) {
    throw new Error(`${label} has unsupported query parameters`)
  }
  const token = tokenValues[0]
  if (!token) throw new Error(`${label} has an empty Sync token`)
  return token
}

async function acquireLock(root: string): Promise<() => Promise<void>> {
  const lock = path.join(root, ".tmp/contentful-workflow/sync.lock")
  await mkdir(path.dirname(lock), { recursive: true })
  try {
    await mkdir(lock)
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error("Another content:sync holds the repository-local lock")
    }
    throw error
  }
  return async () => {
    await rmdir(lock)
  }
}

function applySyncItems(
  resources: GenerationResources,
  items: unknown[],
  project: ProjectProfile,
): void {
  for (const item of items) {
    const resource = assertRecord(item, "Sync item")
    const sys = sysRecord(resource, "Sync item")
    if (sys.type === "Entry") {
      const id = returnedResourceId(resource, "Entry", project)
      entryContentType(resource, id)
      assertRecord(resource.fields, `Entry ${id}.fields`)
      resources.entries.set(id, resource)
    } else if (sys.type === "Asset") {
      const id = returnedResourceId(resource, "Asset", project)
      assertRecord(resource.fields, `Asset ${id}.fields`)
      resources.assets.set(id, resource)
    } else if (sys.type === "DeletedEntry") {
      resources.entries.delete(tombstoneId(resource, "DeletedEntry"))
    } else if (sys.type === "DeletedAsset") {
      resources.assets.delete(tombstoneId(resource, "DeletedAsset"))
    } else {
      throw new Error(`Unsupported Sync item type: ${String(sys.type)}`)
    }
  }
}

function fixedRequestUrl(
  rawUrl: string,
  apiRoot: string,
  expectedSuffix: string,
  expectedSearch = "",
): void {
  const parsed = new URL(rawUrl)
  const expected = new URL(`${apiRoot}/${expectedSuffix}${expectedSearch}`)
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== expected.hostname ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== expected.pathname ||
    parsed.search !== expected.search ||
    parsed.hash !== ""
  ) {
    throw new Error("Constructed request left the configured preview target")
  }
}

export async function synchronize(options: SynchronizeOptions): Promise<SyncResult> {
  const project = validateProjectProfile(options.project)
  const token = validateCredentialInput(options.token, options.attestation, project)
  const fetchImpl = options.fetchImpl ?? fetch
  const apiRoot = deliveryApiRoot(project)
  await assertRepositoryGenerationBoundary(options.root)
  const releaseLock = await acquireLock(options.root)
  try {
    const identityBeforeValidation = await localGenerationIdentity(options.root)
    if (
      options.expectedLocalIdentity !== undefined &&
      identityBeforeValidation !== options.expectedLocalIdentity
    ) {
      throw new Error("Local generation changed after its reviewed gate; refusing to sync")
    }
    let resources: GenerationResources
    let cursor: string | undefined
    if (options.initial) {
      if (!options.allowReviewedWorkingReplacement && (await workingMatchesBaselineBytes(options.root)) === false) {
        throw new Error("Refusing to sync because content/working has edits")
      }
      resources = { entries: new Map(), assets: new Map(), contentTypes: new Map(), locales: new Map() }
    } else {
      const current = await assertSynchronizedGeneration(options.root, project, false)
      if (current.syncToken === LOCAL_BOOTSTRAP_SYNC_TOKEN) {
        throw new Error("Bootstrap state has no live Contentful cursor; run content:sync -- --initial")
      }
      if (current.working.generationDigest !== current.generationDigest) {
        throw new Error("Refusing to sync because content/working has edits")
      }
      resources = resourcesFromTree(current.baseline)
      cursor = current.syncToken
    }
    const capturedLocalIdentity = await localGenerationIdentity(options.root)
    if (capturedLocalIdentity !== identityBeforeValidation) {
      throw new Error("Local generation changed while Sync validated it; refusing to fetch")
    }

    const headers = { Authorization: `Bearer ${token}` }
    const firstUrl = options.initial
      ? `${apiRoot}/sync?initial=true&locale=*`
      : `${apiRoot}/sync?sync_token=${encodeURIComponent(cursor as string)}`
    const seen = new Set<string>()
    let requestUrl = firstUrl
    let terminalToken: string | undefined
    for (let page = 0; page < 10_000; page += 1) {
      if (seen.has(requestUrl)) throw new Error("Sync continuation repeated")
      seen.add(requestUrl)
      const response = await fetchImpl(requestUrl, { headers, redirect: "error" })
      if (!response.ok) throw new Error(`Contentful Sync request failed with HTTP ${response.status}`)
      const payload = assertRecord(await response.json(), "Sync response")
      if (!Array.isArray(payload.items)) throw new Error("Sync response items are malformed")
      applySyncItems(resources, payload.items, project)
      const hasNextPage = payload.nextPageUrl !== undefined
      const hasNextSync = payload.nextSyncUrl !== undefined
      if (hasNextPage === hasNextSync) {
        throw new Error("Sync response must contain exactly one continuation")
      }
      if (hasNextPage) {
        continuationToken(payload.nextPageUrl, apiRoot, "nextPageUrl")
        requestUrl = payload.nextPageUrl as string
      } else {
        terminalToken = continuationToken(payload.nextSyncUrl, apiRoot, "nextSyncUrl")
        break
      }
    }
    if (!terminalToken) throw new Error("Sync pagination did not produce a terminal cursor")

    const requiredLocales = usedLocaleCodes(resources, project)
    const missingLocales = [...requiredLocales]
      .filter((locale) => !resources.locales.has(locale))
      .sort(bytewiseCompare)
    if (missingLocales.length > 0) {
      const returned = new Map<string, Record<string, unknown>>()
      const pageLimit = 1_000
      let expectedTotal: number | undefined
      let skip = 0
      for (let page = 0; page < 10_000; page += 1) {
        const expectedSearch = `?limit=${pageLimit}&skip=${skip}`
        const localesUrl = `${apiRoot}/locales${expectedSearch}`
        fixedRequestUrl(localesUrl, apiRoot, "locales", expectedSearch)
        const response = await fetchImpl(localesUrl, { headers, redirect: "error" })
        if (!response.ok) throw new Error(`Contentful locales request failed with HTTP ${response.status}`)
        const payload = assertRecord(await response.json(), "Locales response")
        if (!Array.isArray(payload.items)) throw new Error("Locales response items are malformed")
        if (
          !Number.isSafeInteger(payload.total) ||
          (payload.total as number) < 0 ||
          !Number.isSafeInteger(payload.skip) ||
          payload.skip !== skip ||
          !Number.isSafeInteger(payload.limit) ||
          (payload.limit as number) < 1 ||
          (payload.limit as number) > pageLimit
        ) {
          throw new Error("Locales response pagination is malformed")
        }
        const total = payload.total as number
        const limit = payload.limit as number
        if (expectedTotal !== undefined && total !== expectedTotal) {
          throw new Error("Locales response total changed during pagination")
        }
        expectedTotal = total
        if (
          skip > total ||
          payload.items.length > limit ||
          payload.items.length !== Math.min(limit, total - skip)
        ) {
          throw new Error("Locales response page size is inconsistent")
        }
        for (const item of payload.items) {
          const locale = assertRecord(item, "Locale record")
          const code = assertLocaleRecord(locale, "Locale record")
          if (returned.has(code)) throw new Error(`Locale was returned more than once: ${code}`)
          returned.set(code, locale)
        }
        if (skip + payload.items.length === total) break
        skip += limit
      }
      if (expectedTotal === undefined || returned.size !== expectedTotal) {
        throw new Error("Locales pagination did not return a complete collection")
      }
      for (const code of missingLocales) {
        if (!returned.has(code)) throw new Error(`Required locale was not returned: ${code}`)
      }
      const localesToPersist = options.initial
        ? [...returned.keys()].sort(bytewiseCompare)
        : missingLocales
      for (const code of localesToPersist) {
        resources.locales.set(code, returned.get(code) as Record<string, unknown>)
      }
    }

    const referencedTypes = referencedContentTypeIds(resources)
    for (const typeId of [...resources.contentTypes.keys()]) {
      if (!referencedTypes.has(typeId)) resources.contentTypes.delete(typeId)
    }
    const missingTypes = [...referencedTypes]
      .filter((typeId) => !resources.contentTypes.has(typeId))
      .sort(bytewiseCompare)
    for (const typeId of missingTypes) {
      const typeUrl = `${apiRoot}/content_types/${encodeURIComponent(typeId)}`
      fixedRequestUrl(typeUrl, apiRoot, `content_types/${typeId}`)
      const response = await fetchImpl(typeUrl, { headers, redirect: "error" })
      if (!response.ok) throw new Error(`Content Type request failed with HTTP ${response.status}`)
      const contentType = assertRecord(await response.json(), `Content Type ${typeId}`)
      const returnedId = returnedResourceId(contentType, "ContentType", project)
      if (returnedId !== typeId) throw new Error(`Content Type response ID mismatch: ${typeId}`)
      resources.contentTypes.set(typeId, contentType)
    }

    validateGenerationResources(resources, project)
    const generationDigest = await installGeneration(
      options.root,
      resources,
      terminalToken,
      project,
      capturedLocalIdentity,
    )
    return {
      generationDigest,
      counts: {
        entries: resources.entries.size,
        assets: resources.assets.size,
        contentTypes: resources.contentTypes.size,
        locales: resources.locales.size,
      },
    }
  } finally {
    await releaseLock()
  }
}
