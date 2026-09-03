import assert from "node:assert/strict"
import childProcess, { execFile, type ChildProcess } from "node:child_process"
import dgram from "node:dgram"
import dns from "node:dns"
import http from "node:http"
import http2 from "node:http2"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"
import { readFileSync } from "node:fs"
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import vm from "node:vm"
import { Worker } from "node:worker_threads"
import { applyAiPreview } from "../scripts/lib/apply/apply.js"
import { attemptJournalPath, type AttemptJournal } from "../scripts/lib/apply/journal.js"
import { deriveChangeset } from "../scripts/lib/changeset.js"
import { closeCycle } from "../scripts/lib/close-cycle.js"
import { canonicalJson } from "../scripts/lib/core.js"
import { assertCompleteTree, bootstrapGenerationState, installGeneration, resourcesFromTree } from "../scripts/lib/generation.js"
import { refreshGatsbyPreview, startGatsbyPreview } from "../scripts/lib/gatsby-preview.js"
import { executeProductionPromotion, prepareProductionPromotion, promotionCandidatePath, promotionJournalPath } from "../scripts/lib/promotion.js"
import { loadProjectProfile, projectProfileBinding, projectProfileDigest } from "../scripts/lib/project-profile.js"
import { writeReviewEvidence } from "../scripts/lib/review-evidence.js"
import { synchronize } from "../scripts/lib/sync.js"
import { isSupportedNodeVersion } from "../scripts/check-runtime.mjs"
import { verifyManifest } from "../scripts/verify-manifest.mjs"

const run = promisify(execFile)
const root = path.resolve(import.meta.dirname, "..")
if (process.env.PUBLIC_REFERENCE_OUTBOUND_DENIAL !== "active") throw new Error("Reference tests require the outbound-denial preload")

function loadGatsbyConfig(configRoot: string, environment: NodeJS.ProcessEnv): Record<string, unknown> {
  const module = { exports: {} as Record<string, unknown> }
  const source = readFileSync(path.join(configRoot, "gatsby-config.js"), "utf8")
  new vm.Script(source, { filename: path.join(configRoot, "gatsby-config.js") }).runInNewContext({ module, process: { env: environment } })
  return module.exports
}

function assertLiveGatsbyPlugin(config: Record<string, unknown>, token: string): void {
  const plugins = config.plugins as Array<{ options: Record<string, unknown>; resolve: string }>
  assert.equal(plugins.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(plugins[0])), {
    options: { accessToken: token, environment: "preview-sandbox", host: "cdn.contentful.com", spaceId: "demoSpace123" },
    resolve: "gatsby-source-contentful",
  })
}

test("fictional profile and both exact content trees are valid", async () => {
  const profile = await loadProjectProfile(root)
  assert.equal(profile.spaceId, "demoSpace123")
  assert.equal(profile.gatsbyRepositoryPath, "gatsby-example")
  assert.match(projectProfileDigest(profile), /^[a-f0-9]{64}$/)
  const baseline = await assertCompleteTree(path.join(root, "content/baseline"), profile)
  const working = await assertCompleteTree(path.join(root, "content/working"), profile)
  assert.notEqual(baseline.generationDigest, working.generationDigest)
  assert.equal(baseline.files.size, 4)
})

test("Gatsby fixture is local, fictional, and its evaluated live config consumes the delivery contract", async () => {
  const fixture = JSON.parse(await readFile(path.join(root, "gatsby-example/data/site.json"), "utf8")) as { title: string }
  assert.equal(fixture.title, "Northwind Field Notes")
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> }
  assert.match(manifest.dependencies.gatsby ?? "", /^5\./)
  assert.match(manifest.dependencies["gatsby-source-contentful"] ?? "", /^8\./)
  const config = loadGatsbyConfig(path.join(root, "gatsby-example"), {
    CONTENTFUL_DELIVERY_TOKEN: "reviewed-delivery-placeholder",
    CONTENTFUL_AI_PREVIEW_CPA_TOKEN: "must-not-be-consumed",
  })
  assertLiveGatsbyPlugin(config, "reviewed-delivery-placeholder")
  const offlineConfig = loadGatsbyConfig(path.join(root, "gatsby-example"), { PUBLIC_REFERENCE_GATSBY_OFFLINE: "1" })
  assert.equal(Array.isArray(offlineConfig.plugins), true); assert.equal((offlineConfig.plugins as unknown[]).length, 0)
  const subtreeLock = JSON.parse(await readFile(path.join(root, "gatsby-example/package-lock.json"), "utf8")) as { packages: Record<string, { dependencies?: Record<string, string> }> }
  assert.equal(subtreeLock.packages[""]?.dependencies?.["gatsby-source-contentful"], "8.16.0")
  const reviewCore = await readFile(path.join(root, "scripts/lib/gatsby-preview.ts"), "utf8")
  assert.match(reviewCore, /\["package\.json", "package-lock\.json"\]/); assert.match(reviewCore, /args: \["ci", "--ignore-scripts"\]/)
  assert.doesNotMatch(reviewCore, /"yarn\.lock"|command: "corepack"/)
})

test("the shipped legacy adapter and installed Gatsby plugin initialize against the exact live profile contract", async () => {
  assert.equal(process.env.PUBLIC_REFERENCE_OUTBOUND_DENIAL, "active")
  process.env.CONTENTFUL_SPACE_ID = "demoSpace123"
  process.env.CONTENTFUL_ENVIRONMENT = "preview-sandbox"
  const require = createRequire(import.meta.url)
  require(path.join(root, "scripts/lib/legacy-contentful-preview-cda.cjs"))
  const fromPlugin = createRequire(path.join(root, "node_modules/gatsby-source-contentful/adapter-probe.cjs"))
  const contentful = fromPlugin("contentful") as { createClient(options: Record<string, unknown>): { getSpace(): Promise<{ sys: { id: string } }> } }
  const exactOptions = { accessToken: "reviewed-delivery-placeholder", environment: "preview-sandbox", host: "cdn.contentful.com", space: "demoSpace123" }
  assert.equal((await contentful.createClient(exactOptions).getSpace()).sys.id, "demoSpace123")
  assert.throws(() => contentful.createClient({ ...exactOptions, host: "preview.contentful.com" }), /refused/)
  assert.throws(() => contentful.createClient({ ...exactOptions, environment: "other-preview" }), /refused/)
  assert.throws(() => contentful.createClient({ ...exactOptions, accessToken: "" }), /accessToken|Access token/i)

  const plugin = fromPlugin("./gatsby-node.js") as { onPreInit(args: Record<string, unknown>, options: Record<string, unknown>): Promise<void> }
  const allowed: string[] = []
  await plugin.onPreInit({
    actions: { addRemoteFileAllowedUrl: (value: string) => allowed.push(value) },
    reporter: { panic: (value: unknown) => { throw new Error(`Unexpected plugin panic: ${JSON.stringify(value)}`) } },
    store: { getState: () => ({ flattenedPlugins: [{ name: "gatsby-plugin-image" }] }) },
  }, { accessToken: exactOptions.accessToken, environment: exactOptions.environment, host: exactOptions.host, spaceId: exactOptions.space })
  assert.deepEqual(allowed, ["https://images.ctfassets.net/demoSpace123/*"])
})

async function regularFiles(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (relative === ".git" || relative.startsWith(".git/")) continue
    if (entry.isDirectory()) files.push(...await regularFiles(directory, relative))
    else if (entry.isFile()) files.push(relative)
    else throw new Error(`Unsupported fixture entry: ${relative}`)
  }
  return files.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
}

async function createFixtureCommit(fixture: string): Promise<string> {
  const git = async (...args: string[]) => (await run("git", args, { cwd: fixture, encoding: "utf8" })).stdout.trim()
  const template = path.join(root, ".tmp/outbound-harness/empty-git-template")
  await git("init", "--quiet", "--initial-branch=main", `--template=${template}`)
  for (const relative of await regularFiles(fixture)) {
    const object = await git("hash-object", "-w", "--no-filters", relative)
    assert.match(object, /^[a-f0-9]{40}$/)
    await git("update-index", "--add", "--cacheinfo", `100644,${object},${relative}`)
  }
  const tree = await git("write-tree"); assert.match(tree, /^[a-f0-9]{40}$/)
  const commit = await git("commit-tree", tree, "-m", "fictional fixture"); assert.match(commit, /^[a-f0-9]{40}$/)
  await git("update-ref", "refs/heads/main", commit)
  return commit
}

async function gitFixture(): Promise<{ commit: string; fixture: string }> {
  await mkdir(path.join(root, ".tmp"), { recursive: true })
  const fixture = await mkdtemp(path.join(root, ".tmp/reference-git-"))
  for (const relative of ["config/project.json", "content/baseline", "content/working", "gatsby-example/data", "gatsby-example/src",
    "gatsby-example/gatsby-config.js", "gatsby-example/gatsby-node.js", "gatsby-example/package.json", "gatsby-example/package-lock.json",
    "scripts/lib/legacy-contentful-preview-cda.cjs"]) {
    await cp(path.join(root, relative), path.join(fixture, relative), { recursive: true })
  }
  await writeFile(path.join(fixture, ".gitignore"), ".tmp/\n")
  await writeFile(path.join(fixture, "README.md"), "fictional\n")
  const profile = await loadProjectProfile(fixture)
  const baseline = await assertCompleteTree(path.join(fixture, "content/baseline"), profile)
  await installGeneration(fixture, resourcesFromTree(baseline), "fixture-sync-token", profile)
  const commit = await createFixtureCommit(fixture)
  const entryPath = path.join(fixture, "content/working/entries/basicPage/welcomePage.json")
  const entry = JSON.parse(await readFile(entryPath, "utf8")) as { fields: { title: { "en-US": string } } }
  entry.fields.title["en-US"] = "Northwind Field Notes — Reviewed draft"
  await writeFile(entryPath, `${JSON.stringify(entry, null, 2)}\n`)
  return { commit, fixture }
}

test("default apply gate and real Gatsby start archive enforce the same-repository contract", async () => {
  const { commit, fixture } = await gitFixture(); const profile = await loadProjectProfile(fixture)
  try {
    const changeset = await deriveChangeset(fixture, profile)
    const baselineGenerationDigest = changeset.baselineGenerationDigest as string
    const changesetDigest = changeset.changesetDigest as string
    const activation = {
      baselineGenerationDigest, changesetDigest,
      cmaAttestation: { apiRoot: "https://api.contentful.com/spaces/demoSpace123/environments/preview-sandbox", environmentId: "preview-sandbox", host: "api.contentful.com", spaceId: "demoSpace123" },
      cmaToken: "fixture-cma-token", gatsbyCommit: commit,
      cpaAttestation: { apiRoot: "https://preview.contentful.com/spaces/demoSpace123/environments/preview-sandbox", environmentId: "preview-sandbox", host: "preview.contentful.com", spaceId: "demoSpace123" },
      cpaToken: "fixture-cpa-token", workflowCommit: commit,
    }
    let requests = 0
    await assert.rejects(applyAiPreview({ activation, fetchImpl: (async () => { requests += 1; throw new Error("downstream mock reached") }) as typeof fetch, project: profile, root: fixture, skipExistingAttemptCheck: true }), /downstream mock reached/)
    assert.equal(requests, 1, "the default repository gate must run before the mocked transport seam")

    await writeFile(path.join(fixture, "README.md"), "unsupported dirt\n")
    requests = 0
    await assert.rejects(applyAiPreview({ activation, fetchImpl: (async () => { requests += 1; throw new Error("must not fetch") }) as typeof fetch, project: profile, root: fixture, skipExistingAttemptCheck: true }), /unsupported change|code\/config/)
    assert.equal(requests, 0); await writeFile(path.join(fixture, "README.md"), "fictional\n")
    const page = path.join(fixture, "gatsby-example/src/pages/index.js"); const originalPage = await readFile(page)
    await writeFile(page, "export default () => 'dirty'\n")
    await assert.rejects(applyAiPreview({ activation, fetchImpl: (async () => { throw new Error("must not fetch") }) as typeof fetch, project: profile, root: fixture, skipExistingAttemptCheck: true }), /unsupported change|code\/config/)
    await writeFile(page, originalPage)
    await assert.rejects(applyAiPreview({ activation: { ...activation, gatsbyCommit: "0".repeat(40) }, fetchImpl: (async () => { throw new Error("must not fetch") }) as typeof fetch, project: profile, root: fixture, skipExistingAttemptCheck: true }), /must be identical/)

    const action = { state: "succeeded" as const, status: 200, version: 1 }
    const journal: AttemptJournal = {
      entries: (changeset.entries as Array<{ entryId: string }>).map(({ entryId }) => ({ actions: { publish: { ...action }, update: { ...action }, verifyCma: { ...action }, verifyCpa: { ...action, version: null } }, entryId })),
      identities: { baselineGenerationDigest, changesetDigest, gatsbyCommit: commit, workflowCommit: commit },
      profile: projectProfileBinding(profile), schemaVersion: 2, status: "verified", target: { environmentId: profile.previewEnvironment, spaceId: profile.spaceId },
    }
    await mkdir(path.dirname(attemptJournalPath(fixture)), { recursive: true }); await writeFile(attemptJournalPath(fixture), canonicalJson(journal))
    let archivedSite: string | undefined; let installCalls = 0
    const started = await startGatsbyPreview({
      activation: { baselineGenerationDigest, changesetDigest, gatsbyCommit: commit,
        executionWorkflowCommit: commit, workflowCommit: commit,
        cdaAttestation: { apiRoot: "https://cdn.contentful.com/spaces/demoSpace123/environments/preview-sandbox", environmentId: "preview-sandbox", host: "cdn.contentful.com", spaceId: "demoSpace123" },
        cdaToken: "fixture-cda-token", refreshToken: "fixture-refresh-token" },
      processEnv: { PATH: process.env.PATH }, project: profile, root: fixture,
      runCommand: async (invocation) => {
        if (invocation.command === "npm") {
          installCalls += 1; archivedSite = invocation.cwd
          assert.equal(await readFile(path.join(invocation.cwd, "package.json"), "utf8"), await readFile(path.join(fixture, "gatsby-example/package.json"), "utf8"))
          assert.ok((await readFile(path.join(invocation.cwd, "package-lock.json"))).length > 0)
          await assert.rejects(readFile(path.join(invocation.cwd, "README.md")))
          await assert.rejects(readFile(path.join(invocation.cwd, "content/working/entries/basicPage/welcomePage.json")))
          await mkdir(path.join(invocation.cwd, "node_modules/gatsby"), { recursive: true }); await writeFile(path.join(invocation.cwd, "node_modules/gatsby/cli.js"), "export {}\n")
        }
      },
      spawnGatsby: (invocation) => {
        assert.equal(invocation.env.CONTENTFUL_DELIVERY_TOKEN, "fixture-cda-token")
        assert.equal(invocation.env.CONTENTFUL_HOST, "cdn.contentful.com")
        assert.equal(invocation.env.CONTENTFUL_SPACE_ID, "demoSpace123")
        assert.equal(invocation.env.CONTENTFUL_ENVIRONMENT, "preview-sandbox")
        assert.equal(invocation.env.CONTENTFUL_AI_PREVIEW_CPA_TOKEN, undefined)
        assertLiveGatsbyPlugin(loadGatsbyConfig(invocation.cwd, invocation.env), "fixture-cda-token")
        return { pid: 4242 } as ChildProcess
      },
    })
    assert.equal(installCalls, 1); assert.equal(started.siteRoot, archivedSite); assert.ok(await readFile(path.join(started.siteRoot, "src/pages/index.js")))
  } finally { await rm(fixture, { recursive: true, force: true }) }
})

test("outbound denial covers direct, promise, datagram, process, and propagated child paths", () => {
  assert.equal(process.env.PUBLIC_REFERENCE_OUTBOUND_DENIAL, "active")
  const SocketConstructor = dgram.Socket as unknown as new (type: "udp4") => dgram.Socket
  const tsc = path.join(root, "node_modules/typescript/bin/tsc")
  const gatsby = path.join(root, "node_modules/gatsby/cli.js")
  const esbuild = path.join(root, "node_modules", "@esbuild", `${process.platform}-${process.arch}`, "bin/esbuild")
  const gatsbyWorker = path.join(root, "node_modules/gatsby-worker/dist/child.js")
  const workerModule = path.join(root, "node_modules/gatsby/dist/utils/worker/child/index.js")
  const workerEnv = { ...process.env, GATSBY_WORKER_ID: "1", GATSBY_WORKER_IN_FLIGHT_DUMP_LOCATION: "/tmp/gatsby-worker-fixture/worker-1.json", GATSBY_WORKER_MODULE_PATH: workerModule }
  for (const operation of [
    () => fetch("https://example.invalid"), () => http.get("http://example.invalid"), () => https.get("https://example.invalid"),
    () => net.connect(443, "example.invalid"), () => tls.connect(443, "example.invalid"), () => http2.connect("https://example.invalid"),
    () => dns.lookup("example.invalid", () => undefined), () => dns.resolve("example.invalid", () => undefined),
    () => new dns.Resolver().resolve("example.invalid", () => undefined), () => new dns.promises.Resolver().resolve("example.invalid"),
    () => dgram.createSocket("udp4"), () => new SocketConstructor("udp4").bind(0), () => new SocketConstructor("udp4").connect(53, "example.invalid"),
    () => new SocketConstructor("udp4").send(Buffer.from("x"), 53, "example.invalid"),
    () => childProcess.spawnSync("curl", ["https://example.invalid"]), () => childProcess.spawnSync("git", ["fetch", "origin"]),
    () => childProcess.spawnSync("git", ["remote", "-v"]),
    () => childProcess.spawnSync("git", ["-c", "http.proxy=https://example.invalid", "status"]),
    () => childProcess.spawnSync("git", ["clone", "https://example.invalid/repository.git"]),
    () => childProcess.spawnSync(process.execPath, [tsc, "--noEmit", "https://example.invalid/injected"]),
    () => childProcess.spawnSync(process.execPath, [gatsby, "build", "--prefix-paths", "--verbose"], { shell: true }),
    () => childProcess.spawnSync(process.execPath, [gatsby, "build", "--prefix-paths", "--verbose"], { cwd: "/tmp" }),
    () => childProcess.spawnSync(esbuild, ["--service=0.28.2", "--ping", "https://example.invalid"]),
    () => childProcess.spawnSync(esbuild, ["https://example.invalid"]),
    () => childProcess.fork(gatsbyWorker, ["https://example.invalid"], { env: workerEnv }),
    () => new Worker("data:text/javascript,fetch('https://example.invalid')", { eval: true }),
    () => new Worker(path.join(root, "test/worker-network-probe.cjs"), { execArgv: [] }),
    () => new Worker(path.join(root, "test/worker-network-probe.cjs"), { env: {} }),
    () => new Worker(path.join(root, "test/worker-network-probe.cjs"), { argv: ["https://example.invalid"] }),
    () => childProcess.spawnSync(process.execPath, ["-e", "fetch('https://example.invalid').catch(() => process.exit(2))"], { env: { ...process.env, NODE_OPTIONS: "" } }),
    () => childProcess.spawnSync(process.execPath, ["-e", "fetch('https://example.invalid').catch(() => process.exit(2))"], { env: { ...process.env, NODE_OPTIONS: "--require=/tmp/replacement.cjs" } }),
    () => childProcess.spawnSync(process.execPath, ["-e", "fetch('https://example.invalid').catch(() => process.exit(2))"], { env: { ...process.env, PATH: "/tmp" } }),
  ]) assert.throws(operation, /outbound network is denied|denied|cannot|outside/i)
  const child = childProcess.spawnSync(process.execPath, ["-e", "fetch('https://example.invalid').catch(() => process.exit(2))"], { env: { ...process.env } })
  assert.notEqual(child.status, 0); assert.match(child.stderr.toString(), /Outbound network is denied/i)
})

test("one real allowed Worker retains the preload and denies network", async () => {
  const result = await new Promise<string>((resolve, reject) => {
    const worker = new Worker(path.join(root, "test/worker-network-probe.cjs"))
    worker.once("message", resolve); worker.once("error", reject)
  })
  assert.equal(result, "denied")
})

test("Git execution ignores global templates/config and rejects unsafe local controls", async () => {
  const temporary = await mkdtemp(path.join(root, ".tmp/reference-git-security-"))
  const marker = path.join(temporary, "executed")
  const global = path.join(temporary, "malicious-global")
  const template = path.join(temporary, "malicious-template/hooks")
  try {
    await mkdir(template, { recursive: true })
    await writeFile(global, `[core]\n\thooksPath = ${template}\n\tfsmonitor = touch ${marker}\n`)
    await writeFile(path.join(template, "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`); await chmod(path.join(template, "pre-commit"), 0o755)
    const previousHome = process.env.HOME; const previousGlobal = process.env.GIT_CONFIG_GLOBAL; const previousTemplate = process.env.GIT_TEMPLATE_DIR
    process.env.HOME = temporary; process.env.GIT_CONFIG_GLOBAL = global; process.env.GIT_TEMPLATE_DIR = path.dirname(template)
    await writeFile(path.join(temporary, "fixture.txt"), "fixture\n")
    const commit = await createFixtureCommit(temporary); assert.match(commit, /^[a-f0-9]{40}$/)
    await assert.rejects(readFile(marker))
    const config = path.join(temporary, ".git/config"); const original = await readFile(config, "utf8")
    await writeFile(config, `${original}\n[core]\n\thooksPath = ${template}\n`)
    assert.throws(() => childProcess.spawnSync("git", ["rev-parse", "HEAD"], { cwd: temporary }), /unsafe local configuration/)
    await writeFile(config, original)
    process.env.HOME = previousHome; process.env.GIT_CONFIG_GLOBAL = previousGlobal; process.env.GIT_TEMPLATE_DIR = previousTemplate
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, status })
}

function targetLink(id: string, linkType: string): Record<string, unknown> {
  return { sys: { id, linkType, type: "Link" } }
}

async function snapshotResources(directory: string): Promise<ReturnType<typeof resourcesFromTree>> {
  const project = await loadProjectProfile(directory)
  return resourcesFromTree(await assertCompleteTree(path.join(directory, "content/baseline"), project))
}

function syncTransport(resources: ReturnType<typeof resourcesFromTree>, entryOverride?: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes("/sync?")) {
      return jsonResponse({
        items: [entryOverride ?? resources.entries.get("welcomePage"), resources.assets.get("heroImage")],
        nextSyncUrl: "https://cdn.contentful.com/spaces/demoSpace123/environments/preview-sandbox/sync?sync_token=fake-next-token",
      })
    }
    if (url.includes("/locales?")) return jsonResponse({ items: [...resources.locales.values()], limit: 1000, skip: 0, total: resources.locales.size })
    if (url.endsWith("/content_types/basicPage")) return jsonResponse(resources.contentTypes.get("basicPage"))
    throw new Error(`Unexpected fake Sync request: ${url}`)
  }) as typeof fetch
}

test("runtime contract accepts every supported boundary and rejects adjacent unsupported versions", () => {
  assert.equal(isSupportedNodeVersion("20.18.99"), false)
  assert.equal(isSupportedNodeVersion("20.19.0"), true)
  assert.equal(isSupportedNodeVersion("22.0.0"), true)
  assert.equal(isSupportedNodeVersion("24.99.99"), true)
  assert.equal(isSupportedNodeVersion("25.0.0"), false)
  assert.equal(isSupportedNodeVersion("v24.18.0"), true)
})

test("live workflow rejects an ambiguous repository path containing spaces before loading profile data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow path with spaces "))
  try {
    await mkdir(path.join(directory, "config")); await cp(path.join(root, "config/project.json"), path.join(directory, "config/project.json"))
    await assert.rejects(loadProjectProfile(directory), /must not contain whitespace/)
  } finally { await rm(directory, { force: true, recursive: true }) }
})

test("manifest verifies archive modes, Git clones, worktrees, spaces, and still rejects unexpected bytes", async () => {
  const container = await mkdtemp(path.join(os.tmpdir(), "contentful manifest fixture "))
  const candidate = path.join(container, "candidate with spaces")
  try {
    await cp(root, candidate, {
      filter: (source) => {
        const relative = path.relative(root, source)
        return relative === "" || ![".git", ".tmp", "node_modules", "gatsby-example/.cache", "gatsby-example/public"].some((excluded) => relative === excluded || relative.startsWith(`${excluded}${path.sep}`))
      },
      recursive: true,
    })
    const makeArchiveModes = async (directory: string): Promise<void> => {
      await chmod(directory, 0o755)
      for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await makeArchiveModes(path.join(directory, entry.name))
    }
    await makeArchiveModes(candidate)
    const realCandidate = await realpath(candidate)
    await verifyManifest(realCandidate)
    await mkdir(path.join(candidate, ".git")); await verifyManifest(realCandidate)
    await rm(path.join(candidate, ".git"), { recursive: true }); await writeFile(path.join(candidate, ".git"), "gitdir: ../worktree-metadata\n")
    await verifyManifest(realCandidate)
    await writeFile(path.join(candidate, "unexpected.txt"), "unexpected\n")
    await assert.rejects(verifyManifest(realCandidate), /does not match the exact candidate tree/)
  } finally { await rm(container, { force: true, recursive: true }) }
})

test("shipped example bootstrap creates changeset-capable state and refuses fake incremental sync", async () => {
  const fixture = await mkdtemp(path.join(root, ".tmp/bootstrap-example-"))
  try {
    for (const relative of ["config", "content"]) await cp(path.join(root, relative), path.join(fixture, relative), { recursive: true })
    const project = await loadProjectProfile(fixture)
    const digest = await bootstrapGenerationState(fixture, project)
    assert.match(digest, /^[a-f0-9]{64}$/)
    const changeset = await deriveChangeset(fixture, project)
    assert.equal((changeset.entries as unknown[]).length, 1)
    await assert.rejects(bootstrapGenerationState(fixture, project), /already exists/)
    let requests = 0
    await assert.rejects(synchronize({
      attestation: { apiRoot: "https://cdn.contentful.com/spaces/demoSpace123/environments/preview-sandbox", environmentId: "preview-sandbox", host: "cdn.contentful.com", spaceId: "demoSpace123" },
      fetchImpl: (async () => { requests += 1; throw new Error("must not fetch") }) as typeof fetch,
      initial: false, project, root: fixture, token: "fake-read-token",
    }), /--initial/)
    assert.equal(requests, 0)
  } finally { await rm(fixture, { force: true, recursive: true }) }
})

test("initial sync installs atomically from fake Contentful and leaves local bytes untouched on partial failure", async () => {
  const fixture = await mkdtemp(path.join(root, ".tmp/sync-integration-"))
  try {
    for (const relative of ["config", "content"]) await cp(path.join(root, relative), path.join(fixture, relative), { recursive: true })
    await cp(path.join(root, "content/baseline"), path.join(fixture, "content/working"), { recursive: true, force: true })
    const project = await loadProjectProfile(fixture)
    const resources = await snapshotResources(fixture)
    const attestation = { apiRoot: "https://cdn.contentful.com/spaces/demoSpace123/environments/preview-sandbox", environmentId: "preview-sandbox", host: "cdn.contentful.com", spaceId: "demoSpace123" }
    const failedRoot = path.join(fixture, "failed")
    await mkdir(failedRoot); await cp(path.join(fixture, "config"), path.join(failedRoot, "config"), { recursive: true }); await cp(path.join(fixture, "content"), path.join(failedRoot, "content"), { recursive: true })
    const before = await readFile(path.join(failedRoot, "content/baseline/entries/basicPage/welcomePage.json"), "utf8")
    const failing = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/content_types/basicPage")) return jsonResponse({ error: "partial" }, 503)
      return syncTransport(resources)(input)
    }) as typeof fetch
    await assert.rejects(synchronize({ attestation, fetchImpl: failing, initial: true, project, root: failedRoot, token: "fake-read-token" }), /HTTP 503/)
    assert.equal(await readFile(path.join(failedRoot, "content/baseline/entries/basicPage/welcomePage.json"), "utf8"), before)
    const result = await synchronize({ attestation, fetchImpl: syncTransport(resources), initial: true, project, root: fixture, token: "fake-read-token" })
    assert.deepEqual(result.counts, { assets: 1, contentTypes: 1, entries: 1, locales: 1 })
    assert.equal((await deriveChangeset(fixture, project)).entries instanceof Array, true)
  } finally { await rm(fixture, { force: true, recursive: true }) }
})

function targetedResource(
  resource: Record<string, unknown>,
  environmentId: string,
  additions: Record<string, unknown> = {},
): Record<string, unknown> {
  const copy = structuredClone(resource)
  const sys = copy.sys as Record<string, unknown>
  sys.environment = targetLink(environmentId, "Environment")
  sys.space = targetLink("demoSpace123", "Space")
  Object.assign(sys, additions)
  return copy
}

function localeFor(environmentId: string): Record<string, unknown> {
  return {
    code: "en-US", default: true, fallbackCode: null, name: "English (United States)",
    sys: { environment: targetLink(environmentId, "Environment"), id: "en-US", space: targetLink("demoSpace123", "Space"), type: "Locale" },
  }
}

function previewApplyTransport(resources: ReturnType<typeof resourcesFromTree>, failPublish = false): typeof fetch {
  const baseline = targetedResource(resources.entries.get("welcomePage") as Record<string, unknown>, "preview-sandbox", { publishedVersion: 4, version: 5 })
  baseline.metadata = { tags: [] }
  const merged = structuredClone(baseline)
  ;(merged.fields as Record<string, unknown>).title = { "en-US": "Northwind Field Notes — Reviewed draft" }
  let state: "baseline" | "updated" | "published" = "baseline"
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input); const method = init.method ?? "GET"
    if (url.endsWith("/content_types/basicPage")) return jsonResponse(resources.contentTypes.get("basicPage"))
    if (url.endsWith("/locales?limit=1000")) return jsonResponse({ items: [localeFor("preview-sandbox")], total: 1 })
    if (url.includes("preview.contentful.com") && url.includes("/entries/welcomePage")) {
      return jsonResponse(targetedResource(merged, "preview-sandbox", { publishedVersion: 6, version: 7 }))
    }
    if (url.endsWith("/entries/welcomePage/published") && method === "PUT") {
      if (failPublish) return jsonResponse({ error: "simulated partial failure" }, 503)
      state = "published"
      return jsonResponse(targetedResource(merged, "preview-sandbox", { publishedVersion: 6, version: 7 }))
    }
    if (url.endsWith("/entries/welcomePage") && method === "PUT") {
      state = "updated"
      return jsonResponse(targetedResource(merged, "preview-sandbox", { publishedVersion: 4, version: 6 }))
    }
    if (url.endsWith("/entries/welcomePage")) {
      return jsonResponse(state === "published" ? targetedResource(merged, "preview-sandbox", { publishedVersion: 6, version: 7 }) : baseline)
    }
    throw new Error(`Unexpected fake preview apply request: ${method} ${url}`)
  }) as typeof fetch
}

async function applyFixture(fixture: string, commit: string, failPublish = false): Promise<{ activation: Record<string, unknown>; changeset: Record<string, unknown>; project: Awaited<ReturnType<typeof loadProjectProfile>> }> {
  const project = await loadProjectProfile(fixture)
  const changeset = await deriveChangeset(fixture, project)
  const activation = {
    baselineGenerationDigest: changeset.baselineGenerationDigest,
    changesetDigest: changeset.changesetDigest,
    cmaAttestation: { apiRoot: "https://api.contentful.com/spaces/demoSpace123/environments/preview-sandbox", environmentId: "preview-sandbox", host: "api.contentful.com", spaceId: "demoSpace123" },
    cmaToken: "preview-write-token",
    gatsbyCommit: commit,
    cpaAttestation: { apiRoot: "https://preview.contentful.com/spaces/demoSpace123/environments/preview-sandbox", environmentId: "preview-sandbox", host: "preview.contentful.com", spaceId: "demoSpace123" },
    cpaToken: "preview-read-token",
    workflowCommit: commit,
  }
  await applyAiPreview({
    activation: activation as Parameters<typeof applyAiPreview>[0]["activation"],
    fetchImpl: previewApplyTransport(resourcesFromTree((await assertCompleteTree(path.join(fixture, "content/baseline"), project))), failPublish),
    project,
    repositoryGate: async () => ({ gatsbyCommit: commit, workflowCommit: commit }),
    root: fixture,
  })
  return { activation, changeset, project }
}

test("apply records a failed remote action and blocks an unreviewed retry", async () => {
  const { commit, fixture } = await gitFixture()
  try {
    await assert.rejects(applyFixture(fixture, commit, true), /HTTP 503/)
    const journal = JSON.parse(await readFile(attemptJournalPath(fixture), "utf8")) as AttemptJournal
    assert.equal(journal.status, "failed")
    assert.equal(journal.entries[0]?.actions.update.state, "succeeded")
    assert.equal(journal.entries[0]?.actions.publish.state, "failed")
    const project = await loadProjectProfile(fixture); const changeset = await deriveChangeset(fixture, project)
    let requests = 0
    await assert.rejects(applyAiPreview({
      activation: {
        baselineGenerationDigest: changeset.baselineGenerationDigest, changesetDigest: changeset.changesetDigest,
        cmaAttestation: { apiRoot: "https://api.contentful.com/spaces/demoSpace123/environments/preview-sandbox", environmentId: "preview-sandbox", host: "api.contentful.com", spaceId: "demoSpace123" },
        cmaToken: "x",
        cpaAttestation: { apiRoot: "https://preview.contentful.com/spaces/demoSpace123/environments/preview-sandbox", environmentId: "preview-sandbox", host: "preview.contentful.com", spaceId: "demoSpace123" },
        cpaToken: "x", gatsbyCommit: commit, workflowCommit: commit,
      },
      fetchImpl: (async () => { requests += 1; throw new Error("must not fetch") }) as typeof fetch,
      project, repositoryGate: async () => ({ gatsbyCommit: commit, workflowCommit: commit }), root: fixture,
    }), /attempt journal/)
    assert.equal(requests, 0)
  } finally { await rm(fixture, { force: true, recursive: true }) }
})

test("refresh verifies changed fields and every Gatsby route through local fakes", async () => {
  const { commit, fixture } = await gitFixture()
  try {
    const { activation, project } = await applyFixture(fixture, commit)
    const runId = "12345678-1234-4123-8123-123456789abc"
    const runRoot = path.join(fixture, ".tmp/contentful-workflow/gatsby-preview", runId)
    const siteRoot = path.join(runRoot, "site")
    const gatsbyCli = path.join(siteRoot, "node_modules/gatsby/cli.js")
    const childScript = path.join(siteRoot, ".cache/tmp-4242-AbCdEf123456")
    await mkdir(path.dirname(gatsbyCli), { recursive: true }); await mkdir(path.dirname(childScript), { recursive: true })
    await writeFile(gatsbyCli, "export {}\n"); await writeFile(childScript, "export {}\n")
    const reviewActivation = {
      baselineGenerationDigest: activation.baselineGenerationDigest,
      changesetDigest: activation.changesetDigest,
      gatsbyCommit: commit,
      workflowCommit: commit,
    }
    await writeFile(path.join(runRoot, "session.json"), canonicalJson({
      ...reviewActivation, origin: "http://127.0.0.1:4173", pid: 4242,
      profile: projectProfileBinding(project), schemaVersion: 2, siteRoot,
    }))
    const requests: string[] = []
    const localFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input); requests.push(url)
      if (url.endsWith("/__refresh/gatsby-source-contentful")) return jsonResponse({ refreshed: true })
      if (url.endsWith("/___graphql")) {
        const body = JSON.parse(String(init.body)) as { query: string }
        if (body.query.includes("__schema")) return jsonResponse({ data: { __schema: { types: [{
          fields: [
            { name: "contentful_id", type: { kind: "SCALAR", name: "String" } },
            { name: "node_locale", type: { kind: "SCALAR", name: "String" } },
            { name: "title", type: { kind: "SCALAR", name: "String" } },
          ], kind: "OBJECT", name: "ContentfulFictionalBasicPage",
        }] } } })
        if (body.query.includes("GatsbyReviewConvergence")) return jsonResponse({ data: { changed_0: { nodes: [{ contentful_id: "welcomePage", node_locale: "en-US", title: "Northwind Field Notes — Reviewed draft" }] } } })
        if (body.query.includes("GatsbyReviewRoutes")) return jsonResponse({ data: { allSitePage: { nodes: [{ path: "/" }, { path: "/about/" }], totalCount: 2 } } })
      }
      if (url === "http://127.0.0.1:4173/" || url === "http://127.0.0.1:4173/about/") return new Response("ok", { status: 200 })
      throw new Error(`Unexpected local review request: ${url}`)
    }) as typeof fetch
    const refreshed = await refreshGatsbyPreview({
      activation: reviewActivation,
      fetchImpl: localFetch,
      inspectProcess: async (expected) => ({
        ...expected,
        lineage: [
          { command: `${process.execPath} ${childScript}`, cwd: siteRoot, pid: 4243, ppid: 4242 },
          { command: expected.command, cwd: siteRoot, pid: 4242, ppid: 1 },
        ],
        listener: { ...expected.listener, pid: 4243 },
      }),
      processEnv: { CONTENTFUL_AI_PREVIEW_GATSBY_REFRESH_TOKEN: "one-time-local-token" },
      project,
      repositoryGate: async () => ({ gatsbyCommit: commit, workflowCommit: commit }),
      root: fixture,
      sleep: async () => undefined,
      timeoutMs: 5_000,
    })
    assert.deepEqual(refreshed.requestedPaths, ["/", "/about/"])
    assert.equal(refreshed.evidence.status, "verified")
    assert.equal(requests.filter((url) => url.endsWith("/") || url.endsWith("/about/")).length >= 2, true)
  } finally { await rm(fixture, { force: true, recursive: true }) }
})

function productionTransport(resources: ReturnType<typeof resourcesFromTree>): { fetchImpl: typeof fetch; calls: Array<{ method: string; token: string }> } {
  const baseline = targetedResource(resources.entries.get("welcomePage") as Record<string, unknown>, "live-sandbox", { publishedVersion: 4, version: 5 })
  baseline.metadata = { tags: [] }
  const merged = structuredClone(baseline)
  ;(merged.fields as Record<string, unknown>).title = { "en-US": "Northwind Field Notes — Reviewed draft" }
  let state: "baseline" | "updated" | "published" = "baseline"
  const calls: Array<{ method: string; token: string }> = []
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input); const method = init.method ?? "GET"
    const token = String((init.headers as Record<string, string> | undefined)?.Authorization ?? "").replace(/^Bearer /, "")
    calls.push({ method, token })
    if (url.includes("/environment_aliases/live-alias")) return jsonResponse({ environment: targetLink("live-sandbox", "Environment"), sys: { id: "live-alias", type: "EnvironmentAlias" } })
    if (url.includes("cdn.contentful.com") && url.includes("/entries/welcomePage")) {
      return jsonResponse(state === "published" ? targetedResource(merged, "live-sandbox", { publishedVersion: 6, version: 7 }) : baseline)
    }
    if (url.endsWith("/content_types/basicPage")) return jsonResponse(targetedResource(resources.contentTypes.get("basicPage") as Record<string, unknown>, "live-sandbox"))
    if (url.endsWith("/locales?limit=1000")) return jsonResponse({ items: [localeFor("live-sandbox")], total: 1 })
    if (url.endsWith("/entries/welcomePage/published") && method === "PUT") {
      state = "published"
      return jsonResponse(targetedResource(merged, "live-sandbox", { publishedVersion: 6, version: 7 }))
    }
    if (url.endsWith("/entries/welcomePage") && method === "PUT") {
      state = "updated"
      return jsonResponse(targetedResource(merged, "live-sandbox", { publishedVersion: 4, version: 6 }))
    }
    if (url.endsWith("/entries/welcomePage")) {
      return jsonResponse(state === "published" ? targetedResource(merged, "live-sandbox", { publishedVersion: 6, version: 7 }) : baseline)
    }
    throw new Error(`Unexpected fake production request: ${method} ${url}`)
  }) as typeof fetch
  return { calls, fetchImpl }
}

test("read-only prepare, confirmed production execution, journals, and close complete with fakes", async () => {
  const { commit, fixture } = await gitFixture()
  try {
    const { activation, project } = await applyFixture(fixture, commit)
    const reviewActivation = {
      baselineGenerationDigest: String(activation.baselineGenerationDigest),
      changesetDigest: String(activation.changesetDigest),
      gatsbyCommit: commit,
      workflowCommit: commit,
    }
    await writeReviewEvidence(fixture, reviewActivation, project, ["/"])
    const resources = resourcesFromTree(await assertCompleteTree(path.join(fixture, "content/baseline"), project))
    const production = productionTransport(resources)
    const productionActivation = {
      ...reviewActivation,
      cdaAttestation: { apiRoot: "https://cdn.contentful.com/spaces/demoSpace123/environments/live-sandbox", environmentId: "live-sandbox", host: "cdn.contentful.com", spaceId: "demoSpace123" },
      cdaToken: "production-delivery-read-token",
      cmaAttestation: { apiRoot: "https://api.contentful.com/spaces/demoSpace123/environments/live-sandbox", environmentId: "live-sandbox", host: "api.contentful.com", spaceId: "demoSpace123" },
      cmaReadToken: "production-management-read-token",
      executionWorkflowCommit: commit,
    }
    const candidate = await prepareProductionPromotion({
      activation: productionActivation,
      fetchImpl: production.fetchImpl,
      project,
      repositoryGate: async () => ({ gatsbyCommit: commit, workflowCommit: commit }),
      root: fixture,
    })
    assert.match(candidate.candidateDigest, /^[a-f0-9]{64}$/)
    assert.equal(production.calls.some((call) => call.method !== "GET"), false)
    assert.equal(production.calls.some((call) => call.token === "production-management-write-token"), false)
    const callsAfterPrepare = production.calls.length
    await assert.rejects(executeProductionPromotion({
      activation: { ...productionActivation, cmaWriteToken: "production-management-write-token" },
      confirmation: "PROMOTE:wrong:TO:live-sandbox",
      fetchImpl: production.fetchImpl,
      project,
      repositoryGate: async () => ({ gatsbyCommit: commit, workflowCommit: commit }),
      root: fixture,
    }), /Exact production confirmation/)
    assert.equal(production.calls.length, callsAfterPrepare)
    await assert.rejects(executeProductionPromotion({
      activation: { ...productionActivation, cmaWriteToken: productionActivation.cmaReadToken },
      confirmation: `PROMOTE:${candidate.candidateDigest}:TO:live-sandbox`,
      fetchImpl: production.fetchImpl,
      project,
      repositoryGate: async () => ({ gatsbyCommit: commit, workflowCommit: commit }),
      root: fixture,
    }), /read and write credentials must be distinct/)
    assert.equal(production.calls.some((call) => call.method !== "GET"), false)
    await assert.rejects(readFile(promotionJournalPath(fixture)), /ENOENT/)
    const promotion = await executeProductionPromotion({
      activation: { ...productionActivation, cmaWriteToken: "production-management-write-token" },
      confirmation: `PROMOTE:${candidate.candidateDigest}:TO:live-sandbox`,
      fetchImpl: production.fetchImpl,
      project,
      repositoryGate: async () => ({ gatsbyCommit: commit, workflowCommit: commit }),
      root: fixture,
      sleep: async () => undefined,
    })
    assert.equal(promotion.status, "verified")
    assert.equal(production.calls.filter((call) => call.method === "PUT").every((call) => call.token === "production-management-write-token"), true)
    assert.equal(production.calls.filter((call) => call.method === "GET" && call.token.includes("management")).every((call) => call.token === "production-management-read-token"), true)
    const storedPromotion = JSON.parse(await readFile(promotionJournalPath(fixture), "utf8")) as { status: string }
    assert.equal(storedPromotion.status, "verified")

    const workingEntry = JSON.parse(await readFile(path.join(fixture, "content/working/entries/basicPage/welcomePage.json"), "utf8")) as Record<string, unknown>
    const closed = await closeCycle({
      activation: {
        ...reviewActivation,
        cdaAttestation: { apiRoot: "https://cdn.contentful.com/spaces/demoSpace123/environments/preview-sandbox", environmentId: "preview-sandbox", host: "cdn.contentful.com", spaceId: "demoSpace123" },
        cdaToken: "preview-delivery-read-token",
        executionWorkflowCommit: commit,
      },
      fetchImpl: syncTransport(resources, workingEntry),
      processExists: () => false,
      project,
      repositoryGate: async () => ({ gatsbyCommit: commit, workflowCommit: commit }),
      root: fixture,
    })
    assert.equal(closed.status, "verified")
    assert.equal((await assertCompleteTree(path.join(fixture, "content/baseline"), project)).generationDigest, (await assertCompleteTree(path.join(fixture, "content/working"), project)).generationDigest)
    await assert.rejects(readFile(promotionCandidatePath(fixture)), /ENOENT/)
    await assert.rejects(readFile(promotionJournalPath(fixture)), /ENOENT/)
  } finally { await rm(fixture, { force: true, recursive: true }) }
})
