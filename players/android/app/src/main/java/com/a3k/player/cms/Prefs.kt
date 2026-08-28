package com.a3k.player.cms

import android.content.Context
import android.content.pm.ActivityInfo

/** Configuracao persistida do player. */
object Prefs {
    private const val FILE = "a3k_player"
    private const val K_URL = "cms_url"
    private const val K_CODE = "pair_code"
    private const val K_ORIENT = "orientation" // "landscape" | "portrait" | "auto"

    private fun sp(c: Context) = c.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    /** URL base do CMS, sem barra final. Vazio = nao configurado. */
    fun cmsUrl(c: Context): String = sp(c).getString(K_URL, "")!!.trimEnd('/')

    fun isConfigured(c: Context): Boolean = cmsUrl(c).isNotEmpty()

    fun pairCode(c: Context): String = sp(c).getString(K_CODE, "")!!.trim()

    fun orientation(c: Context): String = sp(c).getString(K_ORIENT, "landscape")!!

    fun save(c: Context, url: String, code: String, orientation: String) {
        sp(c).edit()
            .putString(K_URL, url.trim().trimEnd('/'))
            .putString(K_CODE, code.trim())
            .putString(K_ORIENT, orientation)
            .apply()
    }

    /** Limpa o codigo apos parear (evita reenviar codigo ja consumido). */
    fun clearPairCode(c: Context) {
        sp(c).edit().remove(K_CODE).apply()
    }

    fun requestedOrientation(c: Context): Int = when (orientation(c)) {
        "portrait" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
        "auto" -> ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
        else -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    }

    /** URL que o WebView carrega. Anexa ?code= so quando ha codigo configurado. */
    fun playerUrl(c: Context): String {
        val base = cmsUrl(c)
        val code = pairCode(c)
        return if (code.isEmpty()) "$base/player/" else "$base/player/?code=$code"
    }
}
