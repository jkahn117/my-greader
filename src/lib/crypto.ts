/** Returns the SHA-256 hex digest of the given string */
export async function sha256(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input)
  const buffer  = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Derives a stable item ID from a feed article guid or URL */
export async function deriveItemId(guidOrUrl: string): Promise<string> {
  return sha256(guidOrUrl)
}

/**
 * Extracts the raw hex item ID from either form GReader clients use:
 *   - Full:  tag:google.com,2005:reader/item/<hex>
 *   - Short: <hex>
 */
export function normalizeItemId(id: string): string {
  const prefix = 'tag:google.com,2005:reader/item/'
  return id.startsWith(prefix) ? id.slice(prefix.length) : id
}

/** Wraps a hex item ID in the full GReader tag format */
export function toGreaderItemId(hex: string): string {
  return `tag:google.com,2005:reader/item/${hex}`
}

/**
 * Encodes a (publishedAt ms, itemId hex) pair as a base64url continuation token.
 * The compound cursor prevents skipping items that share the same publishedAt.
 */
export function encodeContinuation(publishedAt: number, itemId: string): string {
  const raw = `${publishedAt}:${itemId}`;
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type ContinuationCursor = { publishedAt: number; itemId: string };

/** Decodes a continuation token back to a (publishedAt ms, itemId) cursor */
export function decodeContinuation(token: string): ContinuationCursor | null {
  try {
    const padded = token.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice((token.length + 3) % 4 === 0 ? 4 : (token.length + 3) % 4);
    const raw = atob(padded);
    const colon = raw.indexOf(':');
    if (colon === -1) {
      // Legacy token: plain timestamp only (no itemId component)
      const value = Number(raw);
      return isNaN(value) ? null : { publishedAt: value, itemId: '' };
    }
    const publishedAt = Number(raw.slice(0, colon));
    const itemId = raw.slice(colon + 1);
    return isNaN(publishedAt) ? null : { publishedAt, itemId };
  } catch {
    return null;
  }
}
