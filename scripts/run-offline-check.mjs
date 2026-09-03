import { spawnSync } from "node:child_process"
import { readFileSync, rmSync } from "node:fs"
import path from "node:path"

if (process.env.PUBLIC_REFERENCE_OUTBOUND_DENIAL !== "active") throw new Error("Outbound denial preload was not active before checks")
const root = path.resolve(import.meta.dirname, "..")
const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|CONTENTFUL|NODE_TEST)/i.test(key)))
Object.assign(cleanEnvironment, { CI: "1", ESBUILD_WORKER_THREADS: "0", GATSBY_TELEMETRY_DISABLED: "1", GATSBY_UPDATE_NOTIFIER: "false", NODE_ENV: "test", PUBLIC_REFERENCE_GATSBY_OFFLINE: "1", PUBLIC_REFERENCE_OUTBOUND_DENIAL: "active" })
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, env: cleanEnvironment, stdio: "inherit" })
  if (result.status !== 0) throw new Error(`Offline check failed: node ${args.join(" ")}`)
}

function typecheck() { run([path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit"]) }
function tests() { run(["--import=tsx", "--test", path.join(root, "test/reference.test.ts")]) }
function gatsby() {
  const gatsbyRoot = path.join(root, "gatsby-example")
  rmSync(path.join(gatsbyRoot, ".cache"), { force: true, recursive: true })
  rmSync(path.join(gatsbyRoot, "public"), { force: true, recursive: true })
  run([path.join(root, "node_modules/gatsby/cli.js"), "build", "--prefix-paths", "--verbose"], gatsbyRoot)
  if (readFileSync(path.join(gatsbyRoot, "public/.gatsby-smoke-build"), "utf8") !== "Gatsby onPostBuild completed.\n") throw new Error("Gatsby did not complete its real onPostBuild lifecycle")
}

const mode = process.argv[2]
if (mode === "typecheck") typecheck()
else if (mode === "test") tests()
else if (mode === "gatsby") gatsby()
else if (mode === "check") { typecheck(); tests(); gatsby() }
else throw new Error("Offline runner requires one exact mode: typecheck, test, gatsby, or check")
console.log(`${mode} passed with outbound denial active.`)
