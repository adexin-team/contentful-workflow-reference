import { createHash, randomUUID } from "node:crypto"
import type { Dirent } from "node:fs"
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import {
  assertExactKeys,
  assertExactLink,
  assertRecord,
  assertSafeId,
  bytewiseCompare,
  canonicalJson,
  isNodeError,
  readJson,
  writeJson,
} from "./core.js"
import {
  DELIVERY_HOST,
  validateProjectConfig,
} from "./credentials.js"
import { assertProjectProfileBinding, projectProfileBinding } from "./project-profile.js"
import type { ProjectProfile } from "./types.js"
import { entryContentType } from "./validation.js"

export interface GenerationResources {
  entries: Map<string, Record<string, unknown>>
  assets: Map<string, Record<string, unknown>>
  contentTypes: Map<string, Record<string, unknown>>
  locales: Map<string, Record<string, unknown>>
}

export interface CompleteTree {
  files: Map<string, { raw: string; value: Record<string, unknown> }>
  generationDigest: string
}

export interface SynchronizedGeneration {
  baseline: CompleteTree
  working: CompleteTree
  generationDigest: string
  syncToken: string
}

const TOP_LEVEL_DIRECTORIES = ["assets", "content-types", "entries", "locales"] as const
const STATE_FILES = ["baseline-manifest.json", "cursor.json", "working-manifest.json"] as const
export const LOCAL_BOOTSTRAP_SYNC_TOKEN = "local-bootstrap:initial-live-sync-required"

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

async function assertDirectory(pathname: string, label: string): Promise<void> {
  const metadata = await lstat(pathname)
  if (metadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${pathname}`)
  if (!metadata.isDirectory()) throw new Error(`${label} must be a directory: ${pathname}`)
}

export async function assertRepositoryGenerationBoundary(root: string): Promise<void> {
  const repositoryRoot = path.resolve(root)
  const filesystemRoot = path.parse(repositoryRoot).root
  let current = filesystemRoot
  await assertDirectory(current, "Repository ancestor")
  for (const segment of path.relative(filesystemRoot, repositoryRoot).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    await assertDirectory(current, current === repositoryRoot ? "Repository root" : "Repository ancestor")
  }

  const resolvedRoot = await realpath(repositoryRoot)
  if (resolvedRoot !== repositoryRoot) {
    throw new Error(`Repository root must resolve to itself: ${repositoryRoot}`)
  }
  const repositoryDevice = (await stat(repositoryRoot)).dev
  for (const target of [
    path.join(repositoryRoot, "content/baseline"),
    path.join(repositoryRoot, "content/working"),
    path.join(repositoryRoot, ".tmp/contentful-workflow/state"),
  ]) {
    if (!isWithin(repositoryRoot, target)) {
      throw new Error(`Generation destination leaves the repository: ${target}`)
    }
    current = repositoryRoot
    for (const segment of path.relative(repositoryRoot, target).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment)
      try {
        await assertDirectory(current, "Generation root or ancestor")
      } catch (error: unknown) {
        if (isNodeError(error) && error.code === "ENOENT") break
        throw error
      }
      const resolved = await realpath(current)
      if (!isWithin(resolvedRoot, resolved)) {
        throw new Error(`Generation destination resolves outside the repository: ${current}`)
      }
      if ((await stat(current)).dev !== repositoryDevice) {
        throw new Error(`Generation destination crosses a filesystem boundary: ${current}`)
      }
    }
  }
}

function sourceRecord(project: ProjectProfile): Record<string, unknown> {
  validateProjectConfig(project)
  return {
    environmentId: project.previewEnvironment,
    host: DELIVERY_HOST,
    spaceId: project.spaceId,
  }
}

function identityLinkId(value: unknown, expectedLinkType: "Space" | "Environment"): string | undefined {
  try {
    return assertExactLink(value, expectedLinkType, `${expectedLinkType} identity`)
  } catch {
    return undefined
  }
}

export function assertReturnedTargetIdentity(
  resource: Record<string, unknown>,
  project: ProjectProfile,
  label: string,
): void {
  validateProjectConfig(project)
  const sys = assertRecord(resource.sys, `${label}.sys`)
  if (
    identityLinkId(sys.space, "Space") !== project.spaceId ||
    identityLinkId(sys.environment, "Environment") !== project.previewEnvironment
  ) {
    throw new Error(`${label} is missing or has mismatched returned space/environment identity`)
  }
}

export function assertLocaleRecord(value: Record<string, unknown>, label: string): string {
  const code = assertSafeId(value.code, `${label} code`)
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new Error(`${label} has an invalid name`)
  }
  if (typeof value.default !== "boolean") throw new Error(`${label} has an invalid default flag`)
  if (value.fallbackCode !== null && typeof value.fallbackCode !== "string") {
    throw new Error(`${label} has an invalid fallbackCode`)
  }
  return code
}

function assertResourcePath(
  relativePath: string,
  value: Record<string, unknown>,
  project: ProjectProfile,
): void {
  const parts = relativePath.split("/")
  const filename = parts.at(-1)
  if (!filename?.endsWith(".json")) throw new Error(`Unsupported generation file: ${relativePath}`)
  const fileId = filename.slice(0, -5)
  assertSafeId(fileId, `Filename ID in ${relativePath}`)

  if (parts[0] === "locales" && parts.length === 2) {
    const code = assertLocaleRecord(value, `Locale ${relativePath}`)
    if (code !== fileId) throw new Error(`Locale code does not match path: ${relativePath}`)
    return
  }

  const sys = assertRecord(value.sys, `${relativePath}.sys`)
  if (sys.id !== fileId) throw new Error(`Resource ID does not match path: ${relativePath}`)
  if (parts[0] === "assets" && parts.length === 2 && sys.type === "Asset") {
    assertReturnedTargetIdentity(value, project, `Asset ${fileId}`)
    return
  }
  if (parts[0] === "content-types" && parts.length === 2 && sys.type === "ContentType") {
    assertReturnedTargetIdentity(value, project, `Content Type ${fileId}`)
    return
  }
  if (parts[0] === "entries" && parts.length === 3 && sys.type === "Entry") {
    const typeId = assertSafeId(parts[1], `Content type path in ${relativePath}`)
    const contentType = entryContentType(value, fileId)
    if (contentType !== typeId) throw new Error(`Entry content type does not match path: ${relativePath}`)
    if (!value.fields || typeof value.fields !== "object" || Array.isArray(value.fields)) {
      throw new Error(`Entry fields are malformed: ${relativePath}`)
    }
    assertReturnedTargetIdentity(value, project, `Entry ${fileId}`)
    return
  }
  throw new Error(`Unsupported generation file: ${relativePath}`)
}

async function directJsonFiles(directory: string, relativeDirectory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) {
      throw new Error(`Unsupported generation path: ${relativePath}`)
    }
    files.push(relativePath)
  }
  return files.sort(bytewiseCompare)
}

async function generationPaths(root: string): Promise<string[]> {
  let topLevel
  try {
    topLevel = await readdir(root, { withFileTypes: true })
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") throw new Error(`Generation tree is missing: ${root}`)
    throw error
  }
  const names = topLevel.map((entry) => entry.name).sort(bytewiseCompare)
  if (
    names.length !== TOP_LEVEL_DIRECTORIES.length ||
    names.some((name, index) => name !== [...TOP_LEVEL_DIRECTORIES].sort(bytewiseCompare)[index]) ||
    topLevel.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())
  ) {
    throw new Error(`Generation tree has missing, extra, or unsupported top-level paths: ${root}`)
  }

  const paths = [
    ...(await directJsonFiles(path.join(root, "assets"), "assets")),
    ...(await directJsonFiles(path.join(root, "content-types"), "content-types")),
    ...(await directJsonFiles(path.join(root, "locales"), "locales")),
  ]
  const entryTypes = await readdir(path.join(root, "entries"), { withFileTypes: true })
  for (const entryType of entryTypes.sort((left, right) => bytewiseCompare(left.name, right.name))) {
    assertSafeId(entryType.name, "Entry content type directory")
    if (!entryType.isDirectory() || entryType.isSymbolicLink()) {
      throw new Error(`Unsupported generation path: entries/${entryType.name}`)
    }
    const typePaths = await directJsonFiles(
      path.join(root, "entries", entryType.name),
      `entries/${entryType.name}`,
    )
    if (typePaths.length === 0) {
      throw new Error(`Unsupported empty Entry content type directory: entries/${entryType.name}`)
    }
    paths.push(...typePaths)
  }
  return paths.sort(bytewiseCompare)
}

function digestFiles(
  files: Map<string, { raw: string; value: Record<string, unknown> }>,
  project: ProjectProfile,
): string {
  const hash = createHash("sha256")
  hash.update(canonicalJson(sourceRecord(project)))
  for (const [relativePath, file] of files) {
    const pathBytes = Buffer.from(relativePath, "utf8")
    const rawBytes = Buffer.from(file.raw, "utf8")
    hash.update(String(pathBytes.length)).update("\0").update(pathBytes)
    hash.update(String(rawBytes.length)).update("\0").update(rawBytes)
  }
  return hash.digest("hex")
}

export async function assertCompleteTree(root: string, project: ProjectProfile): Promise<CompleteTree> {
  const paths = await generationPaths(root)
  const files = new Map<string, { raw: string; value: Record<string, unknown> }>()
  const entryIds = new Set<string>()
  for (const relativePath of paths) {
    const raw = await readFile(path.join(root, ...relativePath.split("/")), "utf8")
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`Generation JSON is malformed: ${relativePath}`)
    }
    const value = assertRecord(parsed, `Resource ${relativePath}`)
    if (raw !== canonicalJson(value)) throw new Error(`Generation JSON is not canonical: ${relativePath}`)
    assertResourcePath(relativePath, value, project)
    if (relativePath.startsWith("entries/")) {
      const entryId = (value.sys as Record<string, unknown>).id as string
      if (entryIds.has(entryId)) throw new Error(`Duplicate Entry ID in generation: ${entryId}`)
      entryIds.add(entryId)
    }
    files.set(relativePath, { raw, value })
  }
  return { files, generationDigest: digestFiles(files, project) }
}

async function rawTreeFiles(root: string): Promise<Map<string, string> | undefined> {
  const files = new Map<string, string>()
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => bytewiseCompare(left.name, right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolutePath = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in content trees: ${relativePath}`)
      if (entry.isDirectory()) await visit(absolutePath, relativePath)
      else if (entry.isFile()) files.set(relativePath, await readFile(absolutePath, "utf8"))
      else throw new Error(`Unsupported content-tree path: ${relativePath}`)
    }
  }
  try {
    await visit(root, "")
    return files
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined
    throw error
  }
}

export async function localGenerationIdentity(root: string): Promise<string> {
  await assertRepositoryGenerationBoundary(root)
  const hash = createHash("sha256")
  const roots = [
    ["baseline", path.join(root, "content/baseline")],
    ["working", path.join(root, "content/working")],
    ["state", path.join(root, ".tmp/contentful-workflow/state")],
  ] as const
  for (const [label, directory] of roots) {
    hash.update(label).update("\0")
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error
      hash.update("missing\0")
      continue
    }
    hash.update("present\0")

    async function visit(
      currentDirectory: string,
      relativeDirectory: string,
      children: Dirent[],
    ): Promise<void> {
      for (const entry of children.sort((left, right) => bytewiseCompare(left.name, right.name))) {
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name
        const absolutePath = path.join(currentDirectory, entry.name)
        const pathBytes = Buffer.from(relativePath, "utf8")
        hash.update(String(pathBytes.length)).update("\0").update(pathBytes)
        if (entry.isSymbolicLink()) {
          throw new Error(`Symbolic links are not allowed in local generation state: ${relativePath}`)
        }
        if (entry.isDirectory()) {
          hash.update("directory\0")
          await visit(
            absolutePath,
            relativePath,
            await readdir(absolutePath, { withFileTypes: true }),
          )
        } else if (entry.isFile()) {
          const rawBytes = await readFile(absolutePath)
          hash.update("file\0").update(String(rawBytes.length)).update("\0").update(rawBytes)
        } else {
          throw new Error(`Unsupported local generation state path: ${relativePath}`)
        }
      }
    }
    await visit(directory, "", entries)
  }
  return hash.digest("hex")
}

export async function workingMatchesBaselineBytes(root: string): Promise<boolean | undefined> {
  const [baseline, working] = await Promise.all([
    rawTreeFiles(path.join(root, "content/baseline")),
    rawTreeFiles(path.join(root, "content/working")),
  ])
  if (!baseline || !working) return undefined
  const baselinePaths = [...baseline.keys()]
  const workingPaths = [...working.keys()]
  return (
    baselinePaths.length === workingPaths.length &&
    baselinePaths.every(
      (relativePath, index) =>
        relativePath === workingPaths[index] && baseline.get(relativePath) === working.get(relativePath),
    )
  )
}

function assertSource(value: unknown, project: ProjectProfile, label: string): void {
  const source = assertRecord(value, `${label}.source`)
  assertExactKeys(source, ["host", "spaceId", "environmentId"], `${label}.source`)
  if (
    source.host !== DELIVERY_HOST ||
    source.spaceId !== project.spaceId ||
    source.environmentId !== project.previewEnvironment
  ) {
    throw new Error(`${label} targets the wrong generation source`)
  }
}

function assertManifest(
  value: unknown,
  project: ProjectProfile,
  kind: "baseline" | "working",
): { generationDigest: string; fileCount: number } {
  const manifest = assertRecord(value, `${kind} manifest`)
  assertExactKeys(
    manifest,
    ["schemaVersion", "kind", "source", "generationDigest", "fileCount", "profile"],
    `${kind} manifest`,
  )
  if (manifest.schemaVersion !== 2 || manifest.kind !== kind) throw new Error(`${kind} manifest is invalid`)
  assertProjectProfileBinding(manifest.profile, project)
  assertSource(manifest.source, project, `${kind} manifest`)
  if (typeof manifest.generationDigest !== "string" || !/^[a-f0-9]{64}$/.test(manifest.generationDigest)) {
    throw new Error(`${kind} manifest has an invalid generation digest`)
  }
  if (!Number.isSafeInteger(manifest.fileCount) || (manifest.fileCount as number) < 0) {
    throw new Error(`${kind} manifest has an invalid file count`)
  }
  return {
    generationDigest: manifest.generationDigest,
    fileCount: manifest.fileCount as number,
  }
}

function assertCursor(
  value: unknown,
  project: ProjectProfile,
): { generationDigest: string; syncToken: string } {
  const cursor = assertRecord(value, "cursor record")
  assertExactKeys(
    cursor,
    ["schemaVersion", "source", "generationDigest", "syncToken", "profile"],
    "cursor record",
  )
  if (cursor.schemaVersion !== 2) throw new Error("Cursor record is invalid")
  assertProjectProfileBinding(cursor.profile, project)
  assertSource(cursor.source, project, "cursor record")
  if (typeof cursor.generationDigest !== "string" || !/^[a-f0-9]{64}$/.test(cursor.generationDigest)) {
    throw new Error("Cursor record has an invalid generation digest")
  }
  if (typeof cursor.syncToken !== "string" || cursor.syncToken.length === 0) {
    throw new Error("Cursor record has an invalid Sync token")
  }
  return { generationDigest: cursor.generationDigest, syncToken: cursor.syncToken }
}

export async function assertSynchronizedGeneration(
  root: string,
  project: ProjectProfile,
  requireUneditedWorking: boolean,
): Promise<SynchronizedGeneration> {
  await assertRepositoryGenerationBoundary(root)
  const baselineRoot = path.join(root, "content/baseline")
  const workingRoot = path.join(root, "content/working")
  const stateRoot = path.join(root, ".tmp/contentful-workflow/state")
  const stateEntries = await readdir(stateRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") throw new Error("Sync state is missing; initial sync is required")
    throw error
  })
  const names = stateEntries.map((entry) => entry.name).sort(bytewiseCompare)
  if (
    names.length !== STATE_FILES.length ||
    names.some((name, index) => name !== [...STATE_FILES].sort(bytewiseCompare)[index]) ||
    stateEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) {
    throw new Error("Sync state is split, incomplete, or contains unsupported files; initial sync is required")
  }

  const [baseline, working, baselineValue, workingValue, cursorValue] = await Promise.all([
    assertCompleteTree(baselineRoot, project),
    assertCompleteTree(workingRoot, project),
    readJson(path.join(stateRoot, "baseline-manifest.json")),
    readJson(path.join(stateRoot, "working-manifest.json")),
    readJson(path.join(stateRoot, "cursor.json")),
  ])
  const baselineManifest = assertManifest(baselineValue, project, "baseline")
  const workingManifest = assertManifest(workingValue, project, "working")
  const cursor = assertCursor(cursorValue, project)
  const digest = baseline.generationDigest
  if (
    baselineManifest.generationDigest !== digest ||
    workingManifest.generationDigest !== digest ||
    cursor.generationDigest !== digest ||
    baselineManifest.fileCount !== baseline.files.size ||
    workingManifest.fileCount !== baseline.files.size
  ) {
    throw new Error("Generation state is missing or mismatched; initial sync is required")
  }
  if (requireUneditedWorking && working.generationDigest !== digest) {
    throw new Error("Refusing to sync because content/working has edits")
  }
  return { baseline, working, generationDigest: digest, syncToken: cursor.syncToken }
}

export function resourcesFromTree(tree: CompleteTree): GenerationResources {
  const resources: GenerationResources = {
    entries: new Map(),
    assets: new Map(),
    contentTypes: new Map(),
    locales: new Map(),
  }
  for (const [relativePath, file] of tree.files) {
    const parts = relativePath.split("/")
    const id = parts.at(-1)?.slice(0, -5) as string
    if (parts[0] === "entries") resources.entries.set(id, file.value)
    else if (parts[0] === "assets") resources.assets.set(id, file.value)
    else if (parts[0] === "content-types") resources.contentTypes.set(id, file.value)
    else if (parts[0] === "locales") resources.locales.set(id, file.value)
  }
  return resources
}

export async function bootstrapGenerationState(root: string, project: ProjectProfile): Promise<string> {
  await assertRepositoryGenerationBoundary(root)
  const stateRoot = path.join(root, ".tmp/contentful-workflow/state")
  try {
    await lstat(stateRoot)
    throw new Error("Sync state already exists; bootstrap refuses to replace it")
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error
  }
  const [baseline, working] = await Promise.all([
    assertCompleteTree(path.join(root, "content/baseline"), project),
    assertCompleteTree(path.join(root, "content/working"), project),
  ])
  const baselinePaths = [...baseline.files.keys()]
  const workingPaths = [...working.files.keys()]
  if (baselinePaths.length !== workingPaths.length || baselinePaths.some((value, index) => value !== workingPaths[index])) {
    throw new Error("Bootstrap requires baseline and working trees with identical resource paths")
  }
  const workflowRoot = path.join(root, ".tmp/contentful-workflow")
  const temporaryState = path.join(workflowRoot, `.bootstrap-state-${randomUUID()}`)
  const manifestBase = {
    fileCount: baseline.files.size,
    generationDigest: baseline.generationDigest,
    profile: projectProfileBinding(project),
    schemaVersion: 2,
    source: sourceRecord(project),
  }
  await mkdir(temporaryState, { recursive: true })
  try {
    await writeJson(path.join(temporaryState, "baseline-manifest.json"), { ...manifestBase, kind: "baseline" })
    await writeJson(path.join(temporaryState, "working-manifest.json"), { ...manifestBase, kind: "working" })
    await writeJson(path.join(temporaryState, "cursor.json"), {
      generationDigest: baseline.generationDigest,
      profile: projectProfileBinding(project),
      schemaVersion: 2,
      source: sourceRecord(project),
      syncToken: LOCAL_BOOTSTRAP_SYNC_TOKEN,
    })
    await rename(temporaryState, stateRoot)
  } finally {
    await rm(temporaryState, { recursive: true, force: true })
  }
  await assertSynchronizedGeneration(root, project, false)
  return baseline.generationDigest
}

async function writeResourceMap(
  directory: string,
  resources: Map<string, Record<string, unknown>>,
): Promise<void> {
  await mkdir(directory, { recursive: true })
  for (const [id, resource] of [...resources].sort(([left], [right]) => bytewiseCompare(left, right))) {
    assertSafeId(id)
    await writeJson(path.join(directory, `${id}.json`), resource)
  }
}

async function writeTree(root: string, resources: GenerationResources): Promise<void> {
  await mkdir(path.join(root, "entries"), { recursive: true })
  await writeResourceMap(path.join(root, "assets"), resources.assets)
  await writeResourceMap(path.join(root, "content-types"), resources.contentTypes)
  await writeResourceMap(path.join(root, "locales"), resources.locales)
  for (const [id, entry] of [...resources.entries].sort(([left], [right]) => bytewiseCompare(left, right))) {
    const typeId = entryContentType(entry, id)
    await writeJson(path.join(root, "entries", typeId, `${assertSafeId(id)}.json`), entry)
  }
}

export async function installGeneration(
  root: string,
  resources: GenerationResources,
  syncToken: string,
  project: ProjectProfile,
  expectedLocalIdentity?: string,
): Promise<string> {
  validateProjectConfig(project)
  await assertRepositoryGenerationBoundary(root)
  const workflowRoot = path.join(root, ".tmp/contentful-workflow")
  const temporary = path.join(workflowRoot, `generation-${randomUUID()}`)
  const temporaryBaseline = path.join(temporary, "baseline")
  const temporaryWorking = path.join(temporary, "working")
  const temporaryState = path.join(temporary, "state")
  await mkdir(temporary, { recursive: true })
  try {
    await writeTree(temporaryBaseline, resources)
    await cp(temporaryBaseline, temporaryWorking, { recursive: true })
    const [baseline, working] = await Promise.all([
      assertCompleteTree(temporaryBaseline, project),
      assertCompleteTree(temporaryWorking, project),
    ])
    if (baseline.generationDigest !== working.generationDigest) {
      throw new Error("Temporary baseline and working generations differ")
    }
    const generationDigest = baseline.generationDigest
    const manifestBase = {
      fileCount: baseline.files.size,
      generationDigest,
      profile: projectProfileBinding(project),
      schemaVersion: 2,
      source: sourceRecord(project),
    }
    await writeJson(path.join(temporaryState, "baseline-manifest.json"), {
      ...manifestBase,
      kind: "baseline",
    })
    await writeJson(path.join(temporaryState, "working-manifest.json"), {
      ...manifestBase,
      kind: "working",
    })
    await writeJson(path.join(temporaryState, "cursor.json"), {
      generationDigest,
      profile: projectProfileBinding(project),
      schemaVersion: 2,
      source: sourceRecord(project),
      syncToken,
    })

    const destinations = [
      [temporaryBaseline, path.join(root, "content/baseline")],
      [temporaryWorking, path.join(root, "content/working")],
      [temporaryState, path.join(workflowRoot, "state")],
    ] as const
    if (
      expectedLocalIdentity !== undefined &&
      (await localGenerationIdentity(root)) !== expectedLocalIdentity
    ) {
      throw new Error("Local generation changed during Sync; refusing to install fetched content")
    }
    await Promise.all(destinations.map(([, destination]) => mkdir(path.dirname(destination), { recursive: true })))
    await assertRepositoryGenerationBoundary(root)
    const repositoryDevice = (await stat(path.resolve(root))).dev
    for (const [source, destination] of destinations) {
      if (
        (await stat(source)).dev !== repositoryDevice ||
        (await stat(path.dirname(destination))).dev !== repositoryDevice
      ) {
        throw new Error(`Generation install crosses a filesystem boundary: ${destination}`)
      }
    }
    for (const [source, destination] of destinations) {
      await rm(destination, { recursive: true, force: true })
      await rename(source, destination)
    }
    await assertSynchronizedGeneration(root, project, true)
    return generationDigest
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
