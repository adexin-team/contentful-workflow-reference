import { mkdir, rmdir } from "node:fs/promises"
import path from "node:path"
import { isNodeError } from "./core.js"

export async function withPhaseLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lock = path.join(root, ".tmp/contentful-workflow/phase.lock")
  await mkdir(path.dirname(lock), { recursive: true })
  try {
    await mkdir(lock)
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error("Another promotion or close phase holds the repository-local phase lock")
    }
    throw error
  }
  try {
    return await operation()
  } finally {
    await rmdir(lock)
  }
}
