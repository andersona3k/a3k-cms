package com.a3k.player.cms

import android.content.Context
import android.content.pm.ActivityInfo
import android.net.Uri

/** Configuracao persistida do player. */
object Prefs {
    private const val FILE = "a3k_player"
    private const val K_URL = "cms_url"
    private const val K_CODE = "pair_code"
    private const val K_ORIENT = "orientation" // "landscape" | "portrait" | "auto"
    private const val K_MANUAL_ROT = "manual_rot" // -1 = usa K_ORIENT; 0..3 = passos de 90° horario (F2)
    private const val K_STOPPED = "stopped"        // true = F1 parou o player; nao relancar

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

    /** F2: rotacao manual em passos de 90° horario. -1 = sem override (usa K_ORIENT). */
    fun manualRotation(c: Context): Int = sp(c).getInt(K_MANUAL_ROT, -1)

    fun setManualRotation(c: Context, steps: Int) {
        sp(c).edit().putInt(K_MANUAL_ROT, ((steps % 4) + 4) % 4).commit()
    }

    /** F1: player parado pelo operador. BootReceiver/Watchdog nao devem relancar. */
    fun isStopped(c: Context): Boolean = sp(c).getBoolean(K_STOPPED, false)

    fun setStopped(c: Context, stopped: Boolean) {
        // commit() (sincrono): logo apos o F1 a Activity encerra e o processo
        // pode morrer antes de um apply() assincrono chegar ao disco.
        sp(c).edit().putBoolean(K_STOPPED, stopped).commit()
    }

    fun requestedOrientation(c: Context): Int {
        val m = manualRotation(c)
        if (m in 0..3) return when (m) {
            1 -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            2 -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE
            3 -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT
            else -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        }
        return when (orientation(c)) {
            "portrait" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
            "auto" -> ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
            else -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        }
    }

    /**
     * URL que o WebView carrega. Sempre injeta ?hw= (identidade fisica do
     * aparelho); anexa &code= so quando ha codigo de pareamento configurado.
     */
    fun playerUrl(c: Context): String {
        val b = Uri.parse(cmsUrl(c) + "/player/").buildUpon()
        b.appendQueryParameter("hw", DeviceId.get(c))
        pairCode(c).takeIf { it.isNotEmpty() }?.let { b.appendQueryParameter("code", it) }
        return b.build().toString()
    }
}
