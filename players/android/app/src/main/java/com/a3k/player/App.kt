package com.a3k.player

import android.app.AlarmManager
import android.app.Application
import android.app.PendingIntent
import android.content.Intent
import android.os.SystemClock
import android.util.Log
import com.a3k.player.cms.Prefs
import kotlin.system.exitProcess

class App : Application() {

    override fun onCreate() {
        super.onCreate()

        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, ex ->
            Log.e(TAG, "crash nao tratado em ${thread.name}", ex)
            if (Prefs.isConfigured(this)) scheduleRestart(2_000)
            previous?.uncaughtException(thread, ex)
            exitProcess(2)
        }

        if (Prefs.isConfigured(this)) {
            Watchdog.arm(this)
        }
    }

    /** Reabre o PlayerActivity depois de [delayMs] (usado apos crash). */
    fun scheduleRestart(delayMs: Long) {
        val intent = Intent(this, PlayerActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val pi = PendingIntent.getActivity(
            this, 42, intent,
            PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE
        )
        val am = getSystemService(ALARM_SERVICE) as AlarmManager
        am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + delayMs, pi)
    }

    companion object {
        const val TAG = "A3K/App"
    }
}
