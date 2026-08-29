package com.a3k.player

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.InputType
import android.util.Log
import android.view.Gravity
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
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.widget.doAfterTextChanged
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

    // F1: overlay de senha para sair
    private var stopOverlay: View? = null
    private var stopInput: EditText? = null
    private var stopErr: TextView? = null
    private val stopTimeout = Runnable { dismissStopPrompt() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!Prefs.isConfigured(this)) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }

        // Se chegou aqui e o player estava "parado" (F1), foi o operador que
        // reabriu o app manualmente -> volta a operar normalmente.
        if (Prefs.isStopped(this)) {
            Prefs.setStopped(this, false)
            Watchdog.arm(this)
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
        container.post { applyManualRotation() }
    }

    /**
     * F2: rotaciona a VIEW do WebView (nao o requestedOrientation). Passo de 90°
     * horario, deterministico, imune ao sensor/ROM. Para 90/270 troca w<->h e
     * centraliza. Persistente (Prefs.manual_rot).
     */
    private fun applyManualRotation() {
        val wv = webView ?: return
        val steps = Prefs.manualRotation(this)
        val w = container.width
        val h = container.height
        if (w == 0 || h == 0) { container.post { applyManualRotation() }; return }
        wv.layoutParams = if (steps % 2 == 1) {
            FrameLayout.LayoutParams(h, w).apply { gravity = Gravity.CENTER }
        } else {
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        }
        wv.rotation = steps * 90f
        // informa o player web (opcional; para log/diagnostico do lado do HTML)
        wv.evaluateJavascript("window.__a3kDeviceRotation=${steps * 90};", null)
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
        val want = Prefs.requestedOrientation(this)
        if (requestedOrientation != want) requestedOrientation = want
        container.post { applyManualRotation() }
        Watchdog.arm(this)
        Watchdog.beat()
        ui.removeCallbacks(beat)
        ui.post(beat)
        webView?.onResume()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        requestedOrientation = Prefs.requestedOrientation(this)
        webView?.loadUrl(Prefs.playerUrl(this))
        container.post { applyManualRotation() }
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

    // Teclado conectado. Com o overlay de senha aberto: Enter/OK confirma,
    // Esc/Back/Cancelar fecha e volta a reproduzir; as demais teclas digitam.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (stopOverlay != null) {
            if (event.action == KeyEvent.ACTION_UP) {
                when (event.keyCode) {
                    KeyEvent.KEYCODE_ESCAPE, KeyEvent.KEYCODE_BACK -> { dismissStopPrompt(); return true }
                    KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER, KeyEvent.KEYCODE_DPAD_CENTER -> {
                        submitStopPassword(); return true
                    }
                }
            }
            resetStopTimer()
            return super.dispatchKeyEvent(event)
        }
        if (event.action == KeyEvent.ACTION_DOWN) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_F1 -> { showStopPrompt(); return true }
                KeyEvent.KEYCODE_F2 -> { rotate90cw(); return true }
            }
        }
        return when (event.keyCode) {
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_MENU -> true
            else -> super.dispatchKeyEvent(event)
        }
    }

    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()

    /** F2: gira o conteudo 90° horario a cada toque (view-based, persistente). */
    private fun rotate90cw() {
        Prefs.setManualRotation(this, Prefs.manualRotation(this) + 1)
        applyManualRotation()
        Toast.makeText(this, "Tela girada", Toast.LENGTH_SHORT).show()
    }

    /** F1: pede a senha; ok -> fecha o app. 15s sem acao -> some e segue tocando. */
    private fun showStopPrompt() {
        if (stopOverlay != null) return
        val ctx = this

        val root = FrameLayout(ctx).apply {
            setBackgroundColor(0xCC000000.toInt())
            isClickable = true
            isFocusableInTouchMode = true
        }
        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF111A24.toInt())
            setPadding(dp(28), dp(24), dp(28), dp(20))
            layoutParams = FrameLayout.LayoutParams(dp(320), FrameLayout.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.CENTER
            }
        }
        val title = TextView(ctx).apply {
            text = "Senha para sair do player"
            setTextColor(0xFFFFFFFF.toInt()); textSize = 16f
        }
        val input = EditText(ctx).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = "senha"
            setTextColor(0xFFFFFFFF.toInt()); setHintTextColor(0xFF6B7D8F.toInt())
        }
        val err = TextView(ctx).apply {
            setTextColor(0xFFE8776B.toInt()); textSize = 12f; visibility = View.GONE
        }
        val rowBtns = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            setPadding(0, dp(12), 0, 0)
        }
        val cancel = Button(ctx).apply { text = "Cancelar" }
        val ok = Button(ctx).apply { text = "OK" }
        rowBtns.addView(cancel)
        rowBtns.addView(ok)

        card.addView(title)
        card.addView(input)
        card.addView(err)
        card.addView(rowBtns)
        root.addView(card)

        input.doAfterTextChanged { resetStopTimer() }
        input.setOnEditorActionListener { _, _, _ -> submitStopPassword(); true }
        cancel.setOnClickListener { dismissStopPrompt() }
        ok.setOnClickListener { submitStopPassword() }

        container.addView(root)
        stopOverlay = root
        stopInput = input
        stopErr = err
        input.requestFocus()
        resetStopTimer()
    }

    private fun resetStopTimer() {
        ui.removeCallbacks(stopTimeout)
        ui.postDelayed(stopTimeout, 15_000)
    }

    private fun submitStopPassword() {
        val inp = stopInput ?: return
        if (inp.text.toString() == STOP_PASSWORD) {
            stopPlayer()
        } else {
            stopErr?.apply { text = "Senha incorreta"; visibility = View.VISIBLE }
            inp.setText("")
            resetStopTimer()
        }
    }

    private fun dismissStopPrompt() {
        ui.removeCallbacks(stopTimeout)
        stopOverlay?.let { container.removeView(it) }
        stopOverlay = null
        stopInput = null
        stopErr = null
        webView?.requestFocus()
    }

    private fun stopPlayer() {
        Prefs.setStopped(this, true)   // commit() sincrono
        Watchdog.disarm(this)
        dismissStopPrompt()
        // finishAndRemoveTask sozinho: fecha a Activity e tira da lista de
        // recentes (a tela volta pro launcher). NADA de killProcess aqui — matar
        // o processo logo apos escrever prefs corrompe o arquivo.
        finishAndRemoveTask()
    }

    companion object {
        private const val TAG = "A3K/Player"
        private const val STOP_PASSWORD = "102030"
    }
}
