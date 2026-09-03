"use strict"

const Module = require("node:module")
const path = require("node:path")

const SPACE_ID = process.env.CONTENTFUL_SPACE_ID
const ENVIRONMENT_ID = process.env.CONTENTFUL_ENVIRONMENT
const DELIVERY_HOST = "cdn.contentful.com"
if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(SPACE_ID || "") || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(ENVIRONMENT_ID || "")) {
  throw new Error("Profile-bound legacy adapter requires valid injected target identifiers")
}
const originalLoad = Module._load

Module._load = function loadWithProfileBoundPublishedPreview(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain)
  if (request !== "contentful" || typeof parent?.filename !== "string" || !parent.filename.includes(`${path.sep}gatsby-source-contentful${path.sep}`)) return loaded
  if (!loaded || typeof loaded.createClient !== "function") throw new Error("Legacy Gatsby Contentful adapter found an unsupported SDK")
  return { ...loaded, createClient(options) {
    if (options?.host !== DELIVERY_HOST || options?.space !== SPACE_ID || options?.environment !== ENVIRONMENT_ID) {
      throw new Error("Legacy Gatsby Contentful adapter refused a non-profile preview target")
    }
    const client = loaded.createClient(options)
    return new Proxy(client, { get(target, property, receiver) {
      if (property === "getSpace") return async () => ({ sys: { id: SPACE_ID, type: "Space" } })
      return Reflect.get(target, property, receiver)
    } })
  } }
}
