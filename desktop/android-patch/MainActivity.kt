package com.vniverse77.miga

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.Manifest
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

// Edge to edge, but the web view sits INSIDE the system bars and above the soft keyboard. The page never has to
// guess insets (env(safe-area-inset-*) stays 0 here), and the keyboard resizes the page like in a browser.
class MainActivity : TauriActivity() {
  // Window background behind the bars: the top inset takes the header colour, everything below it the colour of the
  // screen's bottom edge, so the navigation bar area never shows as a band against the page.
  private class TwoTone : Drawable() {
    var top = Color.BLACK
    var bottom = Color.BLACK
    var topHeight = 0
    private val paint = Paint()
    override fun draw(c: Canvas) {
      val b = bounds
      paint.color = bottom
      c.drawRect(b.left.toFloat(), b.top.toFloat(), b.right.toFloat(), b.bottom.toFloat(), paint)
      paint.color = top
      c.drawRect(b.left.toFloat(), b.top.toFloat(), b.right.toFloat(), (b.top + topHeight).toFloat(), paint)
    }
    override fun setAlpha(alpha: Int) {}
    override fun setColorFilter(cf: ColorFilter?) {}
    @Deprecated("Required override")
    override fun getOpacity(): Int = PixelFormat.OPAQUE
  }
  private val backdrop = TwoTone()

  // Saving a key backup: the system "create document" screen lets the person pick where the file goes, so the
  // app needs no storage permission. The bytes wait here until a location is chosen; nothing is uploaded.
  private var pendingSave: ByteArray? = null
  private val createDocument = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
    val bytes = pendingSave
    pendingSave = null
    val uri: Uri? = result.data?.data
    val answer = when {
      bytes == null || result.resultCode != RESULT_OK || uri == null -> "cancelled"
      else -> try {
        contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) } ?: throw java.io.IOException("no stream")
        "saved"
      } catch (e: Exception) {
        "error"
      }
    }
    web?.evaluateJavascript("window.__migaSaved && window.__migaSaved('$answer')", null)
  }

  // Notification permission (Android 13+): asked only when the page asks, from a click.
  private val askNotify = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    val answer = if (granted) "granted" else "denied"
    // The service's own notification was suppressed while the permission was missing: post it again.
    if (granted) applyBackground()
    web?.evaluateJavascript("window.__migaPerm && window.__migaPerm('$answer')", null)
  }

  private fun prefs() = getSharedPreferences("miga", Context.MODE_PRIVATE)

  // "Background connection" setting (default on): the foreground service in MigaService.kt.
  private fun applyBackground() {
    val intent = Intent(this, MigaService::class.java)
    if (prefs().getBoolean("bg", true)) {
      try {
        ContextCompat.startForegroundService(this, intent)
      } catch (e: Exception) {
        // The system refused (for example no foreground start allowed right now); the app still works.
      }
    } else {
      stopService(intent)
    }
  }

  // A tap on a message notification: the page knows which chat the tag belongs to.
  private fun routeTap(intent: Intent?) {
    val tag = intent?.getStringExtra("miga_tag") ?: return
    intent.removeExtra("miga_tag")
    val quoted = org.json.JSONObject.quote(tag)
    web?.evaluateJavascript("window.__migaTap && window.__migaTap($quoted)", null)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    routeTap(intent)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    MigaService.ensureChannels(this)
    applyBackground()
    window.setBackgroundDrawable(backdrop)
    val content = findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      backdrop.topHeight = bars.top
      backdrop.invalidateSelf()
      WindowInsetsCompat.CONSUMED
    }
  }

  // Back is handled by the page first: it steps back inside the app and answers false only on the list.
  override val handleBackNavigation: Boolean = false
  private var web: WebView? = null
  private var backCallback: OnBackPressedCallback? = null
  private var canGoBack = true

  override fun onWebViewCreate(webView: WebView) {
    web = webView
    webView.addJavascriptInterface(Chrome(), "MigaNative")
    backCallback = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript("(function(){return !!(window.__migaBack && window.__migaBack());})()") { handled ->
          if (handled != "true") {
            isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            isEnabled = canGoBack
          }
        }
      }
    }
    onBackPressedDispatcher.addCallback(this, backCallback!!)
  }

  // Called by the page (platform/mobile.ts): whenever the app theme changes, the screen changes and a layer opens or closes.
  inner class Chrome {
    // ── Notifications and the background connection (platform/mobile.ts) ──
    @JavascriptInterface
    fun notifyPermission(): String {
      if (MigaService.canNotify(this@MainActivity)) return "granted"
      val asked = prefs().getBoolean("asked_notify", false)
      return if (Build.VERSION.SDK_INT >= 33 && !asked) "default" else "denied"
    }

    @JavascriptInterface
    fun requestNotifyPermission() {
      runOnUiThread {
        prefs().edit().putBoolean("asked_notify", true).apply()
        if (Build.VERSION.SDK_INT >= 33) askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
        else web?.evaluateJavascript("window.__migaPerm && window.__migaPerm('${if (MigaService.canNotify(this@MainActivity)) "granted" else "denied"}')", null)
      }
    }

    // One notification per tag (the tag is "chat-<address>"): a new one replaces the old. Tapping it opens the app
    // and the page opens that chat.
    @JavascriptInterface
    fun notify(tag: String, title: String, body: String) {
      if (!MigaService.canNotify(this@MainActivity)) return
      val open = PendingIntent.getActivity(
        this@MainActivity, tag.hashCode(),
        Intent(this@MainActivity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra("miga_tag", tag),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
      )
      val note = NotificationCompat.Builder(this@MainActivity, MigaService.CHANNEL_MESSAGES)
        .setSmallIcon(R.drawable.ic_stat_miga)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(NotificationCompat.BigTextStyle().bigText(body))
        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setAutoCancel(true)
        .setOnlyAlertOnce(false)
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setContentIntent(open)
        .build()
      try {
        NotificationManagerCompat.from(this@MainActivity).notify(tag, 2, note)
      } catch (e: SecurityException) {
        // permission revoked in the meantime
      }
    }

    @JavascriptInterface
    fun cancel(tag: String) {
      NotificationManagerCompat.from(this@MainActivity).cancel(tag, 2)
    }

    @JavascriptInterface
    fun getBackground(): Boolean = prefs().getBoolean("bg", true)

    @JavascriptInterface
    fun setBackground(on: Boolean) {
      prefs().edit().putBoolean("bg", on).apply()
      runOnUiThread { applyBackground() }
    }

    // Optional: lets the system keep the connection running in Doze. The system shows its own confirmation.
    @JavascriptInterface
    fun batteryExemption() {
      runOnUiThread {
        try {
          val power = getSystemService(Context.POWER_SERVICE) as PowerManager
          if (!power.isIgnoringBatteryOptimizations(packageName)) {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
          }
        } catch (e: Exception) {
          startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
      }
    }

    // A light tick for a long-press (platform.haptic). View haptics need no permission, unlike the Vibration API.
    @JavascriptInterface
    fun haptic() {
      runOnUiThread { window.decorView.performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK) }
    }

    // platform.saveFile: base64 bytes of a file; the answer comes back through window.__migaSaved.
    @JavascriptInterface
    fun saveFile(name: String, base64: String, mime: String) {
      runOnUiThread {
        try {
          pendingSave = Base64.decode(base64, Base64.DEFAULT)
          val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mime
            putExtra(Intent.EXTRA_TITLE, name)
          }
          createDocument.launch(intent)
        } catch (e: Exception) {
          pendingSave = null
          web?.evaluateJavascript("window.__migaSaved && window.__migaSaved('error')", null)
        }
      }
    }

    @JavascriptInterface
    fun setChrome(color: String, light: Boolean) {
      runOnUiThread {
        backdrop.top = Color.parseColor(color)
        backdrop.invalidateSelf()
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.isAppearanceLightStatusBars = light
        controller.isAppearanceLightNavigationBars = light
      }
    }

    // The colour at the bottom edge of the current screen (navigation bar area).
    @JavascriptInterface
    fun setBottom(color: String) {
      runOnUiThread {
        backdrop.bottom = Color.parseColor(color)
        backdrop.invalidateSelf()
      }
    }

    // False at the conversation list: the system then handles Back itself (back-to-home preview, then the app leaves).
    @JavascriptInterface
    fun setCanGoBack(can: Boolean) {
      runOnUiThread {
        canGoBack = can
        backCallback?.isEnabled = can
      }
    }
  }
}
