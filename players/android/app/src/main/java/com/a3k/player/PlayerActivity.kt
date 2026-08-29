package com.a3k.player

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
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
import android.view.PixelCopy
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
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
        wv.addJavascriptInterface(Bridge(), "A3K")

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
        val want = Prefs.requestedOrientation(this)
        if (requestedOrientation != want) requestedOrientation = want
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

    /**
     * F2: gira a TELA 90° horario. A orientação agora é do DEVICE (servidor).
     * Chama window.__a3kRotate() no player web — ele tem device.id + token, faz
     * POST /orientation {rotate90} e re-busca o manifest (aplica via CSS). Vale
     * igual no browser e no Android e persiste central (sobrevive reinstalação).
     */
    private fun rotate90cw() {
        Toast.makeText(this, "Girando a tela…", Toast.LENGTH_SHORT).show()
        webView?.evaluateJavascript("window.__a3kRotate && window.__a3kRotate()", null)
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

    // ---- ponte JS p/ o player web (window.A3K) ----
    inner class Bridge {
        @JavascriptInterface
        fun clearCache() {
            ui.post {
                runCatching { cache.clearAll() }.onFailure { Log.w(TAG, "cache.clear", it) }
                webView?.clearCache(true)
            }
        }

        @JavascriptInterface
        fun captureUpload(cmdId: String?, url: String, token: String) {
            ui.post { doCaptureUpload(cmdId, url, token) }
        }
    }

    private fun shotCallback(cmdId: String?, ok: Boolean, detailOrBody: String) {
        val urlMatch = if (ok) Regex("\"url\"\\s*:\\s*\"([^\"]+)\"").find(detailOrBody)?.groupValues?.get(1) else null
        val json = buildString {
            append("{\"ok\":").append(ok)
            if (urlMatch != null) append(",\"url\":\"").append(urlMatch).append("\"")
            if (!ok) append(",\"error\":\"").append(detailOrBody.replace("\"", "'").replace("\n", " ").take(200)).append("\"")
            append("}")
        }
        val idArg = if (cmdId.isNullOrEmpty() || cmdId == "null") "null" else "'$cmdId'"
        webView?.evaluateJavascript("window.__a3kShot && window.__a3kShot($idArg, '$json')", null)
    }

    private fun doCaptureUpload(cmdId: String?, url: String, token: String) {
        val w = window.decorView.width
        val h = window.decorView.height
        if (w <= 0 || h <= 0) { shotCallback(cmdId, false, "janela sem tamanho"); return }
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)

        fun finishBitmap() {
            Thread {
                val r = runCatching {
                    val baos = java.io.ByteArrayOutputStream()
                    bmp.compress(Bitmap.CompressFormat.JPEG, 70, baos)
                    bmp.recycle()
                    uploadJpeg(url, token, baos.toByteArray())
                }
                ui.post {
                    r.onSuccess { shotCallback(cmdId, true, it) }
                     .onFailure { shotCallback(cmdId, false, it.message ?: "upload falhou") }
                }
            }.start()
        }

        try {
            // PixelCopy pega o surface real (inclui vídeo/GL), diferente de View.draw
            PixelCopy.request(window, bmp, { result ->
                if (result == PixelCopy.SUCCESS) finishBitmap()
                else {
                    // fallback: desenha a hierarquia de views (imagens ok, vídeo pode sair preto)
                    runCatching { webView?.draw(Canvas(bmp)) }
                    finishBitmap()
                }
            }, ui)
        } catch (t: Throwable) {
            runCatching { webView?.draw(Canvas(bmp)) }
            finishBitmap()
        }
    }

    private fun uploadJpeg(urlStr: String, token: String, jpeg: ByteArray): String {
        val boundary = "----a3k${System.currentTimeMillis()}"
        val conn = (java.net.URL(urlStr).openConnection() as java.net.HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 15000; readTimeout = 30000
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
        }
        conn.outputStream.use { os ->
            os.write(("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"s.jpg\"\r\n" +
                "Content-Type: image/jpeg\r\n\r\n").toByteArray())
            os.write(jpeg)
            os.write("\r\n--$boundary--\r\n".toByteArray())
        }
        val code = conn.responseCode
        val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
            ?.bufferedReader()?.use { it.readText() } ?: ""
        conn.disconnect()
        if (code !in 200..299) throw RuntimeException("HTTP $code: ${body.take(160)}")
        return body
    }

    companion object {
        private const val TAG = "A3K/Player"
        private const val STOP_PASSWORD = "102030"
    }
}
