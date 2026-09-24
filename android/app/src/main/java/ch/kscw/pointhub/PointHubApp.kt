package ch.kscw.pointhub

import android.app.Activity
import android.app.Application
import android.os.Bundle
import ch.kscw.pointhub.net.BoardNetwork
import ch.kscw.pointhub.store.AdminPin
import ch.kscw.pointhub.store.BackupStore
import ch.kscw.pointhub.store.Prefs
import ch.kscw.pointhub.store.ScheduleStore
import ch.kscw.pointhub.store.SecretStore
import ch.kscw.pointhub.update.UpdateManager
import java.io.File
import java.lang.ref.WeakReference

/** Process-wide singletons, and which of our activities is currently in front. */
class PointHubApp : Application() {
    lateinit var prefs: Prefs; private set
    lateinit var secrets: SecretStore; private set
    lateinit var backups: BackupStore; private set
    lateinit var schedule: ScheduleStore; private set
    lateinit var adminPin: AdminPin; private set
    lateinit var boardNetwork: BoardNetwork; private set
    lateinit var updates: UpdateManager; private set

    /** Admin chose "Exit kiosk": don't re-pin until "Resume kiosk" or the next app start. */
    @Volatile var kioskSuspended = false

    private var resumed: WeakReference<Activity>? = null
    val resumedActivity: Activity? get() = resumed?.get()

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        secrets = SecretStore(this)
        backups = BackupStore(File(filesDir, "backups"))
        schedule = ScheduleStore(File(filesDir, "schedule.json"))
        adminPin = AdminPin(prefs)
        boardNetwork = BoardNetwork(this)
        updates = UpdateManager(this)

        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) {
                resumed = WeakReference(activity)
                updates.onActivityResumed(activity)
            }
            override fun onActivityPaused(activity: Activity) {
                if (resumed?.get() === activity) resumed = null
            }
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityStarted(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
    }
}

val Activity.pointHub: PointHubApp get() = application as PointHubApp
