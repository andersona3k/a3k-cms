package com.a3k.player

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.a3k.player.cms.Prefs

/** Sobe o player no boot (autostart). Alguns fabricantes exigem habilitar
 *  "iniciar automaticamente" nas configuracoes do aparelho. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        Log.i(TAG, "boot: $action")
        if (!Prefs.isConfigured(context)) return

        Watchdog.arm(context)

        val launch = Intent(context, PlayerActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        runCatching { context.startActivity(launch) }
            .onFailure { Log.w(TAG, "startActivity no boot falhou; watchdog assume", it) }
    }

    companion object {
        private const val TAG = "A3K/Boot"
    }
}
