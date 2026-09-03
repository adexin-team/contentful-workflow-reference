import { assertExactKeys, assertRecord } from "../core.js"
import { validateProjectConfig } from "../credentials.js"
import { CONTENTFUL_MANAGEMENT_HOST, CONTENTFUL_PREVIEW_HOST } from "../project-profile.js"
import type { ProjectConfig } from "../types.js"

export const MANAGEMENT_HOST = CONTENTFUL_MANAGEMENT_HOST
export const PREVIEW_HOST = CONTENTFUL_PREVIEW_HOST

export function managementApiRoot(project: ProjectConfig): string {
  const validated = validateProjectConfig(project)
  return `https://${MANAGEMENT_HOST}/spaces/${validated.spaceId}/environments/${validated.previewEnvironment}`
}

export function previewApiRoot(project: ProjectConfig): string {
  const validated = validateProjectConfig(project)
  return `https://${PREVIEW_HOST}/spaces/${validated.spaceId}/environments/${validated.previewEnvironment}`
}

export function validateApplyCredential(
  service: "CMA" | "CPA",
  tokenInput: unknown,
  attestationInput: unknown,
  project: ProjectConfig,
): string {
  const validated = validateProjectConfig(project)
  if (typeof tokenInput !== "string" || tokenInput.trim() === "") {
    throw new Error(`CONTENTFUL_AI_PREVIEW_${service}_TOKEN must be present and non-empty`)
  }
  if (attestationInput === undefined || attestationInput === null || attestationInput === "") {
    throw new Error(`CONTENTFUL_AI_PREVIEW_${service}_ATTESTATION is required`)
  }

  let parsed: unknown = attestationInput
  if (typeof attestationInput === "string") {
    try {
      parsed = JSON.parse(attestationInput)
    } catch {
      throw new Error(`CONTENTFUL_AI_PREVIEW_${service}_ATTESTATION is malformed JSON`)
    }
  }
  const attestation = assertRecord(parsed, `${service} credential provenance attestation`)
  assertExactKeys(
    attestation,
    ["host", "spaceId", "environmentId", "apiRoot"],
    `${service} credential provenance attestation`,
  )
  for (const key of ["host", "spaceId", "environmentId", "apiRoot"] as const) {
    if (typeof attestation[key] !== "string" || attestation[key].length === 0) {
      throw new Error(`${service} credential provenance attestation has malformed ${key}`)
    }
  }
  const claimedRoot = `https://${String(attestation.host)}/spaces/${String(attestation.spaceId)}/environments/${String(attestation.environmentId)}`
  if (attestation.apiRoot !== claimedRoot) {
    throw new Error(`${service} credential provenance attestation is contradictory`)
  }
  const expectedHost = service === "CMA" ? MANAGEMENT_HOST : PREVIEW_HOST
  const expectedRoot = service === "CMA" ? managementApiRoot(project) : previewApiRoot(project)
  if (
    attestation.host !== expectedHost ||
    attestation.spaceId !== validated.spaceId ||
    attestation.environmentId !== validated.previewEnvironment ||
    attestation.apiRoot !== expectedRoot
  ) {
    throw new Error(`${service} credential provenance attestation targets the wrong Contentful source`)
  }
  return tokenInput
}
