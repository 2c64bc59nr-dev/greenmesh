/**
 * The app's own event log.
 *
 * "As verbose as possible" is only useful if it is readable somewhere: every
 * interesting thing the node does (server up, model loaded, download started and
 * finished, dictation started, mesh request, error) is recorded here with a
 * timestamp, and the buffer is exposed to the UI and over
 * `GET /v1/mesh/events`. Nothing here is sent anywhere.
 */

const MAX_EVENTS = 300;

let events = [];
let listeners = [];
let verbose = true;

const listenersOf = (event) => listeners.filter((listener) => !event || listener.event === event);

/** Record an event. `details` must stay small - this is a log, not a data store. */
export function record(event, details, level = "info") {
  const entry = {
    ts: Date.now(),
    level,
    event: String(event),
    details: details === undefined ? null : details,
  };
  events = [entry, ...events].slice(0, MAX_EVENTS);
  if (verbose) {
    const line = details === null ? "" : ` ${JSON.stringify(details)}`;
    console.log(`[greenmesh:${entry.event}] ${level}${line}`);
  }
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch (error) {
      // a broken listener must not break the log
    }
  }
  return entry;
}

export const info = (event, details) => record(event, details, "info");
export const warn = (event, details) => record(event, details, "warn");
export const error = (event, details) => record(event, details, "error");

export function getEvents(limit = 100) {
  return events.slice(0, Math.max(0, Number(limit) || 100));
}

export function clearEvents() {
  events = [];
  return true;
}

export function setVerbose(enabled) {
  verbose = Boolean(enabled);
  return verbose;
}

export function isVerbose() {
  return verbose;
}

export function subscribe(listener) {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((item) => item !== listener);
  };
}

export function summary() {
  const counts = {};
  for (const entry of events) counts[entry.event] = (counts[entry.event] || 0) + 1;
  return { count: events.length, verbose, counts };
}

export default {
  clearEvents,
  error,
  getEvents,
  info,
  isVerbose,
  record,
  setVerbose,
  subscribe,
  summary,
  warn,
};
