package com.greenmesh.app

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.Process
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * JS control for the node's native shell:
 *  - start/stop the foreground service that keeps this phone serving jobs
 *  - mark the node busy, so the CPU wake lock is held only while a job runs and
 *    the phone can sleep between jobs instead of burning battery
 *  - report thermals, so the node can refuse work before it cooks the phone
 *  - restart the app process itself, so a remote planner can recover a wedged
 *    node without anyone touching it
 */
class ServingModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "Serving"

  @ReactMethod
  fun start() {
    ServingService.start(reactApplicationContext)
  }

  @ReactMethod
  fun stop() {
    ServingService.stop(reactApplicationContext)
  }

  /** Hold the CPU awake only while this node is actually working. */
  @ReactMethod
  fun setBusy(busy: Boolean) {
    ServingService.setBusy(reactApplicationContext, busy)
  }

  /**
   * Thermals and battery, so the JS layer can pause this node when the phone is
   * getting hot or running out of charge instead of freezing the device.
   */
  @ReactMethod
  fun getDeviceStatus(promise: Promise) {
    val map = Arguments.createMap()
    val context = reactApplicationContext
    try {
      val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      val thermal = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) power.currentThermalStatus else 0
      map.putInt("thermalStatus", thermal)
      map.putString("thermalLabel", THERMAL_LABELS.getOrElse(thermal) { "unknown" })
      map.putBoolean("powerSaveMode", power.isPowerSaveMode)
    } catch (error: Exception) {
      map.putInt("thermalStatus", 0)
      map.putString("thermalLabel", "unknown")
    }

    try {
      val battery = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
      map.putInt("batteryLevel", battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
      val sticky = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      val temp = sticky?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0
      map.putDouble("batteryTempC", temp / 10.0)
      val status = sticky?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
      map.putBoolean(
        "charging",
        status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
      )
    } catch (error: Exception) {
      map.putInt("batteryLevel", -1)
      map.putDouble("batteryTempC", -1.0)
      map.putBoolean("charging", false)
    }
    promise.resolve(map)
  }

  /** True when Android may not freeze or kill this node for being idle. */
  @ReactMethod
  fun isBatteryExempt(promise: Promise) {
    try {
      val power = reactApplicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
      promise.resolve(power.isIgnoringBatteryOptimizations(reactApplicationContext.packageName))
    } catch (error: Exception) {
      promise.resolve(false)
    }
  }

  /** Ask the user (once) to exempt this app from battery optimisation. */
  @ReactMethod
  fun requestBatteryExemption() {
    val context = reactApplicationContext
    try {
      val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      if (power.isIgnoringBatteryOptimizations(context.packageName)) return
      val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
        data = Uri.parse("package:${context.packageName}")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
    } catch (error: Exception) {
      try {
        context.startActivity(
          Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
      } catch (inner: Exception) {
      }
    }
  }

  /**
   * Open the vendor's "autostart / protected apps" screen. MIUI in particular
   * kills background apps unless the user whitelists them, and no permission
   * request can do it for them - the user has to tap it once per phone.
   */
  @ReactMethod
  fun openAutoStartSettings() {
    val context = reactApplicationContext
    val candidates = listOf(
      ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
      ComponentName("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"),
      ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
      ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity")
    )
    for (candidate in candidates) {
      try {
        context.startActivity(Intent().setComponent(candidate).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return
      } catch (error: Exception) {
        // not this vendor - try the next one
      }
    }
    try {
      context.startActivity(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
          .setData(Uri.parse("package:${context.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
    } catch (error: Exception) {
    }
  }

  /**
   * "Display over other apps". Besides being a Windows-style floating window
   * permission, it is one of Android's documented exemptions that let an app
   * start a foreground service from the background - which is exactly what the
   * node's health-check alarm needs when the phone is idle.
   */
  @ReactMethod
  fun openOverlaySettings() {
    val context = reactApplicationContext
    try {
      context.startActivity(
        Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
    } catch (error: Exception) {
      try {
        context.startActivity(
          Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
      } catch (inner: Exception) {
      }
    }
  }

  /**
   * Restart this app. The activity is brought back first (so the JS runtime
   * re-arms the server and reloads the model), an alarm is scheduled as a
   * fallback in case that launch is refused, and then the process kills itself.
   */
  @ReactMethod
  fun restartApp() {
    val context = reactApplicationContext

    val launch = Intent(context, MainActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      putExtra(BootReceiver.EXTRA_BOOT, true)
    }
    try {
      context.startActivity(launch)
    } catch (error: Exception) {
      // fall through to the alarm below
    }

    try {
      val alarm = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      val pending = PendingIntent.getBroadcast(
        context,
        7,
        Intent(context, BootReceiver::class.java).setAction(BootReceiver.ACTION_RESTART_NODE),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
      )
      alarm.set(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + 3000, pending)
    } catch (error: Exception) {
      // the activity launch above is usually enough
    }

    Handler(Looper.getMainLooper()).postDelayed({
      Process.killProcess(Process.myPid())
    }, 700)
  }

  companion object {
    private val THERMAL_LABELS = listOf(
      "none", "light", "moderate", "severe", "critical", "emergency", "shutdown"
    )
  }
}
