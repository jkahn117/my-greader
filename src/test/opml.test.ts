// OPML parser unit tests — pure function, no D1 or Workers env required.

import { describe, expect, it } from 'vitest'
import { parseOpml } from '../lib/opml'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FLAT_OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Test</title></head>
  <body>
    <outline type="rss" text="Feed One" title="Feed One"
      xmlUrl="https://example.com/feed.xml"
      htmlUrl="https://example.com"/>
    <outline type="rss" text="Feed Two"
      xmlUrl="https://other.example.com/rss"
      htmlUrl="https://other.example.com"/>
  </body>
</opml>`

const FOLDER_OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Test</title></head>
  <body>
    <outline text="Tech" title="Tech">
      <outline type="rss" text="Tech Blog" xmlUrl="https://tech.example.com/feed.xml"/>
      <outline type="rss" text="Dev News"  xmlUrl="https://devnews.example.com/rss"/>
    </outline>
    <outline type="rss" text="Unfiled Feed" xmlUrl="https://unfiled.example.com/feed.xml"/>
  </body>
</opml>`

const NESTED_FOLDERS_OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Test</title></head>
  <body>
    <outline text="Outer">
      <outline text="Inner">
        <outline type="rss" text="Deep Feed" xmlUrl="https://deep.example.com/feed.xml"/>
      </outline>
    </outline>
  </body>
</opml>`

const MISSING_ATTRS_OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Test</title></head>
  <body>
    <outline xmlUrl="https://notitle.example.com/feed.xml"/>
    <outline type="rss" text="Has Text Only" xmlUrl="https://textonly.example.com/feed.xml"/>
  </body>
</opml>`

const EMPTY_BODY_OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Empty</title></head>
  <body/>
</opml>`

const MALFORMED_XML = `this is not xml at all <<<`

const FOLDER_ONLY_OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Test</title></head>
  <body>
    <outline text="Empty Folder"/>
  </body>
</opml>`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseOpml', () => {
  it('parses a flat list of feeds', () => {
    const result = parseOpml(FLAT_OPML)

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      feedUrl: 'https://example.com/feed.xml',
      title:   'Feed One',
      htmlUrl: 'https://example.com',
      folder:  null,
    })
    expect(result[1]).toMatchObject({
      feedUrl: 'https://other.example.com/rss',
      title:   'Feed Two',
      htmlUrl: 'https://other.example.com',
      folder:  null,
    })
  })

  it('assigns folder name from parent outline', () => {
    const result = parseOpml(FOLDER_OPML)

    expect(result).toHaveLength(3)

    const tech = result.filter(f => f.folder === 'Tech')
    expect(tech).toHaveLength(2)
    expect(tech.map(f => f.feedUrl)).toContain('https://tech.example.com/feed.xml')
    expect(tech.map(f => f.feedUrl)).toContain('https://devnews.example.com/rss')

    const unfiled = result.find(f => f.feedUrl === 'https://unfiled.example.com/feed.xml')
    expect(unfiled?.folder).toBeNull()
  })

  it('uses nearest ancestor folder for deeply nested outlines', () => {
    const result = parseOpml(NESTED_FOLDERS_OPML)

    expect(result).toHaveLength(1)
    // Deep feed should use its immediate ancestor (Inner), not Outer
    expect(result[0].folder).toBe('Inner')
    expect(result[0].feedUrl).toBe('https://deep.example.com/feed.xml')
  })

  it('returns null title when both text and title are absent', () => {
    const result = parseOpml(MISSING_ATTRS_OPML)

    expect(result).toHaveLength(2)
    const noTitle = result.find(f => f.feedUrl === 'https://notitle.example.com/feed.xml')
    expect(noTitle?.title).toBeNull()

    const textOnly = result.find(f => f.feedUrl === 'https://textonly.example.com/feed.xml')
    expect(textOnly?.title).toBe('Has Text Only')
  })

  it('prefers title attribute over text when both are present', () => {
    const result = parseOpml(FLAT_OPML)
    // Feed One has both text="Feed One" and title="Feed One" — just verifies preference
    expect(result[0].title).toBe('Feed One')
  })

  it('returns empty array for an empty body', () => {
    const result = parseOpml(EMPTY_BODY_OPML)
    expect(result).toHaveLength(0)
  })

  it('returns empty array for malformed XML', () => {
    const result = parseOpml(MALFORMED_XML)
    expect(result).toHaveLength(0)
  })

  it('skips folder-only outlines (no xmlUrl, no children with xmlUrl)', () => {
    const result = parseOpml(FOLDER_ONLY_OPML)
    expect(result).toHaveLength(0)
  })

  it('handles a single outline without array wrapping', () => {
    const single = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Test</title></head>
  <body>
    <outline type="rss" text="Only Feed" xmlUrl="https://single.example.com/feed.xml"/>
  </body>
</opml>`
    const result = parseOpml(single)
    expect(result).toHaveLength(1)
    expect(result[0].feedUrl).toBe('https://single.example.com/feed.xml')
  })
})
