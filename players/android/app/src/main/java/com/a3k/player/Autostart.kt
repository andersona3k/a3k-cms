package com.a3k.player

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Abre o PlayerActivity de fora de uma Activity (boot / watchdog).
 * Android 10+ bloqueia startActivity em background, entao alem do startActivity
 * direto dispara uma notificacao full-screen — o sistema converte em abertura
 * da tela. Boxes de signage costumam ter SYSTEM_ALERT_WINDOW ja concedido, o que
 * tambem libera o startActivity direto.
 */
object Autostart {
    private const val TAG = "A3K/Autostart"
    private const val CHANNEL = "a3k_boot"
    private const val NOTIF_ID = 71

    private fun ensureChannel(c: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = c.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Inicializacao do player", NotificationManager.IMPORTANCE_HIGH)
            )
        }
    }

    fun launch(c: Context) {
        val intent = Intent(c, PlayerActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)

        runCatching { c.startActivity(intent) }
            .onFailure { Log.w(TAG, "startActivity direto bloqueado: $it") }

        ensureChannel(c)
        val pi = PendingIntent.getActivity(
            c, NOTIF_ID, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val n = Notification.Builder(c, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("A3K Player")
            .setContentText("Abrindo o player…")
            .setContentIntent(pi)
            .setFullScreenIntent(pi, true)
            .setAutoCancel(true)
            .build()
        runCatching { c.getSystemService(NotificationManager::class.java)?.notify(NOTIF_ID, n) }
            .onFailure { Log.w(TAG, "notif full-screen falhou: $it") }
    }
}
