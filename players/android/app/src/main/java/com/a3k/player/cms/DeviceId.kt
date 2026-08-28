package com.a3k.player.cms

import android.content.Context
import android.provider.Settings
import android.util.Log
import java.io.File
import java.net.NetworkInterface
import java.util.UUID

/**
 * Identidade fisica do aparelho, usada como `hardware_id` no pareamento.
 *
 * Prioridade:
 *   1. MAC do eth0            (mini PC / signage — unico por NIC, o mais confiavel)
 *   2. MAC do wlan0           (pode vir aleatorizado no Android 10+ de fabrica)
 *   3. MAC via NetworkInterface (qualquer, se nao for falso 02:.. / 00:..)
 *   4. ANDROID_ID            (estavel por aparelho + assinatura; sobrevive reinstalacao)
 *   5. UUID aleatorio         (persistido; ultimo recurso)
 *
 * MAC NAO e persistido — e relido a cada chamada. Assim, clonar a imagem do
 * disco nao clona a identidade: cada aparelho recai no seu proprio MAC.
 * So os itens 4/5 sao gravados em filesDir/device_id.
 */
object DeviceId {

    private const val FAKE_1 = "02:00:00:00:00:00"
    private const val FAKE_2 = "00:00:00:00:00:00"
    private val MAC_RE = Regex("^([0-9a-f]{2}:){5}[0-9a-f]{2}$")

    fun get(context: Context): String {
        macFromSys("eth0")?.let { return "mac-$it" }
        macFromSys("wlan0")?.let { return "mac-$it" }
        macFromNetworkInterfaces()?.let { return "mac-$it" }

        val cache = File(context.filesDir, "device_id")
        runCatching { cache.readText().trim() }.getOrNull()
            ?.takeIf { it.isNotEmpty() }
            ?.let { return it }

        val fallback = androidId(context)?.let { "aid-$it" } ?: "rnd-${UUID.randomUUID()}"
        runCatching { cache.writeText(fallback) }
        Log.i(TAG, "sem MAC utilizavel — usando id persistido")
        return fallback
    }

    private fun macFromSys(iface: String): String? = runCatching {
        val raw = File("/sys/class/net/$iface/address").readText().trim().lowercase()
        raw.takeIf { it.matches(MAC_RE) && it != FAKE_1 && it != FAKE_2 }?.replace(":", "")
    }.getOrNull()

    private fun macFromNetworkInterfaces(): String? = runCatching {
        NetworkInterface.getNetworkInterfaces().toList()
            .asSequence()
            .filter { !it.isLoopback && !it.isVirtual }
            .mapNotNull { ni ->
                val hw = ni.hardwareAddress ?: return@mapNotNull null
                if (hw.size != 6) return@mapNotNull null
                val s = hw.joinToString(":") { "%02x".format(it) }
                if (s == FAKE_1 || s == FAKE_2) null else s.replace(":", "")
            }
            .firstOrNull()
    }.getOrNull()

    @Suppress("HardwareIds")
    private fun androidId(context: Context): String? = runCatching {
        Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
            ?.takeIf { it.isNotBlank() && it != "9774d56d682e549c" } // valor bugado de alguns aparelhos antigos
    }.getOrNull()

    private const val TAG = "A3K/DeviceId"
}
