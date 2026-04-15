/** Returns a human-readable relative time string, e.g. "3h ago" or "Never". */
export function relativeTime(ts: number | null): string {
  if (!ts) return "Never";
  const diffMs = Date.now() - ts;
  const mins   = Math.floor(diffMs / 60_000);
  const hours  = Math.floor(diffMs / 3_600_000);
  const days   = Math.floor(diffMs / 86_400_000);
  if (mins  <  1) return "just now";
  if (hours <  1) return `${mins}m ago`;
  if (days  <  1) return `${hours}h ago`;
  if (days  < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}yr ago`;
}

/** Returns a short UTC timestamp string, e.g. "2026-04-07 21:55". */
export function shortUtc(ts: number | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}
