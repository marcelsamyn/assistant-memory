/**
 * Structured event logger for the claims pipeline.
 *
 * `logEvent(name, fields)` writes a single JSON line per event. Tests can swap
 * the sink via `setLogSink` to capture events in-memory and assert on them.
 *
 * Common aliases: structured logging, telemetry, observability events,
 * claim.inserted, identity.resolved, atlas.derived, profile.synthesized,
 * bootstrap_context.assembled, transcript.ingested.
 */

export interface LogEvent {
  /** ISO-8601 wall-clock timestamp the event was emitted at. */
  ts: string;
  /** Event name, e.g. `"claim.inserted"`. */
  event: string;
  /** Structured payload. Caller-provided keys; we don't add or rename them. */
  [field: string]: unknown;
}

export type LogSink = (event: LogEvent) => void;

/**
 * Default sink: write a single JSON line to stdout. Kept silent when
 * `process.stdout` is unavailable (e.g. unusual runtimes) so the helper is
 * always safe to call from library code.
 */
const defaultSink: LogSink = (event) => {
  const line = `${JSON.stringify(event)}\n`;
  if (typeof process !== "undefined" && process.stdout?.write) {
    process.stdout.write(line);
  }
};

let activeSink: LogSink = defaultSink;

/** Replace the sink. Tests use this to capture events; pass no arg to reset. */
export function setLogSink(sink?: LogSink): void {
  activeSink = sink ?? defaultSink;
}

/** Emit a structured event. */
export function logEvent(name: string, fields: Record<string, unknown>): void {
  const event: LogEvent = {
    ts: new Date().toISOString(),
    event: name,
    ...fields,
  };
  activeSink(event);
}
