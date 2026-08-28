import { listTimestamp } from "./utils";

/**
 * Absolute local time, to the minute. Formerly "3m ago" — a relative label
 * reads fine in isolation but is useless for reconstructing a sequence, and
 * it silently drifts between renders (user 2026-08-27).
 *
 * Audit surfaces (decisions, document revisions) use `chineseTimestamp` /
 * `absoluteTimestamp` instead, which keep seconds.
 */
export function timeAgo(date: Date | string): string {
  return listTimestamp(date);
}
