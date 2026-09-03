import { randomUUID } from "node:crypto"
import { link, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { canonicalJson, isNodeError } from "../core.js"
import type { ProjectProfileBinding } from "../project-profile.js"

export type ActionName = "update" | "publish" | "verifyCma" | "verifyCpa"
export type ActionState = "pending" | "in_flight" | "succeeded" | "failed"

export interface AttemptAction {
  state: ActionState
  status: number | "unknown" | null
  version: number | null
}

export interface AttemptEntry {
  actions: Record<ActionName, AttemptAction>
  entryId: string
}

export interface AttemptJournal {
  entries: AttemptEntry[]
  identities: {
    baselineGenerationDigest: string
    changesetDigest: string
    gatsbyCommit: string
    workflowCommit: string
  }
  profile: ProjectProfileBinding
  schemaVersion: 2
  status: "applying" | "failed" | "verified"
  target: { environmentId: string; spaceId: string }
}

export type PersistJournal = (journal: AttemptJournal) => Promise<void>

export function attemptJournalPath(root: string): string {
  return path.join(root, ".tmp/contentful-workflow/apply-attempt.json")
}

export async function assertNoExistingAttempt(root: string): Promise<void> {
  try {
    await lstat(attemptJournalPath(root))
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return
    throw error
  }
  throw new Error("An apply attempt journal already exists; owner direction is required")
}

export function journalPersistence(root: string): PersistJournal {
  const output = attemptJournalPath(root)
  const directory = path.dirname(output)
  let created = false
  return async (journal) => {
    await mkdir(directory, { recursive: true })
    const temporary = path.join(directory, `.apply-attempt-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, canonicalJson(journal), { flag: "wx" })
      if (created) {
        await rename(temporary, output)
      } else {
        await link(temporary, output)
        created = true
      }
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
