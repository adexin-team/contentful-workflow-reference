import { execFile } from "node:child_process"
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const COMMIT = /^[a-f0-9]{40}$/

export interface RepositoryGateResult {
  gatsbyCommit: string
  gatsbyGitRoot?: string
  gatsbyRoot?: string
  gatsbySubtree?: string
  gatsbyTopology?: "same-repository" | "sibling-repository"
  workflowCommit: string
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  })
  return result.stdout
}

function requireCommit(value: unknown, label: string): string {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    throw new Error(`${label} must be an exact lowercase 40-character Git commit`)
  }
  return value
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function safeGatsbyPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    path.isAbsolute(value) ||
    value.includes("\\") ||
    path.posix.normalize(value) !== value
  ) throw new Error("Configured Gatsby path must be one normalized relative POSIX path")
  const parts = value.split("/")
  if (parts.some((part) => part === "" || part === "." || (part !== ".." && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)))) {
    throw new Error("Configured Gatsby path contains an unsafe segment")
  }
  if (parts[0] === "..") {
    if (parts.length !== 2 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parts[1] as string)) throw new Error("Configured sibling Gatsby path must name one repository")
  } else if ([".git", ".github", ".tmp", "config", "content", "reports", "scripts", "test"].includes(parts[0] as string)) {
    throw new Error("Configured Gatsby subtree overlaps protected workflow state")
  }
  return value
}

async function gitRoot(target: string): Promise<string> {
  return realpath((await git(target, ["rev-parse", "--show-toplevel"])).trim())
}

async function assertGatsbyRepository(
  root: string,
  workflowCommit: string,
  gatsbyCommitInput: unknown,
  gatsbyRepositoryPathInput: unknown,
): Promise<Omit<RepositoryGateResult, "workflowCommit">> {
  const gatsbyCommit = requireCommit(gatsbyCommitInput, "Authorized Gatsby commit")
  const gatsbyRepositoryPath = safeGatsbyPath(gatsbyRepositoryPathInput)
  const workflowRoot = await realpath(root)
  const configuredRoot = path.resolve(workflowRoot, gatsbyRepositoryPath)
  const metadata = await lstat(configuredRoot)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Configured Gatsby path must be a non-symlink directory")
  const gatsbyRoot = await realpath(configuredRoot)
  if (gatsbyRoot !== configuredRoot) throw new Error("Configured Gatsby path resolves through a symlink")
  const gatsbyGitRoot = await gitRoot(gatsbyRoot)

  if (gatsbyGitRoot === workflowRoot) {
    if (gatsbyRoot === workflowRoot || !pathIsWithin(workflowRoot, gatsbyRoot)) {
      throw new Error("Same-repository Gatsby path must be a strict workflow subtree")
    }
    if (gatsbyCommit !== workflowCommit) throw new Error("Same-repository Gatsby and workflow commits must be identical")
    return {
      gatsbyCommit,
      gatsbyGitRoot,
      gatsbyRoot,
      gatsbySubtree: path.relative(workflowRoot, gatsbyRoot).split(path.sep).join("/"),
      gatsbyTopology: "same-repository",
    }
  }

  if (
    !gatsbyRepositoryPath.startsWith("../") ||
    gatsbyGitRoot !== gatsbyRoot ||
    path.dirname(gatsbyGitRoot) !== path.dirname(workflowRoot)
  ) throw new Error("Configured Gatsby path is neither a sibling repository nor a workflow subtree")
  if ((await git(gatsbyGitRoot, ["rev-parse", "HEAD"])).trim() !== gatsbyCommit) {
    throw new Error("Gatsby repository HEAD does not match the authorized commit")
  }
  if ((await git(gatsbyGitRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).length !== 0) {
    throw new Error("Sibling Gatsby repository must be fully clean")
  }
  return { gatsbyCommit, gatsbyGitRoot, gatsbyRoot, gatsbyTopology: "sibling-repository" }
}

export async function assertRepositoryState(
  root: string,
  workflowCommitInput: unknown,
  gatsbyCommitInput: unknown,
  gatsbyRepositoryPathInput: unknown,
): Promise<RepositoryGateResult> {
  const workflowCommit = requireCommit(workflowCommitInput, "Authorized workflow commit")
  if ((await git(root, ["rev-parse", "HEAD"])).trim() !== workflowCommit) {
    throw new Error("Contentful HEAD does not match the authorized reviewed workflow commit")
  }
  if ((await git(root, ["diff", "--cached", "--name-only"])).trim() !== "") {
    throw new Error("Contentful index must be empty")
  }

  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  for (const record of status.split("\0").filter(Boolean)) {
    const state = record.slice(0, 2)
    const pathname = record.slice(3)
    if (state[0] !== " " && state !== "??") {
      throw new Error(`Staged or unsupported Contentful Git change blocks apply: ${pathname}`)
    }
    if (!pathname.startsWith("content/working/")) {
      throw new Error(`Contentful code/config or unsupported change blocks apply: ${pathname}`)
    }
    if (state === "??" && ((await lstat(path.join(root, pathname))).mode & 0o111) !== 0) {
      throw new Error(`Untracked executable blocks apply: ${pathname}`)
    }
  }

  const gatsby = await assertGatsbyRepository(root, workflowCommit, gatsbyCommitInput, gatsbyRepositoryPathInput)
  return { ...gatsby, workflowCommit }
}
