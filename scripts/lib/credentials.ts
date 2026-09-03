import { assertExactKeys, assertRecord } from "./core.js"
import { CONTENTFUL_DELIVERY_HOST } from "./project-profile.js"
import type { ProjectConfig } from "./types.js"

export const DELIVERY_HOST = CONTENTFUL_DELIVERY_HOST

export function deliveryApiRoot(project: ProjectConfig): string {
  const validated = validateProjectConfig(project)
  return `https://${DELIVERY_HOST}/spaces/${validated.spaceId}/environments/${validated.previewEnvironment}`
}

export function validateProjectConfig(value: unknown): ProjectConfig {
  const project = assertRecord(value, "Project config")
  if (typeof project.spaceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(project.spaceId)) {
    throw new Error("Project config has an invalid spaceId")
  }
  if (typeof project.previewEnvironment !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(project.previewEnvironment)) {
    throw new Error("Project config has an invalid previewEnvironment")
  }
  if (typeof project.defaultLocale !== "string" || !/^[A-Za-z0-9._-]+$/.test(project.defaultLocale)) {
    throw new Error("Project config has an invalid defaultLocale")
  }
  return project as unknown as ProjectConfig
}

export function validateCredentialInput(
  tokenInput: unknown,
  attestationInput: unknown,
  project: ProjectConfig,
): string {
  const fixedProject = validateProjectConfig(project)
  if (typeof tokenInput !== "string" || tokenInput.trim() === "") {
    throw new Error("CONTENTFUL_AI_PREVIEW_CDA_TOKEN must be present and non-empty")
  }
  if (attestationInput === undefined || attestationInput === null || attestationInput === "") {
    throw new Error("CONTENTFUL_AI_PREVIEW_CDA_ATTESTATION is required")
  }

  let parsed: unknown = attestationInput
  if (typeof attestationInput === "string") {
    try {
      parsed = JSON.parse(attestationInput)
    } catch {
      throw new Error("CONTENTFUL_AI_PREVIEW_CDA_ATTESTATION is malformed JSON")
    }
  }
  const attestation = assertRecord(parsed, "Credential provenance attestation")
  assertExactKeys(
    attestation,
    ["host", "spaceId", "environmentId", "apiRoot"],
    "Credential provenance attestation",
  )
  for (const key of ["host", "spaceId", "environmentId", "apiRoot"] as const) {
    const value = attestation[key]
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Credential provenance attestation has malformed ${key}`)
    }
  }

  const claimedRoot = `https://${attestation.host as string}/spaces/${attestation.spaceId as string}/environments/${attestation.environmentId as string}`
  if (attestation.apiRoot !== claimedRoot) {
    throw new Error("Credential provenance attestation is contradictory")
  }
  if (
    attestation.host !== DELIVERY_HOST ||
    attestation.spaceId !== fixedProject.spaceId ||
    attestation.environmentId !== fixedProject.previewEnvironment ||
    attestation.apiRoot !== deliveryApiRoot(fixedProject)
  ) {
    throw new Error("Credential provenance attestation targets the wrong Contentful source")
  }
  return tokenInput
}
