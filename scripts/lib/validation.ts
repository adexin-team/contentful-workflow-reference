import {
  assertExactKeys,
  assertExactLink,
  assertRecord,
  assertSafeId,
  isNonEmpty,
} from "./core.js"
import type { GenerationResources } from "./generation.js"
import type { ProjectConfig } from "./types.js"

const FIELD_TYPES = new Set([
  "Array",
  "Boolean",
  "Date",
  "Integer",
  "Link",
  "Location",
  "Number",
  "Object",
  "RichText",
  "Symbol",
  "Text",
])

function assertValidations(value: unknown, label: string): Array<Record<string, unknown>> {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label}.validations must be an array`)
  return value.map((validation, index) => assertRecord(validation, `${label}.validations[${index}]`))
}

function assertFieldShape(field: Record<string, unknown>, label: string): void {
  if (typeof field.name !== "string" || field.name.length === 0) {
    throw new Error(`${label} has an invalid name`)
  }
  if (typeof field.type !== "string" || !FIELD_TYPES.has(field.type)) {
    throw new Error(`${label} has an unsupported type: ${String(field.type)}`)
  }
  for (const flag of ["localized", "required", "disabled", "omitted"] as const) {
    if (typeof field[flag] !== "boolean") throw new Error(`${label} has an invalid ${flag} flag`)
  }
  assertValidations(field.validations, label)
  if (field.type === "Link") {
    if (field.linkType !== "Entry" && field.linkType !== "Asset") {
      throw new Error(`${label} has an unsupported Link resource type`)
    }
  }
  if (field.type === "Array") {
    const items = assertRecord(field.items, `${label}.items`)
    if (items.type !== "Symbol" && items.type !== "Link") {
      throw new Error(`${label}.items has an unsupported type: ${String(items.type)}`)
    }
    assertValidations(items.validations, `${label}.items`)
    if (items.type === "Link" && items.linkType !== "Entry" && items.linkType !== "Asset") {
      throw new Error(`${label}.items has an unsupported Link resource type`)
    }
  }
}

export function entryContentType(entry: Record<string, unknown>, entryId: string): string {
  const sys = assertRecord(entry.sys, `Entry ${entryId}.sys`)
  const label = `Entry ${entryId} content type`
  return assertExactLink(sys.contentType, "ContentType", label)
}

export function entryFields(
  entry: Record<string, unknown>,
  entryId: string,
): Record<string, unknown> {
  return assertRecord(entry.fields, `Entry ${entryId}.fields`)
}

export function contentTypeFields(
  contentType: Record<string, unknown>,
  typeId: string,
): Array<Record<string, unknown>> {
  if (!Array.isArray(contentType.fields)) throw new Error(`Content Type ${typeId}.fields must be an array`)
  const seen = new Set<string>()
  return contentType.fields.map((field, index) => {
    const record = assertRecord(field, `Content Type ${typeId}.fields[${index}]`)
    const fieldId = assertSafeId(record.id, `Content Type ${typeId} field ID`)
    if (seen.has(fieldId)) throw new Error(`Content Type ${typeId} has duplicate field ID: ${fieldId}`)
    seen.add(fieldId)
    assertFieldShape(record, `Content Type ${typeId} field ${fieldId}`)
    return record
  })
}

function validationBound(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`)
  }
  return value
}

const RICH_TEXT_BLOCKS = new Set([
  "blockquote",
  "embedded-asset-block",
  "embedded-entry-block",
  "heading-1",
  "heading-2",
  "heading-3",
  "heading-4",
  "heading-5",
  "heading-6",
  "hr",
  "ordered-list",
  "paragraph",
  "table",
  "unordered-list",
])
const RICH_TEXT_INLINE = new Set([
  "asset-hyperlink",
  "embedded-entry-inline",
  "entry-hyperlink",
  "hyperlink",
  "text",
])
const RICH_TEXT_VOID = new Set([
  "embedded-asset-block",
  "embedded-entry-block",
  "embedded-entry-inline",
  "hr",
])
const RICH_TEXT_MARKS = new Set([
  "bold",
  "code",
  "italic",
  "strikethrough",
  "subscript",
  "superscript",
  "underline",
])
const RICH_TEXT_LIST_ITEM_BLOCKS = new Set([
  "blockquote",
  "embedded-asset-block",
  "embedded-entry-block",
  "heading-1",
  "heading-2",
  "heading-3",
  "heading-4",
  "heading-5",
  "heading-6",
  "hr",
  "ordered-list",
  "paragraph",
  "unordered-list",
])
const RICH_TEXT_TOGGLEABLE_NODES = new Set([
  "asset-hyperlink",
  "blockquote",
  "embedded-asset-block",
  "embedded-entry-block",
  "embedded-entry-inline",
  "entry-hyperlink",
  "heading-1",
  "heading-2",
  "heading-3",
  "heading-4",
  "heading-5",
  "heading-6",
  "hr",
  "ordered-list",
  "table",
  "unordered-list",
])

function richTextChildren(nodeType: string): Set<string> {
  if (nodeType === "document") return RICH_TEXT_BLOCKS
  if (nodeType === "blockquote") return new Set(["paragraph"])
  if (nodeType === "list-item") return RICH_TEXT_LIST_ITEM_BLOCKS
  if (nodeType === "ordered-list" || nodeType === "unordered-list") return new Set(["list-item"])
  if (nodeType === "table") return new Set(["table-row"])
  if (nodeType === "table-row") return new Set(["table-cell", "table-header-cell"])
  if (nodeType === "table-cell") return new Set(["paragraph"])
  if (nodeType === "table-header-cell") return new Set(["paragraph"])
  if (nodeType === "paragraph" || nodeType.startsWith("heading-")) return RICH_TEXT_INLINE
  if (nodeType === "hyperlink" || nodeType === "entry-hyperlink" || nodeType === "asset-hyperlink") {
    return new Set(["text"])
  }
  return new Set()
}

function assertRichTextNode(
  value: unknown,
  resources: GenerationResources,
  label: string,
  expectedTypes: Set<string>,
  requireResolvedLinks: boolean,
): void {
  const node = assertRecord(value, label)
  if (typeof node.nodeType !== "string" || !expectedTypes.has(node.nodeType)) {
    throw new Error(`${label} has an unsupported RichText node type: ${String(node.nodeType)}`)
  }
  const nodeType = node.nodeType
  if (nodeType === "text") {
    assertExactKeys(node, ["data", "marks", "nodeType", "value"], label)
    const data = assertRecord(node.data, `${label}.data`)
    assertExactKeys(data, [], `${label}.data`)
    if (typeof node.value !== "string") throw new Error(`${label}.value must be a string`)
    if (!Array.isArray(node.marks)) throw new Error(`${label}.marks must be an array`)
    const seenMarks = new Set<string>()
    node.marks.forEach((mark, index) => {
      const record = assertRecord(mark, `${label}.marks[${index}]`)
      assertExactKeys(record, ["type"], `${label}.marks[${index}]`)
      if (typeof record.type !== "string" || !RICH_TEXT_MARKS.has(record.type)) {
        throw new Error(`${label}.marks[${index}] has an unsupported type`)
      }
      if (seenMarks.has(record.type)) throw new Error(`${label} has a duplicate mark: ${record.type}`)
      seenMarks.add(record.type)
    })
    return
  }

  assertExactKeys(node, ["content", "data", "nodeType"], label)
  const data = assertRecord(node.data, `${label}.data`)
  if (!Array.isArray(node.content)) throw new Error(`${label}.content must be an array`)
  const entryNodes = new Set(["embedded-entry-block", "embedded-entry-inline", "entry-hyperlink"])
  const assetNodes = new Set(["embedded-asset-block", "asset-hyperlink"])
  if (nodeType === "hyperlink") {
    assertExactKeys(data, ["uri"], `${label}.data`)
    if (typeof data.uri !== "string" || data.uri.length === 0) {
      throw new Error(`${label}.data.uri must be a non-empty string`)
    }
  } else if (entryNodes.has(nodeType)) {
    assertExactKeys(data, ["target"], `${label}.data`)
    assertLinkValue(data.target, "Entry", resources, `${label}.data.target`, requireResolvedLinks)
  } else if (assetNodes.has(nodeType)) {
    assertExactKeys(data, ["target"], `${label}.data`)
    assertLinkValue(data.target, "Asset", resources, `${label}.data.target`, requireResolvedLinks)
  } else {
    assertExactKeys(data, [], `${label}.data`)
  }
  if (RICH_TEXT_VOID.has(nodeType) && node.content.length !== 0) {
    throw new Error(`${label}.content must be empty`)
  }
  if (
    new Set(["table", "table-cell", "table-header-cell", "table-row"]).has(nodeType) &&
    node.content.length === 0
  ) {
    throw new Error(`${label}.content must contain at least one node`)
  }
  const expectedChildren = richTextChildren(nodeType)
  node.content.forEach((child, index) => {
    assertRichTextNode(child, resources, `${label}.content[${index}]`, expectedChildren, requireResolvedLinks)
  })
}

function assertRichText(
  value: unknown,
  resources: GenerationResources,
  label: string,
  requireResolvedLinks: boolean,
): void {
  assertRichTextNode(value, resources, label, new Set(["document"]), requireResolvedLinks)
}

function richTextRecords(
  value: unknown,
  label: string,
  visit: (node: Record<string, unknown>, nodeLabel: string) => void,
): void {
  const node = assertRecord(value, label)
  visit(node, label)
  if (!Array.isArray(node.content)) return
  node.content.forEach((child, index) => {
    richTextRecords(child, `${label}.content[${index}]`, visit)
  })
}

function allowedStrings(value: unknown, allowed: Set<string>, label: string): Set<string> {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !allowed.has(item))) {
    throw new Error(`${label} must contain only supported values`)
  }
  const result = new Set(value as string[])
  if (result.size !== value.length) throw new Error(`${label} must not contain duplicates`)
  return result
}

function assertRichTextValidation(
  value: unknown,
  validationKey: string,
  validationValue: unknown,
  resources: GenerationResources,
  label: string,
): void {
  if (validationKey === "enabledMarks") {
    const enabled = allowedStrings(validationValue, RICH_TEXT_MARKS, `${label} enabledMarks validation`)
    richTextRecords(value, label, (node, nodeLabel) => {
      if (node.nodeType !== "text" || !Array.isArray(node.marks)) return
      for (const mark of node.marks) {
        const type = assertRecord(mark, `${nodeLabel} mark`).type
        if (typeof type !== "string" || !enabled.has(type)) {
          throw new Error(`${nodeLabel} uses a mark disabled by its Content Type`)
        }
      }
    })
    return
  }
  if (validationKey === "enabledNodeTypes") {
    const enabled = allowedStrings(
      validationValue,
      RICH_TEXT_TOGGLEABLE_NODES,
      `${label} enabledNodeTypes validation`,
    )
    richTextRecords(value, label, (node, nodeLabel) => {
      if (typeof node.nodeType === "string" &&
          RICH_TEXT_TOGGLEABLE_NODES.has(node.nodeType) &&
          !enabled.has(node.nodeType)) {
        throw new Error(`${nodeLabel} uses a node type disabled by its Content Type`)
      }
    })
    return
  }
  if (validationKey === "nodes") {
    const nodes = assertRecord(validationValue, `${label} nodes validation`)
    const entryNodes = new Set(["embedded-entry-block", "embedded-entry-inline", "entry-hyperlink"])
    const assetNodes = new Set(["asset-hyperlink", "embedded-asset-block"])
    for (const [nodeType, nestedValue] of Object.entries(nodes)) {
      const nested = assertValidations(nestedValue, `${label} nodes.${nodeType}`)
      if (assetNodes.has(nodeType)) {
        if (nested.length > 0) {
          throw new Error(`${label} has an unsupported Asset node validation: ${nodeType}`)
        }
        continue
      }
      if (!entryNodes.has(nodeType)) {
        throw new Error(`${label} has an unsupported RichText nodes validation: ${nodeType}`)
      }
      for (const constraint of nested) {
        const keys = Object.keys(constraint)
        if (keys.length !== 1 || keys[0] !== "linkContentType") {
          throw new Error(`${label} has an unsupported RichText node validation: ${nodeType}`)
        }
        if (
          !Array.isArray(constraint.linkContentType) ||
          constraint.linkContentType.some((typeId) => typeof typeId !== "string")
        ) {
          throw new Error(`${label} has a malformed RichText linkContentType validation`)
        }
        const allowedTypes = new Set(constraint.linkContentType as string[])
        richTextRecords(value, label, (node, nodeLabel) => {
          if (node.nodeType !== nodeType) return
          const data = assertRecord(node.data, `${nodeLabel}.data`)
          const linkedEntryId = assertLinkValue(data.target, "Entry", resources, `${nodeLabel}.data.target`)
          const linkedEntry = resources.entries.get(linkedEntryId) as Record<string, unknown>
          if (!allowedTypes.has(entryContentType(linkedEntry, linkedEntryId))) {
            throw new Error(`${nodeLabel} links to a disallowed Content Type`)
          }
        })
      }
    }
    return
  }
  throw new Error(`${label} has an unsupported RichText validation: ${validationKey}`)
}

function assertContentfulDate(value: unknown, label: string): void {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO 8601 Date string`)
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(value)
  if (!match) throw new Error(`${label} must be an ISO 8601 Date string`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysPerMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > (daysPerMonth[month - 1] ?? 0)) {
    throw new Error(`${label} must be a calendar-valid ISO 8601 Date string`)
  }
  if (match[4] !== undefined) {
    const hour = Number(match[4])
    const minute = Number(match[5])
    const second = match[6] === undefined ? 0 : Number(match[6])
    const zone = match[8] as string
    const zoneHour = zone === "Z" ? 0 : Number(zone.slice(1, 3))
    const zoneMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6))
    if (hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59 || Number.isNaN(Date.parse(value))) {
      throw new Error(`${label} must be a valid ISO 8601 Date string`)
    }
  }
}

function applyDirectValidations(
  value: unknown,
  definition: Record<string, unknown>,
  resources: GenerationResources,
  label: string,
  linkedEntryId?: string,
  strict = false,
): void {
  for (const validation of assertValidations(definition.validations, label)) {
    const validationKeys = Object.keys(validation)
    if (strict && validationKeys.length !== 1) {
      throw new Error(`${label} has an unsupported validation object shape`)
    }
    const validationKey = validationKeys[0]
    let handled = false
    if (validation.in !== undefined && ["string", "number", "boolean"].includes(typeof value)) {
      handled = true
      if (
        !Array.isArray(validation.in) ||
        (strict && validation.in.some((allowed) => !["string", "number", "boolean"].includes(typeof allowed))) ||
        !validation.in.some((allowed) => Object.is(allowed, value))
      ) {
        throw new Error(`${label} is outside its allowed values`)
      }
    }
    if (validation.range !== undefined && typeof value === "number") {
      handled = true
      const range = assertRecord(validation.range, `${label} range validation`)
      const rangeKeys = ["max", "min"].filter((key) => range[key] !== undefined)
      if (strict) {
        if (rangeKeys.length === 0) throw new Error(`${label} has an empty range validation`)
        assertExactKeys(range, rangeKeys, `${label} range validation`)
      }
      const minimum = validationBound(range.min, `${label} range minimum`)
      const maximum = validationBound(range.max, `${label} range maximum`)
      if ((minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum)) {
        throw new Error(`${label} is outside its allowed range`)
      }
    }
    if (validation.size !== undefined && (typeof value === "string" || Array.isArray(value))) {
      handled = true
      const size = assertRecord(validation.size, `${label} size validation`)
      const sizeKeys = ["max", "min"].filter((key) => size[key] !== undefined)
      if (strict) {
        if (sizeKeys.length === 0) throw new Error(`${label} has an empty size validation`)
        assertExactKeys(size, sizeKeys, `${label} size validation`)
      }
      const minimum = validationBound(size.min, `${label} size minimum`)
      const maximum = validationBound(size.max, `${label} size maximum`)
      const length = typeof value === "string" ? Array.from(value).length : value.length
      if ((minimum !== undefined && length < minimum) || (maximum !== undefined && length > maximum)) {
        throw new Error(`${label} has a disallowed size`)
      }
    }
    if (validation.regexp !== undefined && typeof value === "string") {
      handled = true
      const regexp = assertRecord(validation.regexp, `${label} regexp validation`)
      const keys = regexp.flags === undefined ? ["pattern"] : ["flags", "pattern"]
      assertExactKeys(regexp, keys, `${label} regexp validation`)
      if (typeof regexp.pattern !== "string") {
        throw new Error(`${label} has a malformed regexp validation pattern`)
      }
      if (regexp.flags !== undefined && regexp.flags !== null && typeof regexp.flags !== "string") {
        throw new Error(`${label} has malformed regexp validation flags`)
      }
      let pattern: RegExp
      try {
        pattern = new RegExp(regexp.pattern, typeof regexp.flags === "string" ? regexp.flags : undefined)
      } catch {
        throw new Error(`${label} has a malformed regexp validation`)
      }
      if (!pattern.test(value)) throw new Error(`${label} does not match its regexp validation`)
    }
    if (validation.linkContentType !== undefined && linkedEntryId !== undefined) {
      handled = true
      if (
        !Array.isArray(validation.linkContentType) ||
        validation.linkContentType.some((typeId) => typeof typeId !== "string")
      ) {
        throw new Error(`${label} has a malformed linkContentType validation`)
      }
      const linkedEntry = resources.entries.get(linkedEntryId)
      if (
        linkedEntry &&
        !(validation.linkContentType as string[]).includes(entryContentType(linkedEntry, linkedEntryId))
      ) {
        throw new Error(`${label} links to a disallowed Content Type`)
      }
    }
    if (
      strict &&
      definition.type === "RichText" &&
      typeof validationKey === "string" &&
      ["enabledMarks", "enabledNodeTypes", "nodes"].includes(validationKey)
    ) {
      assertRichTextValidation(value, validationKey, validation[validationKey], resources, label)
      handled = true
    }
    if (strict && !handled) {
      throw new Error(`${label} has an unsupported validation: ${String(validationKey)}`)
    }
  }
}

function assertLinkValue(
  value: unknown,
  expectedLinkType: "Entry" | "Asset",
  resources: GenerationResources,
  label: string,
  requireResolved = true,
): string {
  const wrapper = assertRecord(value, label)
  const id = assertExactLink(wrapper, expectedLinkType, label)
  if (requireResolved && expectedLinkType === "Entry" && !resources.entries.has(id)) {
    throw new Error(`${label} has an unresolved Entry link: ${id}`)
  }
  if (requireResolved && expectedLinkType === "Asset" && !resources.assets.has(id)) {
    throw new Error(`${label} has an unresolved Asset link: ${id}`)
  }
  return id
}

function assertFieldValue(
  value: unknown,
  definition: Record<string, unknown>,
  resources: GenerationResources,
  label: string,
  strictValidations = false,
  requireResolvedLinks = true,
): void {
  switch (definition.type) {
    case "Symbol":
    case "Text":
      if (typeof value !== "string") throw new Error(`${label} must be a string`)
      break
    case "Date":
      assertContentfulDate(value, label)
      break
    case "Integer":
      if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an Integer`)
      break
    case "Number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${label} must be a finite number`)
      }
      break
    case "Boolean":
      if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`)
      break
    case "Object":
      if (!value || typeof value !== "object") {
        throw new Error(`${label} must be a JSON object or array`)
      }
      break
    case "RichText":
      assertRichText(value, resources, label, requireResolvedLinks)
      break
    case "Location": {
      const location = assertRecord(value, label)
      if (
        typeof location.lat !== "number" ||
        !Number.isFinite(location.lat) ||
        typeof location.lon !== "number" ||
        !Number.isFinite(location.lon)
      ) {
        throw new Error(`${label} must be a Location`)
      }
      break
    }
    case "Link": {
      const expectedLinkType = definition.linkType as "Entry" | "Asset"
      const linkedEntryId = assertLinkValue(value, expectedLinkType, resources, label, requireResolvedLinks)
      applyDirectValidations(
        value,
        definition,
        resources,
        label,
        expectedLinkType === "Entry" ? linkedEntryId : undefined,
        strictValidations,
      )
      return
    }
    case "Array": {
      if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
      const items = assertRecord(definition.items, `${label} item definition`)
      value.forEach((item, index) =>
        assertFieldValue(
          item,
          items,
          resources,
          `${label}[${index}]`,
          strictValidations,
          requireResolvedLinks,
        ))
      break
    }
    default:
      throw new Error(`${label} uses an unsupported field type`)
  }
  applyDirectValidations(value, definition, resources, label, undefined, strictValidations)
}

export function validateChangedFieldValue(
  resources: GenerationResources,
  typeId: string,
  fieldId: string,
  value: unknown,
  label: string,
): void {
  const contentType = resources.contentTypes.get(typeId)
  if (!contentType) throw new Error(`Content Type metadata is missing: ${typeId}`)
  const definition = contentTypeFields(contentType, typeId)
    .find((field) => field.id === fieldId)
  if (!definition) throw new Error(`${label} is absent from Content Type ${typeId}`)
  assertFieldValue(value, definition, resources, label, true)
}

export function usedLocaleCodes(resources: GenerationResources, project: ProjectConfig): Set<string> {
  const used = new Set<string>([project.defaultLocale])
  for (const [entryId, entry] of resources.entries) {
    for (const [fieldId, localized] of Object.entries(entryFields(entry, entryId))) {
      const values = assertRecord(localized, `Entry ${entryId} field ${fieldId}`)
      Object.keys(values).forEach((locale) => used.add(assertSafeId(locale, "Locale code")))
    }
  }
  for (const [assetId, asset] of resources.assets) {
    const fields = assertRecord(asset.fields, `Asset ${assetId}.fields`)
    for (const [fieldId, localized] of Object.entries(fields)) {
      const values = assertRecord(localized, `Asset ${assetId} field ${fieldId}`)
      Object.keys(values).forEach((locale) => used.add(assertSafeId(locale, "Locale code")))
    }
  }
  return used
}

export function referencedContentTypeIds(resources: GenerationResources): Set<string> {
  return new Set(
    [...resources.entries].map(([entryId, entry]) => entryContentType(entry, entryId)),
  )
}

export function validateGenerationResources(
  resources: GenerationResources,
  project: ProjectConfig,
): void {
  if (!resources.locales.has(project.defaultLocale)) {
    throw new Error(`Default locale metadata is missing: ${project.defaultLocale}`)
  }
  if (resources.locales.get(project.defaultLocale)?.default !== true) {
    throw new Error(`Configured default locale is not marked default: ${project.defaultLocale}`)
  }
  for (const [localeCode, locale] of resources.locales) {
    if (localeCode !== project.defaultLocale && locale.default === true) {
      throw new Error(`Unexpected additional default locale: ${localeCode}`)
    }
  }
  const referencedTypes = referencedContentTypeIds(resources)
  for (const typeId of referencedTypes) {
    if (!resources.contentTypes.has(typeId)) throw new Error(`Content Type metadata is missing: ${typeId}`)
  }
  for (const typeId of resources.contentTypes.keys()) {
    if (!referencedTypes.has(typeId)) throw new Error(`Unreferenced Content Type metadata remains: ${typeId}`)
  }

  const localeCodes = new Set(resources.locales.keys())
  for (const locale of usedLocaleCodes(resources, project)) {
    if (!localeCodes.has(locale)) throw new Error(`Locale metadata is missing: ${locale}`)
  }

  for (const [entryId, entry] of resources.entries) {
    const typeId = entryContentType(entry, entryId)
    const contentType = resources.contentTypes.get(typeId) as Record<string, unknown>
    const fields = entryFields(entry, entryId)
    const definitions = new Map(
      contentTypeFields(contentType, typeId).map((field) => [field.id as string, field]),
    )
    for (const fieldId of Object.keys(fields)) {
      if (!definitions.has(fieldId)) {
        throw new Error(`Entry ${entryId} has a field absent from Content Type ${typeId}: ${fieldId}`)
      }
    }
    for (const [fieldId, field] of definitions) {
      const localized = fields[fieldId]
      const values = localized === undefined
        ? undefined
        : assertRecord(localized, `Entry ${entryId} field ${fieldId}`)
      if (field.required === true && (!values || !isNonEmpty(values[project.defaultLocale]))) {
        throw new Error(
          `Required default-locale value is empty: entry ${entryId}, field ${fieldId}, locale ${project.defaultLocale}`,
        )
      }
      if (!values) continue
      for (const [localeCode, value] of Object.entries(values)) {
        if (!localeCodes.has(localeCode)) {
          throw new Error(`Entry ${entryId} field ${fieldId} uses an unknown locale: ${localeCode}`)
        }
        assertFieldValue(
          value,
          field,
          resources,
          `Entry ${entryId} field ${fieldId} locale ${localeCode}`,
          false,
          false,
        )
      }
    }
  }
}
