package com.a3k.player

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.util.Log
import com.a3k.player.cms.Prefs

/**
 * Vigia leve baseado em AlarmManager (sem foreground service, evita as regras
 * de FGS do Android 14). A cada ~4 min checa se o PlayerActivity deu sinal de
 * vida; se nao, reabre. Sobrevive a morte do processo; precisa ser re-armado
 * no boot (BootReceiver) e no onResume do player.
 */
object Watchdog {
    private const val INTERVAL_MS = 4 * 60 * 1000L
    private const val STALE_MS = 3 * 60 * 1000L
    private const val REQ = 7

    /** Ultimo "sinal de vida" do player, em elapsedRealtime(). */
    @Volatile var lastAlive: Long = 0L
    fun beat() { lastAlive = SystemClock.elapsedRealtime() }

    fun arm(context: Context) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        am.setInexactRepeating(
            AlarmManager.ELAPSED_REALTIME_WAKEUP,
            SystemClock.elapsedRealtime() + INTERVAL_MS,
            INTERVAL_MS,
            pending(context),
        )
        Log.i(TAG, "armado (intervalo ${INTERVAL_MS / 1000}s)")
    }

    fun disarm(context: Context) {
        (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pending(context))
    }

    private fun pending(context: Context): PendingIntent {
        val i = Intent(context, WatchdogReceiver::class.java).setAction("com.a3k.player.WATCHDOG")
        return PendingIntent.getBroadcast(
            context, REQ, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private const val TAG = "A3K/Watchdog"

    class Receiver : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent?) {
            if (!Prefs.isConfigured(context)) return
            val age = SystemClock.elapsedRealtime() - lastAlive
            val stale = lastAlive == 0L || age > STALE_MS
            Log.i(TAG, "check: lastAlive=${lastAlive} age=${age}ms stale=$stale")
            if (stale) {
                val launch = Intent(context, PlayerActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                }
                runCatching { context.startActivity(launch) }
                    .onFailure { Log.w(TAG, "relaunch falhou", it) }
            }
        }
    }
}

/** Alias de classe para o AndroidManifest (nomes de classe internos nao sao referenciaveis la). */
class WatchdogReceiver : BroadcastReceiver() {
    private val delegate = Watchdog.Receiver()
    override fun onReceive(context: Context, intent: Intent?) = delegate.onReceive(context, intent)
}
