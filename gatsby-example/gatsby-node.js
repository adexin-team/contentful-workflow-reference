const { writeFile } = require("node:fs/promises")
const path = require("node:path")

exports.onPostBuild = async function onPostBuild({ store }) {
  const directory = store.getState().program.directory
  await writeFile(path.join(directory, "public", ".gatsby-smoke-build"), "Gatsby onPostBuild completed.\n", { flag: "wx" })
}
