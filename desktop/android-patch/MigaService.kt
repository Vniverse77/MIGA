package com.vniverse77.miga

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

// Background connection (no Google services, no third party): a foreground service whose only job is to keep this
// app's process at foreground priority and the CPU awake enough for the web view's relay connection (a WebSocket
// opened by the page itself) to keep running while the app is in the background. The page decides what is a new
// message and asks MainActivity to post the notification, so the service never sees a key or a message.
// It shows one quiet, ongoing notification ("MIGA is connected"); its channel can be hidden in the system settings.
class MigaService : Service() {
  private var lock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    ensureChannels(this)
    val open = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
    val note: Notification = NotificationCompat.Builder(this, CHANNEL_SERVICE)
      .setSmallIcon(R.drawable.ic_stat_miga)
      .setContentTitle(getString(R.string.miga_service_title))
      .setContentText(getString(R.string.miga_service_text))
      .setOngoing(true)
      .setShowWhen(false)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setContentIntent(open)
      .build()
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(SERVICE_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
    } else {
      startForeground(SERVICE_ID, note)
    }
    if (lock == null) {
      // A partial wake lock keeps the CPU running so the page's keep-alive pings are not delayed while the screen is off.
      lock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "miga:connection").apply { setReferenceCounted(false); acquire() }
    }
    return START_STICKY
  }

  // Swiping the app from recent apps destroys the web view that holds the connection, so there is nothing left to
  // keep alive: stop, and do not leave a "connected" notification behind. Opening the app starts it again.
  override fun onTaskRemoved(rootIntent: Intent?) {
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    lock?.let { if (it.isHeld) it.release() }
    lock = null
    super.onDestroy()
  }

  companion object {
    const val CHANNEL_SERVICE = "miga_connection"
    const val CHANNEL_MESSAGES = "miga_messages"
    private const val SERVICE_ID = 1

    fun ensureChannels(context: Context) {
      if (Build.VERSION.SDK_INT < 26) return
      val manager = context.getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_SERVICE, context.getString(R.string.miga_channel_service), NotificationManager.IMPORTANCE_MIN).apply {
          description = context.getString(R.string.miga_channel_service_desc)
          setShowBadge(false)
        }
      )
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_MESSAGES, context.getString(R.string.miga_channel_messages), NotificationManager.IMPORTANCE_HIGH).apply {
          setShowBadge(true)
        }
      )
    }

    fun canNotify(context: Context): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled()
  }
}
