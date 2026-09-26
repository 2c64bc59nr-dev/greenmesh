import * as keepAwake from "./keepAwake";

/**
 * Thermal and battery guard.
 *
 * An always-up worker is only useful if it does not wreck the phone it runs on.
 * A phone grinding through local inference gets hot, and a hot phone throttles
 * (so it gets slower), drains, and eventually shuts the app down - which is
 * exactly the "Android killed my node" failure this app is supposed to avoid.
 *
 * So the node watches itself: above the thresholds below it stops accepting new
 * jobs and answers 503 "cooling down" until it is comfortable again. Planners
 * see that in /health and can route around it.
 */

export const THRESHOLDS = {
  // Android thermal status: 0 none, 1 light, 2 moderate, 3 severe, 4 critical...
  thermalStatus: 3,
  batteryTempC: 45,
  minBatteryLevel: 10,
};

const state = {
  enabled: true,
  status: null,
  thermals: {
    thermalStatus: 0,
    thermalLabel: "unknown",
    batteryTempC: null,
    batteryLevel: null,
    charging: false,
  },
  paused: false,
  pauseReason: null,
  updatedAt: 0,
};

let timer = null;

export function isEnabled() {
  return state.enabled;
}

export function setEnabled(enabled) {
  state.enabled = Boolean(enabled);
  if (!state.enabled) {
    state.paused = false;
    state.pauseReason = null;
  }
}

export function getThermals() {
  return { ...state.thermals };
}

export function isPaused() {
  return state.enabled && state.paused;
}

export function getPauseReason() {
  return isPaused() ? state.pauseReason : null;
}

export function getSummary() {
  return {
    enabled: state.enabled,
    paused: isPaused(),
    reason: getPauseReason(),
    ...state.thermals,
    updatedAt: state.updatedAt,
    thresholds: THRESHOLDS,
  };
}

/**
 * Decide from a device report whether this node should keep taking work.
 * Pure and exported so the rule is testable without a phone.
 */
export function evaluate(thermals, thresholds = THRESHOLDS) {
  const status = thermals || {};
  const thermalStatus = Number(status.thermalStatus || 0);
  const temp = status.batteryTempC;
  const level = status.batteryLevel;

  if (thermalStatus >= thresholds.thermalStatus) {
    return { paused: true, reason: `thermal status ${status.thermalLabel || thermalStatus}` };
  }
  if (typeof temp === "number" && temp > 0 && temp >= thresholds.batteryTempC) {
    return { paused: true, reason: `battery at ${temp.toFixed(1)}C` };
  }
  if (
    !status.charging &&
    typeof level === "number" &&
    level >= 0 &&
    level <= thresholds.minBatteryLevel
  ) {
    return { paused: true, reason: `battery at ${level}% and not charging` };
  }
  return { paused: false, reason: null };
}

export async function refresh() {
  if (!state.enabled) return;
  const status = await keepAwake.getDeviceStatus();
  if (!status) {
    state.status = null;
    state.paused = false;
    state.pauseReason = null;
    return;
  }
  state.status = status;
  state.thermals = {
    thermalStatus: Number(status.thermalStatus || 0),
    thermalLabel: status.thermalLabel || "unknown",
    batteryTempC: typeof status.batteryTempC === "number" ? status.batteryTempC : null,
    batteryLevel: typeof status.batteryLevel === "number" ? status.batteryLevel : null,
    charging: Boolean(status.charging),
  };
  const verdict = evaluate(state.thermals);
  state.paused = verdict.paused;
  state.pauseReason = verdict.reason;
  state.updatedAt = Date.now();
}

export function startThermalWatch(intervalMs = 30000) {
  if (timer) return;
  refresh().catch(() => {});
  timer = setInterval(() => {
    refresh().catch(() => {});
  }, intervalMs);
}

export function stopThermalWatch() {
  if (timer) clearInterval(timer);
  timer = null;
}

export default {
  THRESHOLDS,
  evaluate,
  getPauseReason,
  getSummary,
  getThermals,
  isEnabled,
  isPaused,
  refresh,
  setEnabled,
  startThermalWatch,
  stopThermalWatch,
};
