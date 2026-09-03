import { randomUUID } from "node:crypto"
import { rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  assertRecord,
  assertSafeId,
  bytewiseCompare,
  canonicalJson,
  canonicalStringify,
  jsonKind,
  sha256Bytes,
} from "./core.js"
import {
  assertRepositoryGenerationBoundary,
  assertSynchronizedGeneration,
  resourcesFromTree,
} from "./generation.js"
import { projectProfileBinding } from "./project-profile.js"
import type { ProjectProfile } from "./types.js"
import { withPhaseLock } from "./phase-lock.js"
import {
  entryContentType,
  entryFields,
  validateChangedFieldValue,
  validateGenerationResources,
} from "./validation.js"

function assertSameKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  label: string,
): string[] {
  const beforeKeys = Object.keys(before).sort(bytewiseCompare)
  const afterKeys = Object.keys(after).sort(bytewiseCompare)
  if (
    beforeKeys.length !== afterKeys.length ||
    beforeKeys.some((key, index) => key !== afterKeys[index])
  ) {
    throw new Error(`${label} additions or deletions are not allowed`)
  }
  return beforeKeys
}

function entryWithoutFields(entry: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "fields"))
}

export async function deriveChangeset(root: string, project: ProjectProfile): Promise<Record<string, unknown>> {
  const generation = await assertSynchronizedGeneration(root, project, false)
  const baselinePaths = [...generation.baseline.files.keys()]
  const workingPaths = [...generation.working.files.keys()]
  if (
    baselinePaths.length !== workingPaths.length ||
    baselinePaths.some((relativePath, index) => relativePath !== workingPaths[index])
  ) {
    throw new Error("Resource additions or deletions are outside the workflow")
  }

  for (const relativePath of baselinePaths) {
    if (relativePath.startsWith("entries/")) continue
    const before = generation.baseline.files.get(relativePath) as { raw: string }
    const after = generation.working.files.get(relativePath) as { raw: string }
    if (before.raw !== after.raw) {
      throw new Error(`Assets, locales, and Content Type metadata are immutable: ${relativePath}`)
    }
  }

  const baseline = resourcesFromTree(generation.baseline)
  const working = resourcesFromTree(generation.working)
  for (const [entryId, beforeEntry] of baseline.entries) {
    const afterEntry = working.entries.get(entryId)
    if (!afterEntry) throw new Error(`Entry deletion is outside the workflow: ${entryId}`)
    assertSameKeys(
      entryFields(beforeEntry, entryId),
      entryFields(afterEntry, entryId),
      `Entry ${entryId} fields`,
    )
  }
  validateGenerationResources(working, project)
  const knownLocales = new Set(working.locales.keys())
  const entries: Array<Record<string, unknown>> = []

  for (const entryId of [...baseline.entries.keys()].sort(bytewiseCompare)) {
    const beforeEntry = baseline.entries.get(entryId) as Record<string, unknown>
    const afterEntry = working.entries.get(entryId)
    if (!afterEntry) throw new Error(`Entry deletion is outside the workflow: ${entryId}`)
    if (canonicalStringify(entryWithoutFields(beforeEntry)) !== canonicalStringify(entryWithoutFields(afterEntry))) {
      throw new Error(`Entry metadata or identity changed: ${entryId}`)
    }
    const beforeType = entryContentType(beforeEntry, entryId)
    const afterType = entryContentType(afterEntry, entryId)
    if (beforeType !== afterType) throw new Error(`Entry content type changed: ${entryId}`)
    const beforeFields = entryFields(beforeEntry, entryId)
    const afterFields = entryFields(afterEntry, entryId)
    const fieldChanges: Array<Record<string, unknown>> = []
    for (const fieldId of assertSameKeys(beforeFields, afterFields, `Entry ${entryId} fields`)) {
      assertSafeId(fieldId, `Entry ${entryId} field ID`)
      const beforeLocales = assertRecord(beforeFields[fieldId], `Entry ${entryId} field ${fieldId}`)
      const afterLocales = assertRecord(afterFields[fieldId], `Entry ${entryId} field ${fieldId}`)
      const localeChanges: Array<Record<string, unknown>> = []
      for (const locale of assertSameKeys(
        beforeLocales,
        afterLocales,
        `Entry ${entryId} field ${fieldId} locales`,
      )) {
        if (!knownLocales.has(locale)) {
          throw new Error(`Entry ${entryId} field ${fieldId} uses an unknown locale: ${locale}`)
        }
        const before = beforeLocales[locale]
        const after = afterLocales[locale]
        if (jsonKind(before) !== jsonKind(after)) {
          throw new Error(`Entry ${entryId} field ${fieldId} locale ${locale} changed JSON shape`)
        }
        if (canonicalStringify(before) !== canonicalStringify(after)) {
          validateChangedFieldValue(
            working,
            afterType,
            fieldId,
            after,
            `Entry ${entryId} field ${fieldId} locale ${locale}`,
          )
          localeChanges.push({ after, before, locale })
        }
      }
      if (localeChanges.length > 0) fieldChanges.push({ fieldId, locales: localeChanges })
    }
    if (fieldChanges.length > 0) {
      entries.push({ contentType: beforeType, entryId, fields: fieldChanges })
    }
  }
  for (const entryId of working.entries.keys()) {
    if (!baseline.entries.has(entryId)) throw new Error(`Entry addition is outside the workflow: ${entryId}`)
  }

  const withoutDigest = {
    baselineGenerationDigest: generation.generationDigest,
    entries,
    profile: projectProfileBinding(project),
    schemaVersion: 2,
    source: {
      environmentId: project.previewEnvironment,
      spaceId: project.spaceId,
    },
  }
  return {
    ...withoutDigest,
    changesetDigest: sha256Bytes(canonicalStringify(withoutDigest)),
  }
}

async function createChangesetUnlocked(root: string, project: ProjectProfile): Promise<Record<string, unknown>> {
  const changeset = await deriveChangeset(root, project)
  const repositoryRoot = path.resolve(root)
  const outputDirectory = path.join(repositoryRoot, ".tmp/contentful-workflow")
  const output = path.join(outputDirectory, "changeset.json")
  const temporary = path.join(outputDirectory, `.changeset-${randomUUID()}.tmp`)
  for (const target of [temporary, output]) {
    const relative = path.relative(repositoryRoot, target)
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error(`Changeset destination leaves the repository: ${target}`)
    }
  }
  await assertRepositoryGenerationBoundary(repositoryRoot)
  try {
    await writeFile(temporary, canonicalJson(changeset), { flag: "wx" })
    await rename(temporary, output)
  } finally {
    await rm(temporary, { force: true })
  }
  return changeset
}

export async function createChangeset(root: string, project: ProjectProfile): Promise<Record<string, unknown>> {
  return withPhaseLock(root, () => createChangesetUnlocked(root, project))
}
