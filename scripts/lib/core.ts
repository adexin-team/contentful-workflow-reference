import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { ContentfulLink } from "./types.js"

const here = path.dirname(fileURLToPath(import.meta.url))
export const repoRoot: string = path.resolve(here, "../..")

export function bytewiseCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

export async function readJson<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => bytewiseCompare(left, right))
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return value
}

export function canonicalStringify(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value))
  if (serialized === undefined) throw new Error("Value is not JSON serializable")
  return serialized
}

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value), null, 2)
  if (serialized === undefined) throw new Error("Value is not JSON serializable")
  return `${serialized}\n`
}

export function sha256Bytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, canonicalJson(value))
}

export function assertSafeId(value: unknown, label = "ID"): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(`${label} contains unsupported characters: ${String(value)}`)
  }
  return value
}

export function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort(bytewiseCompare)
  const wanted = [...expected].sort(bytewiseCompare)
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`)
  }
}

export function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

export function assertExactLink(
  value: unknown,
  expectedLinkType: "Asset" | "ContentType" | "Entry" | "Environment" | "Space",
  label: string,
): string {
  const wrapper = assertRecord(value, label)
  assertExactKeys(wrapper, ["sys"], label)
  const sys = assertRecord(wrapper.sys, `${label}.sys`)
  assertExactKeys(sys, ["id", "linkType", "type"], `${label}.sys`)
  if (sys.type !== "Link" || sys.linkType !== expectedLinkType) {
    throw new Error(`${label} must be a Link to ${expectedLinkType}`)
  }
  return assertSafeId(sys.id, `${label} ID`)
}

export function extractLinks(value: unknown, found: ContentfulLink[] = []): ContentfulLink[] {
  if (Array.isArray(value)) {
    value.forEach((child) => extractLinks(child, found))
    return found
  }
  if (!value || typeof value !== "object") return found
  const record = value as Record<string, unknown>
  const sys = record.sys
  if (sys && typeof sys === "object" && !Array.isArray(sys)) {
    const link = sys as Record<string, unknown>
    if (link.type === "Link" && typeof link.id === "string" && typeof link.linkType === "string") {
      found.push({ id: link.id, linkType: link.linkType })
    }
  }
  Object.values(record).forEach((child) => extractLinks(child, found))
  return found
}

export function jsonKind(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value === "object" ? "object" : typeof value
}

export function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0
  return true
}
