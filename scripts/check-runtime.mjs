const MINIMUM = [20, 19, 0]
const EXCLUSIVE_MAXIMUM_MAJOR = 25

export function parseNodeVersion(value) {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value)
  if (!match) throw new Error(`Malformed Node.js version: ${value}`)
  return match.slice(1).map(Number)
}

export function isSupportedNodeVersion(value) {
  const [major, minor, patch] = parseNodeVersion(value)
  if (major > MINIMUM[0] && major < EXCLUSIVE_MAXIMUM_MAJOR) return true
  if (major !== MINIMUM[0]) return false
  return minor > MINIMUM[1] || (minor === MINIMUM[1] && patch >= MINIMUM[2])
}

export function assertSupportedNodeVersion(value = process.version) {
  if (!isSupportedNodeVersion(value)) {
    throw new Error(`Unsupported Node.js ${value}; use >=20.19.0 <25`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertSupportedNodeVersion()
}
import { pathToFileURL } from "node:url"
