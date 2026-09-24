package ch.kscw.pointhub.kiosk

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.app.admin.SystemUpdatePolicy
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.util.Log
import ch.kscw.pointhub.AdminReceiver
import ch.kscw.pointhub.net.wifiRequestPermission
import ch.kscw.pointhub.pointHub

/**
 * Lock task ("screen pinning", or a real kiosk when the app is device owner), the optional HOME
 * role, and how other screens are opened while pinned:
 *
 * - [launchInTask]: screens that open INSIDE our task (the save-file picker and the runtime
 *   permission dialog, both started for a result). Lock task allows these, so it stays on:
 *   volunteers reach them from the console / offline screen without ever unpinning the tablet.
 * - [suspendFor]: screens in ANOTHER task (Settings, app info, the installer, the home-role
 *   dialog, the Wi-Fi add-networks sheet, the Wi-Fi "Connect to device" dialog). Lock task blocks
 *   those, so it is stopped first. Only for paths behind the admin PIN (or before pinning began).
 */
object Kiosk {
    private const val TAG = "Kiosk"

    /** Set by [suspendFor]: the next unpinned resume is ours, so pin again. */
    @Volatile private var suspendedForExternal = false
    /**
     * Without device owner, the system "Pin app?" prompt is shown at most once per process start
     * (and again after our own [suspendFor] or "Resume kiosk"). A volunteer who declines it is not
     * asked again on the next screen-on or dialog close, i.e. not in the middle of a match.
     */
    @Volatile private var pinPromptedThisProcess = false
    @Volatile private var ownerPoliciesApplied = false

    fun admin(ctx: Context) = ComponentName(ctx, AdminReceiver::class.java)
    fun homeAlias(ctx: Context) = ComponentName(ctx.packageName, "${ctx.packageName}.HomeAlias")

    fun isDeviceOwner(ctx: Context): Boolean =
        ctx.getSystemService(DevicePolicyManager::class.java)?.isDeviceOwnerApp(ctx.packageName) == true

    fun lockTaskState(ctx: Context): Int =
        ctx.getSystemService(ActivityManager::class.java)?.lockTaskModeState ?: ActivityManager.LOCK_TASK_MODE_NONE

    fun lockTaskLabel(ctx: Context): String = when (lockTaskState(ctx)) {
        ActivityManager.LOCK_TASK_MODE_LOCKED -> "locked"
        ActivityManager.LOCK_TASK_MODE_PINNED -> "pinned"
        else -> "none"
    }

    fun isLockTaskActive(ctx: Context): Boolean = lockTaskState(ctx) != ActivityManager.LOCK_TASK_MODE_NONE

    /** Called from MainActivity.onResume. */
    fun enter(activity: Activity) {
        val app = activity.pointHub
        if (app.kioskSuspended) return
        val owner = isDeviceOwner(activity)
        if (owner) applyOwnerPolicies(activity)
        if (!owner && !app.prefs.kioskPinning) return
        if (isLockTaskActive(activity)) {
            suspendedForExternal = false
            return
        }
        // Device owner: silent, so always re-enter. Otherwise only on the first resume after
        // process start, or right after we unpinned ourselves for an admin screen.
        if (!owner && pinPromptedThisProcess && !suspendedForExternal) return
        suspendedForExternal = false
        pinPromptedThisProcess = true
        try {
            activity.startLockTask()
        } catch (e: Exception) {
            Log.w(TAG, "startLockTask failed (App pinning disabled in Settings?)", e)
        }
    }

    private fun applyOwnerPolicies(ctx: Context) {
        if (ownerPoliciesApplied) return
        val dpm = ctx.getSystemService(DevicePolicyManager::class.java) ?: return
        val admin = admin(ctx)
        val pkg = ctx.packageName
        fun tryDo(what: String, block: () -> Unit) = try { block() } catch (e: Exception) { Log.w(TAG, "$what failed", e) }
        // The save-file picker opens in our task, which lock task allows anyway; allow-listing it
        // as well keeps the export working on builds that treat it as a separate task.
        tryDo("setLockTaskPackages") { dpm.setLockTaskPackages(admin, (listOf(pkg) + listOfNotNull(filePickerPackage(ctx))).distinct().toTypedArray()) }
        // Joining the board Wi-Fi needs this runtime permission; as device owner grant it directly
        // instead of showing a dialog.
        wifiRequestPermission()?.let { perm ->
            tryDo("grant $perm") { dpm.setPermissionGrantState(admin, pkg, perm, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED) }
        }
        if (Build.VERSION.SDK_INT >= 28) {
            tryDo("setLockTaskFeatures") { dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS) }
        }
        tryDo("setStatusBarDisabled") { dpm.setStatusBarDisabled(admin, true) }
        tryDo("setKeyguardDisabled") { dpm.setKeyguardDisabled(admin, true) }
        tryDo("stayOnWhilePluggedIn") { dpm.setGlobalSetting(admin, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, "7") }
        tryDo("home") {
            setHomeAliasEnabled(ctx, true)
            dpm.addPersistentPreferredActivity(admin, IntentFilter(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_HOME); addCategory(Intent.CATEGORY_DEFAULT)
            }, homeAlias(ctx))
        }
        tryDo("systemUpdatePolicy") { dpm.setSystemUpdatePolicy(admin, SystemUpdatePolicy.createWindowedInstallPolicy(120, 360)) }
        ownerPoliciesApplied = true
    }

    private fun filePickerPackage(ctx: Context): String? = try {
        val i = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/zip")
        ctx.packageManager.resolveActivity(i, 0)?.activityInfo?.packageName?.takeIf { it != "android" }
    } catch (_: Exception) {
        null
    }

    /**
     * Open a screen that runs inside our own task (a picker or permission dialog started for a
     * result). Lock task stays on: nothing here unpins the tablet.
     */
    fun launchInTask(launch: () -> Unit): Boolean = try {
        launch()
        true
    } catch (e: ActivityNotFoundException) {
        Log.w(TAG, "no activity for intent", e)
        false
    } catch (e: SecurityException) {
        Log.w(TAG, "launch refused", e)
        false
    }

    /**
     * Leave lock task so a screen in ANOTHER task can open; the next MainActivity resume pins
     * again. ADMIN PATHS ONLY (behind the admin PIN): while it is open the tablet is unpinned.
     * With "Ask for PIN before unpinning" on, Android also locks the screen here.
     */
    fun suspendFor(activity: Activity, launch: () -> Unit): Boolean {
        if (isLockTaskActive(activity)) {
            try {
                activity.stopLockTask()
                suspendedForExternal = true
            } catch (e: Exception) {
                Log.w(TAG, "stopLockTask failed", e)
            }
        }
        return launchInTask(launch)
    }

    /** Admin menu: "Exit kiosk". Stays out until [resume] or the next app start. */
    fun exit(activity: Activity) {
        activity.pointHub.kioskSuspended = true
        try { activity.stopLockTask() } catch (_: Exception) {}
        if (isDeviceOwner(activity)) {
            try {
                activity.getSystemService(DevicePolicyManager::class.java)?.setStatusBarDisabled(admin(activity), false)
            } catch (_: Exception) {}
            ownerPoliciesApplied = false
        }
    }

    fun resume(activity: Activity) {
        activity.pointHub.kioskSuspended = false
        pinPromptedThisProcess = false
    }

    /**
     * Admin menu: "Exit app". As home screen (or device owner, which pins HOME to us) Android
     * would relaunch us the moment we finish, so hand HOME back to the other launcher for this
     * exit and remember to take it again on the next start of the app ([restoreAfterExit]).
     */
    fun exitApp(activity: Activity) {
        val app = activity.pointHub
        exit(activity)
        val home = isHomeAliasEnabled(activity)
        app.prefs.restoreHomeOnStart = home
        app.prefs.exitedByAdmin = true
        if (home) setHomeAliasEnabled(activity, false)
    }

    /** First thing in MainActivity.onCreate: undo an admin "Exit app" (kiosk and home role). */
    fun restoreAfterExit(activity: Activity) {
        val prefs = activity.pointHub.prefs
        if (!prefs.exitedByAdmin) return
        prefs.exitedByAdmin = false
        resume(activity)
        if (prefs.restoreHomeOnStart) {
            prefs.restoreHomeOnStart = false
            // As device owner applyOwnerPolicies (reset by exit()) re-adds the HOME preference.
            try { setHomeAliasEnabled(activity, true) } catch (e: Exception) { Log.w(TAG, "home alias", e) }
        }
    }

    fun isHomeAliasEnabled(ctx: Context): Boolean =
        ctx.packageManager.getComponentEnabledSetting(homeAlias(ctx)) == PackageManager.COMPONENT_ENABLED_STATE_ENABLED

    fun setHomeAliasEnabled(ctx: Context, enabled: Boolean) {
        ctx.packageManager.setComponentEnabledSetting(
            homeAlias(ctx),
            if (enabled) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.DONT_KILL_APP,
        )
        if (!enabled && isDeviceOwner(ctx)) {
            try {
                ctx.getSystemService(DevicePolicyManager::class.java)
                    ?.clearPackagePersistentPreferredActivities(admin(ctx), ctx.packageName)
            } catch (_: Exception) {}
        }
    }

    /** Remove device-owner status (admin menu). Irreversible without adb / factory reset. */
    fun clearDeviceOwner(activity: Activity) {
        val dpm = activity.getSystemService(DevicePolicyManager::class.java) ?: return
        exit(activity)
        try {
            dpm.clearPackagePersistentPreferredActivities(admin(activity), activity.packageName)
            dpm.setLockTaskPackages(admin(activity), arrayOf())
            dpm.setKeyguardDisabled(admin(activity), false)
        } catch (_: Exception) {}
        @Suppress("DEPRECATION")
        dpm.clearDeviceOwnerApp(activity.packageName)
    }
}
