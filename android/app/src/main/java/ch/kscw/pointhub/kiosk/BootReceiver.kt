package ch.kscw.pointhub.kiosk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import ch.kscw.pointhub.MainActivity

/**
 * After boot, and after a self-update replaced the APK, bring the console back. Only a device
 * owner may start an activity from the background on Android 10+; otherwise the HOME role (the
 * system launches its home app at boot) or a tap on the icon does it, and this does nothing.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> Unit
            else -> return
        }
        if (!Kiosk.isDeviceOwner(context)) return
        try {
            context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            Log.w("BootReceiver", "could not start console", e)
        }
    }
}
