/** Compact relative/absolute time formatting for dashboard tables. */

export function formatTime(epochMs: number | null): string {
  if (epochMs == null) return "—";
  const diff = Date.now() - epochMs;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (abs < minute) return "just now";
  if (abs < hour) {
    const m = Math.round(abs / minute);
    return diff >= 0 ? `${m}m ago` : `in ${m}m`;
  }
  if (abs < day) {
    const h = Math.round(abs / hour);
    return diff >= 0 ? `${h}h ago` : `in ${h}h`;
  }
  const d = Math.round(abs / day);
  return diff >= 0 ? `${d}d ago` : `in ${d}d`;
}
