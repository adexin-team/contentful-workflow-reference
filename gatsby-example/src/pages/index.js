import React from "react"
import site from "../../data/site.json"

export default function IndexPage() {
  return React.createElement("main", null,
    React.createElement("h1", null, site.title),
    React.createElement("p", null, site.description),
  )
}
