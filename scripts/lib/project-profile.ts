import path from "node:path"
import { assertSupportedNodeVersion } from "../check-runtime.mjs"
import { assertExactKeys, assertRecord, canonicalStringify, readJson, sha256Bytes } from "./core.js"
import type { ProjectProfile } from "./types.js"

export const CONTENTFUL_DELIVERY_HOST = "cdn.contentful.com"
export const CONTENTFUL_MANAGEMENT_HOST = "api.contentful.com"
export const CONTENTFUL_PREVIEW_HOST = "preview.contentful.com"
export const LOOPBACK_REVIEW_HOST = "127.0.0.1"

const PROFILE_PATH = "config/project.json"
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const SAFE_LOCALE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const PROFILE_KEYS = [
  "defaultLocale",
  "gatsbyRepositoryPath",
  "previewEnvironment",
  "productionAlias",
  "productionEnvironment",
  "reviewPort",
  "spaceId",
] as const

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} is malformed`)
  return value
}

export function validateProjectProfile(value: unknown): ProjectProfile {
  const profile = assertRecord(value, "Project profile")
  assertExactKeys(profile, [...PROFILE_KEYS], "Project profile")

  const spaceId = safeId(profile.spaceId, "Project profile spaceId")
  const previewEnvironment = safeId(profile.previewEnvironment, "Project profile previewEnvironment")
  const productionEnvironment = safeId(profile.productionEnvironment, "Project profile productionEnvironment")
  const productionAlias = safeId(profile.productionAlias, "Project profile productionAlias")
  if (new Set([previewEnvironment, productionEnvironment, productionAlias]).size !== 3) {
    throw new Error("Project profile preview, production, and alias targets must be distinct")
  }
  if (typeof profile.defaultLocale !== "string" || !SAFE_LOCALE.test(profile.defaultLocale)) {
    throw new Error("Project profile defaultLocale is malformed")
  }
  if (typeof profile.gatsbyRepositoryPath !== "string" || path.isAbsolute(profile.gatsbyRepositoryPath) || profile.gatsbyRepositoryPath.includes("\\") || path.posix.normalize(profile.gatsbyRepositoryPath) !== profile.gatsbyRepositoryPath) {
    throw new Error("Project profile gatsbyRepositoryPath must be one normalized relative POSIX path")
  }
  const gatsbyPathParts = profile.gatsbyRepositoryPath.split("/")
  if (
    gatsbyPathParts.some((part) => part === "" || part === "." || (part !== ".." && !SAFE_PATH_SEGMENT.test(part))) ||
    (gatsbyPathParts[0] === ".." && (gatsbyPathParts.length !== 2 || !SAFE_PATH_SEGMENT.test(gatsbyPathParts[1] as string))) ||
    (gatsbyPathParts[0] !== ".." && gatsbyPathParts.includes(".."))
  ) throw new Error("Project profile gatsbyRepositoryPath contains an unsafe segment")
  if (
    typeof profile.reviewPort !== "number" ||
    !Number.isInteger(profile.reviewPort) ||
    profile.reviewPort < 1 ||
    profile.reviewPort > 65_535
  ) {
    throw new Error("Project profile reviewPort must be an integer from 1 through 65535")
  }

  return {
    defaultLocale: profile.defaultLocale,
    gatsbyRepositoryPath: profile.gatsbyRepositoryPath,
    previewEnvironment,
    productionAlias,
    productionEnvironment,
    reviewPort: profile.reviewPort,
    spaceId,
  }
}

export async function loadProjectProfile(root: string): Promise<ProjectProfile> {
  assertSupportedNodeVersion()
  if (/\s/.test(path.resolve(root))) {
    throw new Error("Workflow repository path must not contain whitespace")
  }
  return validateProjectProfile(await readJson(path.join(root, PROFILE_PATH)))
}

export async function loadProjectProfileWithEnvironment(root: string): Promise<ProjectProfile> {
  await import("dotenv/config")
  return loadProjectProfile(root)
}

export function projectProfileDigest(value: unknown): string {
  return sha256Bytes(canonicalStringify(validateProjectProfile(value)))
}

export interface ProjectProfileBinding {
  digest: string
  value: ProjectProfile
}

export function projectProfileBinding(value: unknown): ProjectProfileBinding {
  const profile = validateProjectProfile(value)
  return { digest: projectProfileDigest(profile), value: profile }
}

export function assertProjectProfileBinding(value: unknown, expectedProfile: unknown): ProjectProfileBinding {
  const binding = assertRecord(value, "Project profile binding")
  assertExactKeys(binding, ["digest", "value"], "Project profile binding")
  const expected = projectProfileBinding(expectedProfile)
  const actual = projectProfileBinding(binding.value)
  if (binding.digest !== actual.digest || canonicalStringify(actual) !== canonicalStringify(expected)) {
    throw new Error("Project profile binding does not match the current exact profile")
  }
  return actual
}

export function projectReviewOrigin(profile: ProjectProfile): string {
  return `http://${LOOPBACK_REVIEW_HOST}:${profile.reviewPort}`
}
