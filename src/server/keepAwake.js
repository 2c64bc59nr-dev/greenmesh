import { NativeModules } from "react-native";

/**
 * Native shell of a mesh node.
 *
 * The HTTP server lives in JavaScript, so keeping this phone alive as a worker
 * is a native problem: a foreground service for reachability, a wake lock that
 * is held only while a job runs (a permanently pinned CPU is what drains a
 * phone and makes Android fight the app), thermals so the node can refuse work
 * before it gets hot, and a hard restart so a wedged node can be recovered
 * remotely.
 */
const Serving = NativeModules.Serving || null;

export const isAvailable = () => Boolean(Serving);

export function startServingNotification() {
  try {
    if (Serving && Serving.start) Serving.start();
    return true;
  } catch (error) {
    return false;
  }
}

export function stopServingNotification() {
  try {
    if (Serving && Serving.stop) Serving.stop();
    return true;
  } catch (error) {
    return false;
  }
}

/** Pin the CPU only while a job is in flight; release it the moment work ends. */
export function setBusy(busy) {
  try {
    if (Serving && Serving.setBusy) Serving.setBusy(Boolean(busy));
  } catch (error) {
    // not fatal: the node just loses the extra assurance of an awake CPU
  }
}

/** Thermals, battery level and charge state; resolves null when unavailable. */
export function getDeviceStatus() {
  return new Promise((resolve) => {
    if (!Serving || !Serving.getDeviceStatus) {
      resolve(null);
      return;
    }
    try {
      Serving.getDeviceStatus()
        .then((status) => resolve(status || null))
        .catch(() => resolve(null));
    } catch (error) {
      resolve(null);
    }
  });
}

export function isBatteryExempt() {
  return new Promise((resolve) => {
    if (!Serving || !Serving.isBatteryExempt) {
      resolve(false);
      return;
    }
    try {
      Serving.isBatteryExempt()
        .then((value) => resolve(Boolean(value)))
        .catch(() => resolve(false));
    } catch (error) {
      resolve(false);
    }
  });
}

export function requestBatteryExemption() {
  try {
    if (Serving && Serving.requestBatteryExemption) Serving.requestBatteryExemption();
  } catch (error) {
  }
}

export function openAutoStartSettings() {
  try {
    if (Serving && Serving.openAutoStartSettings) Serving.openAutoStartSettings();
  } catch (error) {
  }
}

/**
 * "Display over other apps". Also one of Android's exemptions that let the node
 * start its foreground service from the background when the health-check alarm
 * fires - without it the node can be left dark on an idle phone.
 */
export function openOverlaySettings() {
  try {
    if (Serving && Serving.openOverlaySettings) Serving.openOverlaySettings();
  } catch (error) {
  }
}

/** Kill and relaunch the app - the server and the model come back on their own. */
export function restartApp() {
  try {
    if (Serving && Serving.restartApp) Serving.restartApp();
  } catch (error) {
  }
}

export default {
  isAvailable,
  startServingNotification,
  stopServingNotification,
  setBusy,
  getDeviceStatus,
  isBatteryExempt,
  requestBatteryExemption,
  openAutoStartSettings,
  openOverlaySettings,
  restartApp,
};
