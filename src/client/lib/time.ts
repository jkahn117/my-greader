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

/**
 * Absolute timestamp for diagnostic evidence ("Today, 14:00 UTC",
 * "Oct 3, 09:15 UTC") in the browser's timezone, which is named so the
 * value is never ambiguous.
 */
export function formatDateTime(epochMs: number | null): string {
  if (epochMs == null) return "—";
  const date = new Date(epochMs);
  const time = date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
  const dayKey = (d: Date) => d.toDateString();
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  let day: string;
  if (dayKey(date) === dayKey(now)) day = "Today";
  else if (dayKey(date) === dayKey(yesterday)) day = "Yesterday";
  else if (dayKey(date) === dayKey(tomorrow)) day = "Tomorrow";
  else
    day = date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
    });
  return `${day}, ${time}`;
}

/** Human interval such as "30 minutes", "4 hours" or "1 hour 30 minutes". */
export function formatInterval(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
  if (m > 0 || h === 0) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
  return parts.join(" ");
}
