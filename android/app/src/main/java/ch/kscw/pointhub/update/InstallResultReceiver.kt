package ch.kscw.pointhub.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import androidx.core.content.IntentCompat
import ch.kscw.pointhub.PointHubApp

/**
 * Result of a PackageInstaller session. Not exported: only our own PendingIntent (filled in by
 * the system installer) reaches it. It never starts an activity itself (Android 14/15 BAL rules);
 * a pending confirmation is handed to whichever of our activities is in front.
 */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext as PointHubApp
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        val confirm = if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java)
        } else null
        app.updates.onInstallStatus(status, message, confirm)
    }
}
