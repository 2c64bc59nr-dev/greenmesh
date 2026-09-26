package com.greenmesh.app

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * Keeps this phone usable as a mesh worker while the screen is off - without
 * turning the phone into a space heater.
 *
 * Two locks, deliberately different lifetimes:
 *
 *  - Wi-Fi lock: held for as long as the node is serving. It only stops the
 *    radio from going into power save, so jobs can arrive at any moment.
 *  - CPU partial wake lock: held ONLY while a job is actually in flight
 *    (`setBusy`). A permanently held CPU lock is what drains a phone and makes
 *    Android' battery manager fight the app; between jobs the CPU is free to
 *    suspend and an incoming packet wakes it.
 *
 * The HTTP server itself lives in JavaScript - this service only keeps the
 * process, the socket and the radio alive.
 */
class ServingService : Service() {

  private var cpuLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null
  private var busy = false
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    createChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopSelf()
      return START_NOT_STICKY
    }

    when (intent?.action) {
      ACTION_BUSY -> busy = true
      ACTION_IDLE -> busy = false
    }

    // Always go foreground first: a service started from the background must
    // post its notification within a few seconds.
    startForeground(NOTIFICATION_ID, buildNotification())
    acquireWifiLock()
    if (busy) acquireCpuLock() else releaseCpuLock()
    scheduleHealthCheck()

    // START_STICKY: if the system kills the process for memory, Android brings
    // the service back. A user "Force stop" (or MIUI's cleaner) still wins - no
    // app can survive that, which is why the app also re-arms itself on launch.
    return START_STICKY
  }

  /**
   * The CPU lock is taken with a timeout on purpose: if a job wedges or the JS
   * layer dies mid-request, the lock expires instead of pinning the CPU forever.
   */
  private fun acquireCpuLock() {
    if (cpuLock == null) {
      val power = getSystemService(Context.POWER_SERVICE) as PowerManager
      cpuLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "greenmesh:job").apply {
        setReferenceCounted(false)
      }
    }
    try {
      cpuLock?.let { if (!it.isHeld) it.acquire(CPU_LOCK_TIMEOUT_MS) }
    } catch (error: Exception) {
    }
  }

  private fun releaseCpuLock() {
    try {
      cpuLock?.let { if (it.isHeld) it.release() }
    } catch (error: Exception) {
    }
  }

  private fun acquireWifiLock() {
    if (wifiLock != null) return
    try {
      val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "greenmesh:wifi").apply {
        setReferenceCounted(false)
        acquire()
      }
    } catch (error: Exception) {
      // Wi-Fi lock is a bonus; the foreground service alone already survives doze.
    }
  }

  private fun releaseLocks() {
    releaseCpuLock()
    try {
      wifiLock?.let { if (it.isHeld) it.release() }
    } catch (error: Exception) {
    }
    wifiLock = null
  }

  /**
   * Native watchdog.
   *
   * A JavaScript timer is not enough on its own: if the foreground service ever
   * goes away, Android freezes the cached process and no JS runs at all. This
   * repeating alarm is the backstop - it wakes the app every couple of minutes
   * and the receiver re-asserts the service and runs the headless bootstrap if
   * the listener is down.
   *
   * Inexact on purpose (no exact-alarm permission, and Android batches it) - the
   * node is not a stopwatch.
   */
  private fun scheduleHealthCheck() {
    try {
      val alarm = getSystemService(Context.ALARM_SERVICE) as AlarmManager
      val pending = PendingIntent.getBroadcast(
        this,
        11,
        Intent(this, BootReceiver::class.java).setAction(BootReceiver.ACTION_HEALTH_CHECK),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
      )
      alarm.setInexactRepeating(
        AlarmManager.RTC_WAKEUP,
        System.currentTimeMillis() + HEALTH_CHECK_INTERVAL_MS,
        HEALTH_CHECK_INTERVAL_MS,
        pending
      )
    } catch (error: Exception) {
      // AlarmManager refused; the service watchdog in JS still covers us.
    }
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Mesh node",
      NotificationManager.IMPORTANCE_LOW
    ).apply { description = "Keeps this phone reachable as an AI worker" }
    manager.createNotificationChannel(channel)
  }

  /**
   * Ongoing and non-dismissable while the node serves, so nobody swipes the node
   * off the network by accident.
   */
  private fun buildNotification(): Notification {
    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
    val stop = PendingIntent.getService(
      this,
      1,
      Intent(this, ServingService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
    val text = if (busy) "Working on a job" else "Idle - reachable on your network"
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("GreenMesh node")
      .setContentText(text)
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setOngoing(true)
      .setShowWhen(false)
      .setContentIntent(open)
      .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop serving", stop)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
  }

  override fun onDestroy() {
    releaseLocks()
    super.onDestroy()
  }

  /**
   * Removing the app from the recents list must not take the node off the network;
   * `android:stopWithTask="false"` in the manifest keeps this service running.
   */
  override fun onTaskRemoved(rootIntent: Intent?) {
    super.onTaskRemoved(rootIntent)
  }

  companion object {
    private const val CHANNEL_ID = "greenmesh_serving"
    private const val NOTIFICATION_ID = 4711
    private const val CPU_LOCK_TIMEOUT_MS = 10 * 60 * 1000L
    private const val HEALTH_CHECK_INTERVAL_MS = 2 * 60 * 1000L
    const val ACTION_STOP = "com.greenmesh.app.STOP_SERVING"
    const val ACTION_BUSY = "com.greenmesh.app.NODE_BUSY"
    const val ACTION_IDLE = "com.greenmesh.app.NODE_IDLE"

    fun start(context: Context) {
      try {
        val intent = Intent(context, ServingService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
      } catch (error: Exception) {
        // Background start refused (Android 12+): callers must not crash for it.
        // Granting "display over other apps" makes this legal - see the module.
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, ServingService::class.java))
    }

    /** Called around every job: the CPU is only pinned while work is in flight. */
    fun setBusy(context: Context, busy: Boolean) {
      val intent = Intent(context, ServingService::class.java)
        .setAction(if (busy) ACTION_BUSY else ACTION_IDLE)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
      } catch (error: Exception) {
        // Service already gone; nothing to keep awake.
      }
    }
  }
}
