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
        // Reiniciar o aparelho recomeca do zero: se o F1 tinha parado, limpa a
        // flag e sobe o player sozinho (o "stopped" so vale dentro da sessao).
        if (Prefs.isStopped(context)) Prefs.setStopped(context, false)

        Watchdog.arm(context)
        Autostart.launch(context)
    }

    companion object {
        private const val TAG = "A3K/Boot"
    }
}
