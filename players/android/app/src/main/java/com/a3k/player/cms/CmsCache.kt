package com.a3k.player.cms

import android.content.Context
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Cache de disco que da OFFLINE REAL ao player web.
 *
 * Interceta os GET do WebView para o CMS:
 *  - /assets/<arquivo>  -> baixa uma vez para filesDir/cms/media e serve do disco depois;
 *  - /api/devices/:id/manifest -> tenta a rede; salva o ultimo manifest; offline serve o salvo;
 *  - /player, /vendor, "/" (a casca do app) -> network-first com fallback de disco.
 *
 * POST (pair/new, heartbeat) passam direto (retorna null).
 */
class CmsCache(context: Context) {

    private val root = File(context.filesDir, "cms").apply { mkdirs() }
    private val mediaDir = File(root, "media").apply { mkdirs() }
    private val docDir = File(root, "doc").apply { mkdirs() }

    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        if (!request.method.equals("GET", ignoreCase = true)) return null
        val url = request.url
        val scheme = url.scheme ?: return null
        if (scheme != "http" && scheme != "https") return null
        val path = url.path ?: return null
        val headers = request.requestHeaders ?: emptyMap()
        val full = url.toString()

        return try {
            when {
                path.startsWith("/assets/") -> media(full, path.substringAfterLast('/'))
                path.startsWith("/api/devices/") && path.endsWith("/manifest") -> manifest(full, headers)
                path == "/" || path.startsWith("/player") || path.startsWith("/vendor") -> doc(full, headers)
                else -> null // demais /api/* passam direto
            }
        } catch (t: Throwable) {
            Log.w(TAG, "intercept falhou: $full", t)
            null
        }
    }

    // ---------------- midia ----------------

    private fun media(url: String, name: String): WebResourceResponse? {
        val safe = name.ifBlank { "asset.bin" }.replace(Regex("[^A-Za-z0-9._-]"), "_")
        val f = File(mediaDir, safe)
        if (f.exists() && f.length() > 0) return fileResponse(f, mimeOf(safe))

        val tmp = File(mediaDir, "$safe.part")
        return if (download(url, tmp, emptyMap()) && tmp.renameTo(f)) {
            fileResponse(f, mimeOf(safe))
        } else {
            tmp.delete()
            null // deixa o WebView tentar; se offline, o <img>/<video> falha e o player avanca
        }
    }

    // ---------------- manifest ----------------

    private val manifestFile = File(docDir, "manifest.json")

    private fun manifest(url: String, headers: Map<String, String>): WebResourceResponse {
        val res = fetch(url, headers)
        if (res != null) {
            when {
                res.code == 200 && res.body != null -> {
                    runCatching { manifestFile.writeBytes(res.body) }
                    return bytesResponse("application/json", 200, "OK", res.body)
                }
                res.code == 304 -> return bytesResponse("application/json", 304, "Not Modified", ByteArray(0))
                else -> return bytesResponse(
                    res.contentType ?: "application/json", res.code, res.message ?: "", res.body ?: ByteArray(0)
                )
            }
        }
        // sem rede: serve o ultimo manifest conhecido
        if (manifestFile.exists()) {
            return bytesResponse("application/json", 200, "OK", manifestFile.readBytes())
        }
        return bytesResponse("application/json", 503, "Offline", "{\"error\":\"offline, sem manifest em cache\"}".toByteArray())
    }

    // ---------------- casca do app ----------------

    private fun doc(url: String, headers: Map<String, String>): WebResourceResponse? {
        val key = sha1(url.substringBefore('#').substringBefore('?'))
        val body = File(docDir, "$key.body")
        val meta = File(docDir, "$key.ct")

        val res = fetch(url, headers)
        if (res != null && res.code == 200 && res.body != null) {
            runCatching {
                body.writeBytes(res.body)
                meta.writeText(res.contentType ?: guessDocMime(url))
            }
            return bytesResponse(res.contentType ?: guessDocMime(url), 200, "OK", res.body)
        }
        if (body.exists()) {
            val ct = if (meta.exists()) meta.readText() else guessDocMime(url)
            return bytesResponse(ct, 200, "OK", body.readBytes())
        }
        return null
    }

    // ---------------- http ----------------

    private class Fetched(
        val code: Int,
        val message: String?,
        val contentType: String?,
        val body: ByteArray?,
    )

    /** GET com headers repassados (Authorization do device!). null = falha de rede. */
    private fun fetch(url: String, headers: Map<String, String>): Fetched? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 8000
                readTimeout = 20000
                instanceFollowRedirects = true
                headers.forEach { (k, v) -> if (!k.equals("Accept-Encoding", true)) setRequestProperty(k, v) }
            }
            val code = conn.responseCode
            val ctype = conn.contentType
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val bytes = stream?.readBytes()
            Fetched(code, conn.responseMessage, ctype, bytes)
        } catch (t: Throwable) {
            Log.d(TAG, "fetch offline: $url (${t.javaClass.simpleName})")
            null
        } finally {
            conn?.disconnect()
        }
    }

    private fun download(url: String, dest: File, headers: Map<String, String>): Boolean {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 8000
                readTimeout = 30000
                instanceFollowRedirects = true
                headers.forEach { (k, v) -> setRequestProperty(k, v) }
            }
            if (conn.responseCode != 200) return false
            conn.inputStream.use { input -> dest.outputStream().use { input.copyTo(it, 64 * 1024) } }
            dest.length() > 0
        } catch (t: Throwable) {
            Log.d(TAG, "download falhou: $url", t)
            false
        } finally {
            conn?.disconnect()
        }
    }

    // ---------------- helpers ----------------

    /** O WebView so renderiza com o MIME "puro" (sem "; charset=..."). */
    private fun cleanMime(raw: String?, fallback: String = "application/octet-stream"): String {
        val m = raw?.substringBefore(';')?.trim()?.lowercase()
        return if (m.isNullOrEmpty()) fallback else m
    }

    private fun fileResponse(f: File, mime: String) =
        WebResourceResponse(cleanMime(mime), null, 200, "OK", corsHeaders(), FileInputStream(f))

    private fun bytesResponse(mime: String, code: Int, reason: String, body: ByteArray) =
        WebResourceResponse(
            cleanMime(mime, "text/plain"), "utf-8", code, reason.ifBlank { "OK" },
            corsHeaders(), ByteArrayInputStream(body)
        )

    private fun corsHeaders() = mutableMapOf(
        "Access-Control-Allow-Origin" to "*",
        "Cache-Control" to "no-store",
    )

    private fun mimeOf(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "svg" -> "image/svg+xml"
        "bmp" -> "image/bmp"
        "mp4", "m4v" -> "video/mp4"
        "webm" -> "video/webm"
        "mkv" -> "video/x-matroska"
        "mov" -> "video/quicktime"
        "mp3" -> "audio/mpeg"
        "m4a", "aac" -> "audio/mp4"
        "ogg" -> "audio/ogg"
        "wav" -> "audio/wav"
        "json" -> "application/json"
        "js", "mjs" -> "application/javascript"
        "css" -> "text/css"
        "html", "htm" -> "text/html"
        else -> "application/octet-stream"
    }

    private fun guessDocMime(url: String): String = when {
        url.endsWith(".js") || url.endsWith(".mjs") -> "application/javascript"
        url.endsWith(".css") -> "text/css"
        url.endsWith(".json") -> "application/json"
        url.contains("/player") || url.endsWith("/") -> "text/html"
        else -> "text/html"
    }

    private fun sha1(s: String): String =
        MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

    fun clearAll() {
        root.deleteRecursively(); root.mkdirs(); mediaDir.mkdirs(); docDir.mkdirs()
    }

    companion object {
        private const val TAG = "A3K/Cache"
    }
}
