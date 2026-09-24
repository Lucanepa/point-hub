package ch.kscw.pointhub

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.pm.PackageInfoCompat
import ch.kscw.pointhub.kiosk.Kiosk
import ch.kscw.pointhub.net.LinkKind
import ch.kscw.pointhub.net.NetState
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object AppInfo {
    fun versionName(ctx: Context): String =
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "?"

    fun versionCode(ctx: Context): Long =
        PackageInfoCompat.getLongVersionCode(ctx.packageManager.getPackageInfo(ctx.packageName, 0))

    /** The `getInfo()` JSON (see BRIDGE.md): five fixed keys, then extras. */
    fun json(ctx: Context, app: PointHubApp): JSONObject {
        val net = app.boardNetwork.state.value
        return JSONObject()
            .put("app", "pointhub-android")
            .put("versionCode", versionCode(ctx))
            .put("versionName", versionName(ctx))
            .put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
            .put("android", "${Build.VERSION.RELEASE} (${Build.VERSION.SDK_INT})")
            .put("origin", (net as? NetState.Found)?.origin ?: JSONObject.NULL)
            .put("network", when ((net as? NetState.Found)?.kind) {
                LinkKind.WIFI -> "wifi-bound"
                LinkKind.ETHERNET -> "ethernet-bound"
                else -> "default"
            })
            .put("deviceOwner", Kiosk.isDeviceOwner(ctx))
            .put("lockTask", Kiosk.lockTaskLabel(ctx))
    }
}

/** Zips the backups (+ schedule + a manifest) into a document the volunteer picked via SAF. */
object BackupExporter {
    fun defaultName(now: Long = System.currentTimeMillis()): String =
        "pointhub-backups-" + SimpleDateFormat("yyyyMMdd-HHmm", Locale.ROOT).format(Date(now)) + ".zip"

    /** Returns the number of backups written. Throws IOException. */
    fun write(ctx: Context, app: PointHubApp, uri: Uri): Int {
        val extras = LinkedHashMap<String, ByteArray>()
        app.schedule.bytesOrNull()?.let { extras["schedule.json"] = it }
        val manifest = JSONObject()
            .put("info", AppInfo.json(ctx, app))
            .put("backups", JSONArray(app.backups.listJson()))
        extras["manifest.json"] = manifest.toString(2).toByteArray(Charsets.UTF_8)
        val out = ctx.contentResolver.openOutputStream(uri, "wt") ?: ctx.contentResolver.openOutputStream(uri, "w")
            ?: throw IOException("cannot open $uri")
        return out.use { app.backups.writeZip(it, extras) }
    }

    /** CREATE_DOCUMENT for a zip, starting in Downloads where the picker supports the hint. */
    class CreateZip : ActivityResultContracts.CreateDocument("application/zip") {
        override fun createIntent(context: Context, input: String): Intent {
            val i = super.createIntent(context, input)
            i.putExtra(
                DocumentsContract.EXTRA_INITIAL_URI,
                DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:Download"),
            )
            return i
        }
    }
}
