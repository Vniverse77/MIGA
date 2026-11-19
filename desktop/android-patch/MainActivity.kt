package com.vniverse77.miga

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
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
