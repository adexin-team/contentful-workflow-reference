import { createHash } from "node:crypto"
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const defaultRoot = path.resolve(import.meta.dirname, "..")
const manifestPath = ".public-reference-manifest.json"
const compare = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))
const canonical = (value) => `${JSON.stringify(value, (_key, item) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item
  return Object.fromEntries(Object.entries(item).sort(([left], [right]) => compare(left, right)))
}, 2)}\n`

function validPath(value) {
  return typeof value === "string" && value.length > 0 && !path.posix.isAbsolute(value) && !value.includes("\\") &&
    path.posix.normalize(value) === value && value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
}

async function entries(root, directory = root, prefix = "") {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolute = path.join(root, relative)
    const metadata = await lstat(absolute)
    if (relative === ".git") {
      if (metadata.isSymbolicLink()) throw new Error("Manifest verification rejects a symlinked .git entry")
      if (!metadata.isDirectory() && !metadata.isFile()) throw new Error("Manifest verification rejects malformed Git metadata")
      continue
    }
    if (metadata.isSymbolicLink()) throw new Error(`Manifest verification rejects symlink: ${relative}`)
    if (entry.isDirectory()) {
      if (entry.name === ".git") throw new Error(`Manifest verification rejects nested Git metadata: ${relative}`)
      result.push(relative, ...await entries(root, absolute, relative))
    } else if (entry.isFile()) result.push(relative)
    else throw new Error(`Manifest verification rejects non-regular entry: ${relative}`)
  }
  return result.sort(compare)
}

function directoriesFor(files) {
  const result = new Set()
  for (const file of files) {
    let current = path.posix.dirname(file)
    while (current !== ".") { result.add(current); current = path.posix.dirname(current) }
  }
  return [...result].sort(compare)
}

export async function verifyManifest(root = defaultRoot) {
  root = path.resolve(root)
  const rootMetadata = await lstat(root)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || await realpath(root) !== root) throw new Error("Candidate root must be one real directory")
  const bytes = await readFile(path.join(root, manifestPath)); let manifest
  try { manifest = JSON.parse(bytes.toString("utf8")) } catch { throw new Error("Manifest is malformed JSON") }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || manifest.schemaVersion !== 2 || !Array.isArray(manifest.files) ||
    Object.keys(manifest).sort(compare).join("\0") !== ["files", "schemaVersion"].sort(compare).join("\0")) throw new Error("Manifest schema is unsupported")
  const treeEntries = await entries(root)
  const seen = new Set(); const folded = new Set(); let previous
  const actual = []
  for (const raw of manifest.files) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort(compare).join("\0") !== ["path", "sha256", "size"].sort(compare).join("\0") ||
      !validPath(raw.path) || !/^[a-f0-9]{64}$/.test(raw.sha256) || !Number.isSafeInteger(raw.size) || raw.size < 0 ||
      seen.has(raw.path) || folded.has(raw.path.toLowerCase()) || (previous !== undefined && compare(previous, raw.path) >= 0)) throw new Error("Manifest contains a malformed, duplicate, case-colliding, or unsorted entry")
    seen.add(raw.path); folded.add(raw.path.toLowerCase()); previous = raw.path
    const absolute = path.join(root, raw.path); const metadata = await lstat(absolute)
    if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error(`Manifest path is not one regular file: ${raw.path}`)
    const content = await readFile(absolute)
    actual.push({ path: raw.path, sha256: createHash("sha256").update(content).digest("hex"), size: content.length })
  }
  const expectedFiles = actual.map((entry) => entry.path)
  const expectedDirectories = directoriesFor([...expectedFiles, manifestPath])
  const expectedEntries = [...expectedDirectories, ...expectedFiles, manifestPath].sort(compare)
  if (treeEntries.join("\0") !== expectedEntries.join("\0") || canonical({ files: actual, schemaVersion: 2 }) !== bytes.toString("utf8")) throw new Error("Manifest does not match the exact candidate tree")
  for (const relative of expectedDirectories) {
    const absolute = path.join(root, relative)
    const metadata = await lstat(absolute)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error(`Manifest directory shape changed: ${relative}`)
  }
  console.log(createHash("sha256").update(bytes).digest("hex"))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await verifyManifest()
