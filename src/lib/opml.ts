import { XMLParser } from 'fast-xml-parser'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedFeed {
  feedUrl: string
  title:   string | null
  htmlUrl: string | null
  folder:  string | null
}

interface OutlineAttrs {
  '@_xmlUrl'?:  string
  '@_htmlUrl'?: string
  '@_text'?:    string
  '@_title'?:   string
  '@_type'?:    string
}

interface OutlineNode extends OutlineAttrs {
  outline?: OutlineNode | OutlineNode[]
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses an OPML document and returns a flat list of feed entries.
 *
 * - Folder structure is preserved as a single `folder` string (immediate parent name).
 * - Deeply nested folders use the nearest ancestor that has no `xmlUrl`.
 * - Outlines missing `xmlUrl` are treated as folders, not feeds.
 * - Malformed XML or empty body returns an empty array (no throw).
 */
export function parseOpml(xml: string): ParsedFeed[] {
  const parser = new XMLParser({
    ignoreAttributes:    false,
    attributeNamePrefix: '@_',
    // Always return outline children as an array for consistent access
    isArray: (name: string) => name === 'outline',
  })

  let doc: { opml?: { body?: { outline?: OutlineNode[] } } }
  try {
    doc = parser.parse(xml) as typeof doc
  } catch {
    return []
  }

  const outlines = doc?.opml?.body?.outline
  if (!outlines || outlines.length === 0) return []

  const feeds: ParsedFeed[] = []
  for (const node of outlines) {
    walkOutline(node, null, feeds)
  }
  return feeds
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walkOutline(node: OutlineNode, folder: string | null, feeds: ParsedFeed[]) {
  const xmlUrl = node['@_xmlUrl']?.trim()

  if (xmlUrl) {
    // Feed outline — xmlUrl present means it's a subscribable feed
    feeds.push({
      feedUrl: xmlUrl,
      title:   node['@_title'] ?? node['@_text'] ?? null,
      htmlUrl: node['@_htmlUrl']?.trim() ?? null,
      folder,
    })
    return
  }

  // Folder outline — recurse with this node's label as the new folder name
  const folderName = node['@_title'] ?? node['@_text'] ?? folder
  const children   = toArray(node.outline)
  for (const child of children) {
    walkOutline(child, folderName, feeds)
  }
}

function toArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined || val === null) return []
  return Array.isArray(val) ? val : [val]
}
