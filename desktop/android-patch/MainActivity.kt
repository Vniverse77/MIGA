package com.vniverse77.miga

import android.graphics.Color
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
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val content = findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  // Back is handled by the page first: it steps back inside the app and answers false only on the list.
  override val handleBackNavigation: Boolean = false
  private var web: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    web = webView
    webView.addJavascriptInterface(Chrome(), "MigaNative")
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript("(function(){return !!(window.__migaBack && window.__migaBack());})()") { handled ->
          if (handled != "true") {
            isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            isEnabled = true
          }
        }
      }
    })
  }

  // Called by the page (platform/mobile.ts) whenever the app theme changes.
  inner class Chrome {
    // A light tick for a long-press (platform.haptic). View haptics need no permission, unlike the Vibration API.
    @JavascriptInterface
    fun haptic() {
      runOnUiThread { window.decorView.performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK) }
    }

    @JavascriptInterface
    fun setChrome(color: String, light: Boolean) {
      runOnUiThread {
        val c = Color.parseColor(color)
        window.decorView.setBackgroundColor(c)
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(c))
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.isAppearanceLightStatusBars = light
        controller.isAppearanceLightNavigationBars = light
      }
    }
  }
}
