package com.greenmesh.app

import android.content.Context
import android.content.Intent
import android.os.Bundle
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Runs the node's JavaScript bootstrap with no UI at all.
 *
 * This is what makes "no physical connection needed" true: on boot, after an app
 * update, or after a hard restart, the app has no activity running, but React
 * Native can still execute JS in the background. That headless pass re-arms the
 * HTTP server and reloads the last model, so a phone that nobody has touched
 * comes back as a worker on its own.
 *
 * The JavaScript side is registered in App.js as the "GreenMeshNodeTask" task.
 */
class NodeTaskService : HeadlessJsTaskService() {

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
    val data = Bundle().apply { putBoolean("boot", true) }
    return HeadlessJsTaskConfig(
      TASK_KEY,
      Arguments.fromBundle(data),
      // Long timeout on purpose: bringing a model up from storage on a slow
      // phone takes longer than the 5s default.
      120000L,
      // MUST be true. The health-check alarm fires whether or not the app is on
      // screen, and React Native throws IllegalStateException ("Tried to start
      // task ... while in foreground") - crashing the app - if a headless task
      // is started while the UI is up. The task body is idempotent.
      true
    )
  }

  companion object {
    const val TASK_KEY = "GreenMeshNodeTask"

    fun start(context: Context) {
      try {
        val intent = Intent(context, NodeTaskService::class.java)
        context.startService(intent)
      } catch (error: Exception) {
        // Android may refuse to start a background service; the UI launch in
        // BootReceiver is the fallback.
      }
    }
  }
}
