package com.vniverse77.miga

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.content.Intent
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

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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
