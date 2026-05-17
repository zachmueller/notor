import { scaffold } from "./_scaffold-helper";

export const SLEEP = scaffold(
	"sleep",
	"Pause execution for a specified duration. Useful for waiting on long-running processes like backfills. The user can cancel at any time.",
	"read",
	`params:
  duration_seconds:
    type: number
    description: "Duration to sleep in seconds. Supports fractional values for sub-second waits."
  reason:
    type: string
    description: "Optional description of why the sleep is needed (shown in progress UI)."
    default: ""
settings:
  sleep_max_duration_seconds:
    name: "Max Sleep Duration (seconds)"
    type: number
    description: "Maximum allowed sleep duration in seconds. Requests exceeding this are clamped."
    default: 3600
    min: 1
    max: 86400
  sleep_poll_interval_seconds:
    name: "Poll Interval (seconds)"
    type: number
    description: "How often to check for cancellation during sleep. Lower values mean faster cancellation response."
    default: 5
    min: 1
    max: 60`,
	`const log = utils.logger("sleep");

// Validate and clamp duration
const rawDuration = params.duration_seconds as number;
if (typeof rawDuration !== "number" || isNaN(rawDuration) || rawDuration <= 0) {
  throw new Error("Missing or invalid required parameter: duration_seconds (must be a positive number)");
}
const maxDuration = settings.sleep_max_duration_seconds as number;
const durationSeconds = Math.min(rawDuration, maxDuration);
const reason = ((params.reason as string) || "").trim();
const pollIntervalSeconds = settings.sleep_poll_interval_seconds as number;

if (durationSeconds < rawDuration) {
  log.info("Duration clamped to max", { requested: rawDuration, clamped: durationSeconds, max: maxDuration });
}

log.info("Sleep started", { duration: durationSeconds, reason: reason || "(none)" });

const startTime = Date.now();
const endTime = startTime + durationSeconds * 1000;
const signal = utils.abortSignal;

function formatDuration(secs: number): string {
  if (secs < 60) return Math.round(secs) + "s";
  if (secs < 3600) return Math.floor(secs / 60) + "m " + Math.round(secs % 60) + "s";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h + "h " + m + "m";
}

const progressPrefix = reason ? "Sleeping (" + reason + ")" : "Sleeping";
utils.onProgress?.(progressPrefix + ": " + formatDuration(durationSeconds) + " remaining...");

while (Date.now() < endTime) {
  if (signal?.aborted) {
    const elapsed = (Date.now() - startTime) / 1000;
    log.info("Sleep cancelled", { elapsed: elapsed.toFixed(1), requested: durationSeconds });
    throw new Error("Sleep cancelled after " + elapsed.toFixed(1) + "s of " + durationSeconds + "s.");
  }

  const remaining = (endTime - Date.now()) / 1000;
  const tickMs = Math.min(pollIntervalSeconds * 1000, remaining * 1000);

  await new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, Math.max(tickMs, 0));
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

  const newRemaining = Math.max(0, (endTime - Date.now()) / 1000);
  if (newRemaining > 0) {
    utils.onProgress?.(progressPrefix + ": " + formatDuration(newRemaining) + " remaining...");
  }
}

const actualSeconds = (Date.now() - startTime) / 1000;
log.info("Sleep completed", { actual: actualSeconds.toFixed(1), requested: durationSeconds });

utils.onProgress?.(progressPrefix + ": done.");

const result: Record<string, unknown> = {
  status: "completed",
  requested_seconds: durationSeconds,
  actual_seconds: Math.round(actualSeconds * 10) / 10,
};
if (durationSeconds < rawDuration) {
  result.note = "Duration was clamped from " + rawDuration + "s to " + durationSeconds + "s (max: " + maxDuration + "s).";
}
if (reason) {
  result.reason = reason;
}
return result;`,
);
