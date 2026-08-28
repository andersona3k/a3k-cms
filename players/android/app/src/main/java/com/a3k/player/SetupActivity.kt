package com.a3k.player

import android.content.Intent
import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.a3k.player.cms.Prefs
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class SetupActivity : AppCompatActivity() {

    private val orientKeys = listOf("landscape", "portrait", "auto")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)

        val urlInput = findViewById<EditText>(R.id.urlInput)
        val codeInput = findViewById<EditText>(R.id.codeInput)
        val spinner = findViewById<Spinner>(R.id.orientationSpinner)
        val status = findViewById<TextView>(R.id.statusText)

        spinner.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item,
            listOf("Paisagem", "Retrato", "Automática")
        )

        urlInput.setText(Prefs.cmsUrl(this))
        codeInput.setText(Prefs.pairCode(this))
        spinner.setSelection(orientKeys.indexOf(Prefs.orientation(this)).coerceAtLeast(0))

        findViewById<Button>(R.id.testBtn).setOnClickListener {
            val url = normalize(urlInput.text.toString())
            if (url.isEmpty()) { status.text = "Informe o endereço do CMS."; return@setOnClickListener }
            status.text = "Testando $url ..."
            thread {
                val msg = testHealth(url)
                runOnUiThread { status.text = msg }
            }
        }

        findViewById<Button>(R.id.saveBtn).setOnClickListener {
            val url = normalize(urlInput.text.toString())
            if (url.isEmpty()) { status.text = "Informe o endereço do CMS."; return@setOnClickListener }
            Prefs.save(this, url, codeInput.text.toString().trim(), orientKeys[spinner.selectedItemPosition])
            Watchdog.arm(this)
            startActivity(Intent(this, PlayerActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            })
            finish()
        }
    }

    private fun normalize(raw: String): String {
        var s = raw.trim().trimEnd('/')
        if (s.isEmpty()) return ""
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
        return s
    }

    private fun testHealth(base: String): String {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL("$base/api/health").openConnection() as HttpURLConnection).apply {
                connectTimeout = 6000; readTimeout = 6000
            }
            val code = conn.responseCode
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.readText().orEmpty()
            if (code == 200 && body.contains("\"ok\":true")) "OK — CMS respondeu: $body"
            else "Resposta inesperada (HTTP $code): $body"
        } catch (t: Throwable) {
            "Falha ao conectar: ${t.message ?: t.javaClass.simpleName}"
        } finally {
            conn?.disconnect()
        }
    }
}
