package com.a3k.player

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.a3k.player.cms.CmsCache
import com.a3k.player.cms.Prefs

class PlayerActivity : AppCompatActivity() {

    private lateinit var container: FrameLayout
    private lateinit var cache: CmsCache
    private var webView: WebView? = null

    private val ui = Handler(Looper.getMainLooper())
    private val beat = object : Runnable {
        override fun run() {
            Watchdog.beat()
            ui.postDelayed(this, 15_000)
        }
    }

    // gesto secreto: 7 toques no canto superior esquerdo em ate 3s -> Setup
    private var cornerTaps = 0
    private var firstTapAt = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!Prefs.isConfigured(this)) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }

        requestedOrientation = Prefs.requestedOrientation(this)
        keepScreenOnAndVisible()

        cache = CmsCache(applicationContext)
        container = FrameLayout(this).apply { setBackgroundColor(0xFF000000.toInt()) }
        setContentView(container)
        buildWebView()
        Watchdog.arm(this)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView() {
        webView?.let { container.removeView(it); it.destroy() }

        val wv = WebView(this)
        wv.layoutParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
        )
        wv.setBackgroundColor(0xFF000000.toInt())
        with(wv.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            loadsImagesAutomatically = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            allowFileAccess = true
            javaScriptCanOpenWindowsAutomatically = false
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        wv.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView, request: WebResourceRequest
            ): WebResourceResponse? = try {
                cache.intercept(request)
            } catch (t: Throwable) {
                Log.w(TAG, "intercept erro", t); null
            }

            override fun onRenderProcessGone(
                view: WebView, detail: RenderProcessGoneDetail?
            ): Boolean {
                Log.e(TAG, "render process morreu (crash=${detail?.didCrash()}) — recriando WebView")
                ui.post { buildWebView() }
                return true
            }

            override fun onReceivedError(
                view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError
            ) {
                if (request.isForMainFrame) {
                    Log.w(TAG, "erro no frame principal: ${error.errorCode} ${error.description}")
                    ui.postDelayed({ webView?.loadUrl(Prefs.playerUrl(this@PlayerActivity)) }, 5_000)
                }
            }
        }
        wv.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.d("A3K/WV", "${m.message()} @${m.sourceId()}:${m.lineNumber()}")
                return true
            }
        }

        wv.setOnTouchListener { _, ev -> onCornerTap(ev); false }

        container.addView(wv)
        webView = wv
        wv.loadUrl(Prefs.playerUrl(this))
        Log.i(TAG, "carregando ${Prefs.playerUrl(this)}")
    }

    private fun onCornerTap(ev: MotionEvent) {
        if (ev.actionMasked != MotionEvent.ACTION_DOWN) return
        val corner = ev.x < container.width * 0.15f && ev.y < container.height * 0.15f
        val now = SystemClock.elapsedRealtime()
        if (!corner || now - firstTapAt > 3_000) { cornerTaps = 0; firstTapAt = now }
        if (corner) {
            cornerTaps++
            if (cornerTaps >= 7) {
                cornerTaps = 0
                startActivity(Intent(this, SetupActivity::class.java))
            }
        }
    }

    private fun keepScreenOnAndVisible() {
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            )
        }
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) keepScreenOnAndVisible()
    }

    override fun onResume() {
        super.onResume()
        Watchdog.arm(this)
        Watchdog.beat()
        ui.removeCallbacks(beat)
        ui.post(beat)
        webView?.onResume()
    }

    override fun onPause() {
        super.onPause()
        ui.removeCallbacks(beat)
        webView?.onPause()
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        webView?.let { container.removeView(it); it.destroy() }
        webView = null
        super.onDestroy()
    }

    // engole voltar/home/menu — nao deixa sair do player por acidente
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        return when (event.keyCode) {
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_MENU -> true
            else -> super.dispatchKeyEvent(event)
        }
    }

    companion object {
        private const val TAG = "A3K/Player"
    }
}
