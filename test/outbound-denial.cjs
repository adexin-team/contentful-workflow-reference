"use strict"

const childProcess = require("node:child_process")
const dgram = require("node:dgram")
const dns = require("node:dns")
const fs = require("node:fs")
const http = require("node:http")
const http2 = require("node:http2")
const https = require("node:https")
const net = require("node:net")
const path = require("node:path")
const tls = require("node:tls")
const workerThreads = require("node:worker_threads")
const { promisify } = require("node:util")

const denied = () => { throw new Error("Outbound network is denied by the public reference test harness") }
globalThis.fetch = denied
http.request = denied; http.get = denied; https.request = denied; https.get = denied; http2.connect = denied
net.connect = denied; net.createConnection = denied; net.Socket.prototype.connect = denied; tls.connect = denied
dns.lookup = denied; dns.resolve = denied; dns.resolve4 = denied; dns.resolve6 = denied
for (const key of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"]) {
  if (typeof dns.promises[key] === "function") dns.promises[key] = denied
  if (typeof dns.Resolver.prototype[key] === "function") dns.Resolver.prototype[key] = denied
  if (typeof dns.promises.Resolver?.prototype[key] === "function") dns.promises.Resolver.prototype[key] = denied
}
dgram.createSocket = denied
for (const key of ["bind", "connect", "send"]) if (typeof dgram.Socket.prototype[key] === "function") dgram.Socket.prototype[key] = denied

const candidateRoot = path.resolve(__dirname, "..")
const modulesRoot = path.join(candidateRoot, "node_modules")
const preload = path.resolve(__filename)
const preloadOption = `--require=${preload}`
const callerNodeOptions = (process.env.NODE_OPTIONS || "").trim()
if (callerNodeOptions !== "" && callerNodeOptions !== preloadOption) throw new Error("Caller supplied incompatible NODE_OPTIONS; outbound denial must be the only preload")
process.env.NODE_OPTIONS = preloadOption
process.env.PUBLIC_REFERENCE_OUTBOUND_DENIAL = "active"

const harnessRoot = path.join(candidateRoot, ".tmp", "outbound-harness")
const harnessHome = path.join(harnessRoot, "home")
const emptyGitTemplate = path.join(harnessRoot, "empty-git-template")
fs.mkdirSync(harnessHome, { recursive: true, mode: 0o700 })
fs.mkdirSync(emptyGitTemplate, { recursive: true, mode: 0o700 })
const safePath = [...new Set([path.dirname(process.execPath), "/usr/bin", "/bin"])].join(path.delimiter)
const gitBinary = fs.existsSync("/usr/bin/git") ? "/usr/bin/git" : "git"
const tarBinary = fs.existsSync("/usr/bin/tar") ? "/usr/bin/tar" : "tar"
const exact = (args, expected) => args.length === expected.length && args.every((value, index) => value === expected[index])
const plainString = value => typeof value === "string" && value.length > 0 && !value.includes("\0")
const underOrEqual = (parent, candidate) => {
  if (!plainString(candidate)) return false
  const relative = path.relative(parent, path.resolve(candidate))
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
const strictArgument = value => plainString(value) && !/[\r\n]/.test(value) && !/^\w+:\/\//.test(value)
const candidateRelative = value => path.relative(candidateRoot, path.resolve(value)).split(path.sep).join("/")
const fixtureRelative = /^\.tmp\/reference-git-[A-Za-z0-9_-]+$/
const previewRunRelative = /^(?:\.tmp\/reference-git-[A-Za-z0-9_-]+\/)?\.tmp\/contentful-workflow\/gatsby-preview\/[a-f0-9-]{36}\/(?:gatsby-source\.tar|site)$/

function cleanEnvironment(incoming) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) throw new Error("Child environment must be one object")
  if ((incoming.NODE_OPTIONS === undefined ? preloadOption : incoming.NODE_OPTIONS) !== preloadOption) throw new Error("Child NODE_OPTIONS cannot remove or replace outbound denial")
  if ((incoming.PUBLIC_REFERENCE_OUTBOUND_DENIAL === undefined ? "active" : incoming.PUBLIC_REFERENCE_OUTBOUND_DENIAL) !== "active") throw new Error("Child cannot remove the outbound-denial marker")
  if (incoming.PATH !== undefined && incoming.PATH !== process.env.PATH && incoming.PATH !== safePath) throw new Error("Child PATH cannot replace executable resolution")
  const result = {}
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || /^(?:HOME|XDG_|GIT_|SSH_|GCM_|NODE_PATH|LD_|DYLD_|BASH_ENV|ENV$|CDPATH|GREP_OPTIONS|PAGER|LESS|MANPAGER|COREPACK_|NPM_CONFIG_USERCONFIG|ESBUILD_BINARY_PATH)/i.test(key)) continue
    if (/(?:TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(key)) continue
    result[key] = String(value)
  }
  return { ...result, HOME: harnessHome, XDG_CONFIG_HOME: path.join(harnessHome, "xdg"), PATH: safePath,
    NODE_OPTIONS: preloadOption, PUBLIC_REFERENCE_OUTBOUND_DENIAL: "active", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1", GIT_TEMPLATE_DIR: emptyGitTemplate, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false", GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "", GIT_AUTHOR_NAME: "Fictional Maintainer",
    GIT_AUTHOR_EMAIL: "fictional@example.invalid", GIT_COMMITTER_NAME: "Fictional Maintainer", GIT_COMMITTER_EMAIL: "fictional@example.invalid" }
}

function validatedOptions(options) {
  if (options === undefined) options = {}
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Child process options must be one object")
  if (options.shell !== undefined && options.shell !== false) throw new Error("Shell execution is denied by the outbound harness")
  const cwd = options.cwd === undefined ? process.cwd() : String(options.cwd)
  if (!underOrEqual(candidateRoot, cwd)) throw new Error("Child cwd is outside the public candidate")
  return { ...options, cwd, env: cleanEnvironment(options.env === undefined ? process.env : options.env) }
}

function safeGitRepository(cwd, allowMissing = false) {
  let gitRoot = path.resolve(cwd)
  while (gitRoot !== candidateRoot && !fs.existsSync(path.join(gitRoot, ".git"))) gitRoot = path.dirname(gitRoot)
  const relative = candidateRelative(gitRoot)
  if (!fixtureRelative.test(relative) && relative !== "") throw new Error("Git cwd is outside a controlled fixture repository")
  const config = path.join(gitRoot, ".git", "config")
  if (!fs.existsSync(config)) { if (allowMissing) return; throw new Error("Controlled Git repository config is missing") }
  const text = fs.readFileSync(config, "utf8")
  if (/hooksPath|template|filter|credential|proxy|ssh|url\.|insteadOf|fsmonitor|pager|external|diff\./i.test(text)) throw new Error("Controlled Git repository contains unsafe local configuration")
  for (const file of [path.join(gitRoot, ".gitattributes"), path.join(gitRoot, ".git", "info", "attributes")]) {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").trim() !== "") throw new Error("Controlled Git repository contains attributes that could activate filters")
  }
}

function safeGit(args, cwd) {
  if (["fetch", "pull", "push", "clone", "remote", "config", "commit", "add"].includes(args[0]) || args[0] === "-c" || args.some(value => /^--(?:config-env|exec-path|upload-pack|receive-pack|hooks-path)/.test(value))) return false
  const init = exact(args, ["init", "--quiet", "--initial-branch=main", `--template=${emptyGitTemplate}`])
  safeGitRepository(cwd, init)
  if (init) return true
  if (exact(args, ["rev-parse", "HEAD"]) || exact(args, ["rev-parse", "--show-toplevel"]) || exact(args, ["diff", "--cached", "--name-only"]) ||
      exact(args, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]) || exact(args, ["status", "--porcelain=v1", "--untracked-files=all"]) || exact(args, ["write-tree"])) return true
  if (args.length === 4 && exact(args.slice(0, 3), ["hash-object", "-w", "--no-filters"])) {
    const relative = args[3]; return strictArgument(relative) && !path.posix.isAbsolute(relative) && !relative.split("/").includes(".git") && underOrEqual(cwd, path.join(cwd, relative))
  }
  if (args.length === 4 && exact(args.slice(0, 2), ["update-index", "--add"]) && args[2] === "--cacheinfo") {
    return /^100644,[a-f0-9]{40},[A-Za-z0-9._/-]+$/.test(args[3]) && !args[3].split(",")[2].split("/").includes(".git")
  }
  if (args.length === 4 && args[0] === "commit-tree" && /^[a-f0-9]{40}$/.test(args[1]) && args[2] === "-m" && args[3] === "fictional fixture") return true
  if (args.length === 3 && args[0] === "update-ref" && args[1] === "refs/heads/main" && /^[a-f0-9]{40}$/.test(args[2])) return true
  if (args.length === 4 && exact(args.slice(0, 2), ["archive", "--format=tar"]) && args[2].startsWith("--output=") && previewRunRelative.test(candidateRelative(args[2].slice("--output=".length))) && /^[a-f0-9]{40}:gatsby-example$/.test(args[3])) return true
  if (args.length === 3 && exact(args.slice(0, 2), ["archive", "--format=tar"]) && /^[a-f0-9]{40}:gatsby-example$/.test(args[2])) return true
  return false
}

function safeNode(args) {
  const tsc = path.join(modulesRoot, "typescript/bin/tsc"); const gatsby = path.join(modulesRoot, "gatsby/cli.js"); const testFile = path.join(candidateRoot, "test/reference.test.ts")
  return exact(args, [tsc, "--noEmit"]) || exact(args, ["--import=tsx", "--test", testFile]) || exact(args, [gatsby, "build", "--prefix-paths", "--verbose"]) || exact(args, ["-e", "fetch('https://example.invalid').catch(() => process.exit(2))"])
}
function safeEsbuild(command, args) {
  const relative = path.relative(modulesRoot, path.resolve(command)).split(path.sep).join("/")
  return !relative.startsWith("../") && !path.isAbsolute(relative) && /(?:^|\/node_modules\/)@esbuild\/[a-z0-9_-]+\/bin\/esbuild$/.test(relative) &&
    /^--service=[0-9]+\.[0-9]+\.[0-9]+$/.test(args[0] || "") && (args.length === 1 || (args.length === 2 && args[1] === "--ping"))
}
function safeNativeTsc(command, args) {
  const relative = path.relative(modulesRoot, path.resolve(command)).split(path.sep).join("/")
  return /^@typescript\/typescript-[a-z0-9_-]+\/lib\/tsc$/.test(relative) && exact(args, ["--noEmit"])
}
function safeTar(args) {
  if (args.length !== 4 || args[0] !== "-xf" || args[2] !== "-C") return false
  const archive = candidateRelative(args[1]); const destination = candidateRelative(args[3])
  return previewRunRelative.test(archive) && previewRunRelative.test(destination) && path.posix.dirname(archive) === path.posix.dirname(destination) && archive.endsWith("/gatsby-source.tar") && destination.endsWith("/site")
}
function assertLocalCommand(command, args, cwd) {
  if (!plainString(command) || !Array.isArray(args) || !args.every(strictArgument)) throw new Error("Child command is denied unless command and arguments are explicit safe strings")
  if (path.resolve(command) === path.resolve(process.execPath) && safeNode(args)) return command
  if (path.isAbsolute(command) && safeEsbuild(command, args)) return command
  if (path.isAbsolute(command) && safeNativeTsc(command, args)) return command
  if ((command === "git" || path.resolve(command) === path.resolve(gitBinary)) && safeGit(args, cwd)) return gitBinary
  if ((command === "tar" || path.resolve(command) === path.resolve(tarBinary)) && safeTar(args)) return tarBinary
  throw new Error(`Spawned command is denied by the outbound harness: ${path.basename(command)} ${args.join(" ")}`)
}
function normalizedInvocation(args, options) {
  if (args === undefined) return { args: [], options }
  if (!Array.isArray(args)) throw new Error("Child arguments must be one explicit array")
  return { args: args.map(String), options }
}
for (const method of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
  const original = childProcess[method]
  const guarded = function guarded(command, args, options, ...rest) {
    const invocation = normalizedInvocation(args, options); const protectedOptions = validatedOptions(invocation.options)
    const protectedCommand = assertLocalCommand(command, invocation.args, protectedOptions.cwd)
    return original.call(this, protectedCommand, invocation.args, protectedOptions, ...rest)
  }
  if (original[promisify.custom]) Object.defineProperty(guarded, promisify.custom, { value: function(command, args, options) {
    const invocation = normalizedInvocation(args, options); const protectedOptions = validatedOptions(invocation.options)
    const protectedCommand = assertLocalCommand(command, invocation.args, protectedOptions.cwd)
    return original[promisify.custom](protectedCommand, invocation.args, protectedOptions)
  } })
  childProcess[method] = guarded
}
childProcess.exec = function deniedExec() { throw new Error("Shell commands are denied by the outbound harness") }
childProcess.execSync = function deniedExecSync() { throw new Error("Shell commands are denied by the outbound harness") }

function allowedGatsbyWorkerModule(value) {
  if (!plainString(value) || !underOrEqual(path.join(modulesRoot, "gatsby/dist"), value)) return false
  const relative = path.relative(path.join(modulesRoot, "gatsby/dist"), path.resolve(value)).split(path.sep).join("/")
  return ["utils/parcel/compile-gatsby-files.js", "utils/validate-engines/child.js", "utils/worker/child/index.js", "utils/dev-ssr/render-dev-html-child.js"].includes(relative)
}
function safeFork(modulePath, args, options) {
  const absolute = path.resolve(modulePath)
  if (absolute === path.join(modulesRoot, "gatsby-worker/dist/child.js")) {
    if (args.length !== 0 || !allowedGatsbyWorkerModule(options.env.GATSBY_WORKER_MODULE_PATH)) return false
    return /^\d+$/.test(options.env.GATSBY_WORKER_ID || "") && /^\/.*gatsby-worker.*\/worker-\d+\.json$/.test(options.env.GATSBY_WORKER_IN_FLIGHT_DUMP_LOCATION || "")
  }
  if (absolute === path.join(modulesRoot, "@parcel/workers/lib/process/ProcessChild.js")) return exact(args, process.argv.map(String))
  const relative = path.relative(modulesRoot, absolute).split(path.sep).join("/")
  return /(?:^|\/node_modules\/)jest-worker\/build\/workers\/(?:processChild|threadChild)\.js$/.test(relative) && args.length === 0
}
const originalFork = childProcess.fork
childProcess.fork = function guardedFork(modulePath, args, options) {
  if (!plainString(modulePath)) throw new Error("Spawned fork is denied by the outbound harness")
  const invocation = args && typeof args === "object" && !Array.isArray(args) && options === undefined ? { args: [], options: args } : normalizedInvocation(args, options)
  const protectedOptions = validatedOptions(invocation.options)
  if (protectedOptions.execPath !== undefined && path.resolve(String(protectedOptions.execPath)) !== path.resolve(process.execPath)) throw new Error("Fork execPath cannot replace Node")
  if (protectedOptions.execArgv !== undefined && (!Array.isArray(protectedOptions.execArgv) || !exact(protectedOptions.execArgv.map(String), process.execArgv.filter(value => !/^--(?:debug|inspect)/.test(value))))) throw new Error("Fork execArgv cannot inject child code")
  if (!safeFork(modulePath, invocation.args, protectedOptions) || !fs.existsSync(modulePath) || !fs.statSync(modulePath).isFile()) throw new Error("Spawned fork is denied by the outbound harness")
  return originalFork.call(this, modulePath, invocation.args, protectedOptions)
}

function safeWorkerEntry(filename) {
  if (!plainString(filename) || /^\w+:|^data:/i.test(filename)) return false
  const absolute = path.resolve(filename)
  if (absolute === path.join(candidateRoot, "test/worker-network-probe.cjs")) return true
  const relative = path.relative(modulesRoot, absolute).split(path.sep).join("/")
  return relative === "@parcel/workers/lib/threads/ThreadsChild.js" || /(?:^|\/)jest-worker\/build\/workers\/threadChild\.js$/.test(relative)
}
function safeWorkerValue(value) {
  if (typeof value === "string") return !/^\w+:\/\//.test(value) && (!path.isAbsolute(value) || underOrEqual(candidateRoot, value))
  if (value === null || ["number", "boolean", "undefined"].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(safeWorkerValue)
  if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.entries(value).every(([key, item]) => /^[A-Za-z0-9_]+$/.test(key) && safeWorkerValue(item))
  return false
}
const OriginalWorker = workerThreads.Worker
class GuardedWorker extends OriginalWorker {
  constructor(filename, options = {}) {
    if (!safeWorkerEntry(filename) || !options || typeof options !== "object" || Array.isArray(options)) throw new Error("Worker entrypoint is denied by the outbound harness")
    if (options.eval || options.stdin || options.type === "module" || (options.argv !== undefined && (!Array.isArray(options.argv) || !options.argv.every(strictArgument)))) throw new Error("Worker eval, loader, stdin, URL, and custom argument shapes are denied")
    if (options.workerData !== undefined && !safeWorkerValue(options.workerData)) throw new Error("Worker data contains an unsafe path or value")
    if (options.env !== undefined && options.env !== workerThreads.SHARE_ENV && options.env !== process.env) throw new Error("Worker custom environment is denied; it may only inherit the protected environment")
    const expectedExecArgv = process.execArgv.filter(value => !/^--(?:debug|inspect)/.test(value))
    if (options.execArgv !== undefined && (!Array.isArray(options.execArgv) || !exact(options.execArgv.map(String), expectedExecArgv))) throw new Error("Worker execArgv cannot remove the preload or inject a loader")
    const inherited = { ...options, env: workerThreads.SHARE_ENV }
    delete inherited.execArgv
    super(filename, inherited)
  }
}
workerThreads.Worker = GuardedWorker
