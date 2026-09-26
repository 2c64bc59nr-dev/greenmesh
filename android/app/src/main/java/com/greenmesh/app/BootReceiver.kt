package com.greenmesh.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Brings this node back without anyone touching the phone.
 *
 * A cluster of always-up workers has to survive reboots and app updates on its
 * own: this receiver fires on boot and on "my package was replaced", starts the
 * foreground service and relaunches the app, and the JS layer then re-arms the
 * HTTP server and reloads the last model.
 *
 * It is also the fallback path for a remote restart (ACTION_RESTART_NODE): the
 * app kills its own process, the alarm fires this receiver, and the node comes
 * back fresh.
 */
class BootReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent?) {
    val action = intent?.action ?: return
    // The repeating health check must not pop the UI up on someone's phone.
    val healthCheck = action == ACTION_HEALTH_CHECK
    val wake = action == Intent.ACTION_BOOT_COMPLETED ||
      action == Intent.ACTION_MY_PACKAGE_REPLACED ||
      action == "android.intent.action.QUICKBOOT_POWERON" ||
      action == ACTION_RESTART_NODE
    if (!wake && !healthCheck) return

    // Keep the process unfrozen and re-run the JS bootstrap; both are idempotent
    // and cheap when the node is already healthy.
    //
    // Guarded: Android refuses a foreground-service start from the background
    // (ForegroundServiceStartNotAllowedException) unless the app is exempt, and an
    // exception here would take the whole process down with the receiver.
    try {
      ServingService.start(context)
    } catch (error: Exception) {
      // the node still comes back when Android next allows it, or on the next check
    }
    try {
      NodeTaskService.start(context)
    } catch (error: Exception) {
    }

    if (healthCheck) return

    val launch = Intent(context, MainActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      putExtra(EXTRA_BOOT, true)
    }
    try {
      context.startActivity(launch)
    } catch (error: Exception) {
      // Android may refuse a background activity start; the foreground service
      // plus the app's own watchdog still bring the server up when it is opened.
    }
  }

  companion object {
    const val ACTION_RESTART_NODE = "com.greenmesh.app.RESTART_NODE"
    const val ACTION_HEALTH_CHECK = "com.greenmesh.app.HEALTH_CHECK"
    const val EXTRA_BOOT = "greenmesh.boot"
  }
}
