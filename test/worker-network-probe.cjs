"use strict"

const { parentPort } = require("node:worker_threads")

if (process.env.PUBLIC_REFERENCE_OUTBOUND_DENIAL !== "active") throw new Error("Worker did not inherit the outbound-denial marker")
try {
  fetch("https://example.invalid")
  throw new Error("Worker network operation unexpectedly returned")
} catch (error) {
  if (!/Outbound network is denied/.test(String(error))) throw error
  parentPort.postMessage("denied")
}
