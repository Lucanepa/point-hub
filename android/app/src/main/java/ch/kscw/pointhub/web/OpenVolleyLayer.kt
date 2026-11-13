package ch.kscw.pointhub.web

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentValues
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Message
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.File
import kotlin.concurrent.thread

/**
 * The board's own OpenVolley eScoresheet, full screen over the console (BRIDGE.md "OpenVolley on
 * the board"). A C0270 that serves OpenVolley (pointhub-openvolley.service) has it at
 * `http://<board>:5173`; the console's "Open OpenVolley" button calls `openOpenVolley()`.
 *
 * - A layer in the app's own window, not another activity: the tablet stays pinned, and the page
 *   keeps running while the console is in front again (‹ Point Hub), so the match, its relay link
 *   and what the scorer typed are all still there when they come back.
 * - The process is bound to the board's network (BoardNetwork), so it reaches the board over the
 *   board's Wi-Fi or the cable, as the console does.
 * - Its WebViews load that one origin and nothing else ([OriginPolicy.Allowlist] `only`), and get
 *   no PointHubApp bridge: OpenVolley is not the console. Cloud calls are refused; OpenVolley
 *   queues them itself.
 * - **Second windows.** OpenVolley opens the scoresheet in a window of its own to make the PDF at
 *   the end of a match, and waits for that window's answer (window.opener.postMessage). Each one
 *   opens here as another WebView on top of the page, with its opener intact; "‹ Close" or the
 *   page's own window.close() takes it away.
 * - **Downloads.** OpenVolley saves files (the scoresheet PDF, the match ZIP, exports) as a
 *   `<a download>` of a blob, which a WebView ignores. A script, given only to the OpenVolley
 *   origin, turns that click into a message on a channel only that origin can use; the app writes
 *   the file to Downloads/OpenVolley and says so.
 */
class OpenVolleyLayer(
    private val activity: Activity,
    private val userAgent: String,
    private val debug: Boolean,
) {
    private var layer: LinearLayout? = null
    private var holder: FrameLayout? = null
    private var web: WebView? = null
    private var note: TextView? = null
    private var barButton: Button? = null
    private var origin: String? = null
    /** OpenVolley's own second windows (the scoresheet), top last. */
    private val windows = ArrayList<WebView>()

    val isShown: Boolean get() = layer?.visibility == View.VISIBLE

    /** Show OpenVolley from [origin]; the page already loaded from it comes back as it was. */
    fun show(origin: String) {
        if (layer == null || this.origin != origin) build(origin)
        layer?.visibility = View.VISIBLE
        layer?.bringToFront()
    }

    /** Back to the console. OpenVolley keeps running underneath. */
    fun hide() {
        layer?.visibility = View.GONE
    }

    /** Back: inside the top window's pages, else close a second window; never out of OpenVolley. */
    fun goBack(): Boolean {
        val top = windows.lastOrNull()
        if (top != null) {
            if (top.canGoBack()) top.goBack() else closeWindow(top)
            return true
        }
        val w = web ?: return false
        if (!w.canGoBack()) return false
        w.goBack()
        return true
    }

    fun destroy() {
        windows.toList().forEach { closeWindow(it) }
        web?.let { (it.parent as? ViewGroup)?.removeView(it); it.destroy() }
        web = null
        layer?.let { (it.parent as? ViewGroup)?.removeView(it) }
        layer = null
        holder = null
        origin = null
    }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), activity.resources.displayMetrics).toInt()

    private fun build(origin: String) {
        destroy()
        this.origin = origin
        val root = activity.findViewById<ViewGroup>(android.R.id.content)
        val bar = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#1c1917"))
            setPadding(dp(6), 0, dp(12), 0)
        }
        val button = Button(activity).apply {
            text = "‹ Point Hub"
            isAllCaps = false
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setOnClickListener { windows.lastOrNull()?.let { closeWindow(it) } ?: hide() }
        }
        barButton = button
        bar.addView(button, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(44)))
        bar.addView(TextView(activity).apply {
            text = "OpenVolley eScoresheet on the board"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setPadding(dp(12), 0, 0, 0)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        val h = FrameLayout(activity)
        holder = h
        val wv = newWebView(origin, main = true)
        h.addView(wv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val msg = TextView(activity).apply {
            setBackgroundColor(Color.WHITE)
            setTextColor(Color.parseColor("#1c1917"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            gravity = Gravity.CENTER
            setPadding(dp(32), dp(32), dp(32), dp(32))
            visibility = View.GONE
            setOnClickListener { visibility = View.GONE; wv.reload() }
        }
        h.addView(msg, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        val l = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            // Touches stay in the layer: none reach the console underneath.
            isClickable = true
        }
        l.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        l.addView(h, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(l, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        layer = l
        web = wv
        note = msg
        Log.i(TAG, "OpenVolley from $origin")
        wv.loadUrl("$origin/")
    }

    /** A WebView for OpenVolley: the main page or one of its second windows. */
    @SuppressLint("SetJavaScriptEnabled", "RequiresFeature")
    private fun newWebView(origin: String, main: Boolean): WebView {
        val wv = WebView(activity)
        wv.setBackgroundColor(Color.WHITE)
        ConsoleWebView.configure(wv, Host(origin, main), userAgent)
        // OpenVolley opens its scoresheet in a window of its own (see the class note).
        wv.settings.setSupportMultipleWindows(true)
        wv.settings.javaScriptCanOpenWindowsAutomatically = true
        wv.webChromeClient = Chrome(origin)
        val origins = setOf(origin)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
            WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        ) {
            WebViewCompat.addWebMessageListener(wv, FILES, origins) { _, message, source, isMainFrame, _ ->
                if (!isMainFrame || OriginPolicy.originOf(source.toString()) != origin) return@addWebMessageListener
                onFileMessage(message.data)
            }
            WebViewCompat.addDocumentStartJavaScript(wv, DOWNLOAD_SHIM, origins)
        } else {
            Log.w(TAG, "this WebView cannot route OpenVolley's downloads (too old)")
        }
        wv.setDownloadListener { url, _, _, mime, _ ->
            // Anything the shim did not catch (a plain link to a file): say so instead of nothing.
            Log.w(TAG, "download not handled: $mime ${url.take(80)}")
            toast("This file can't be saved from here.")
        }
        return wv
    }

    private fun openWindow(origin: String, resultMsg: Message?): Boolean {
        val h = holder ?: return false
        val transport = resultMsg?.obj as? WebView.WebViewTransport ?: return false
        val child = newWebView(origin, main = false)
        h.addView(child, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        windows.add(child)
        barButton?.text = "‹ Close"
        transport.webView = child
        resultMsg.sendToTarget()
        Log.i(TAG, "OpenVolley opened a window (${windows.size})")
        return true
    }

    private fun closeWindow(w: WebView) {
        if (!windows.remove(w)) return
        (w.parent as? ViewGroup)?.removeView(w)
        w.destroy()
        if (windows.isEmpty()) barButton?.text = "‹ Point Hub"
    }

    // ---------------------------------------------------------------- downloads

    private fun onFileMessage(data: String?) {
        val j = try { JSONObject(data ?: return) } catch (_: Exception) { return }
        if (j.has("error")) { Log.w(TAG, "download failed in the page: ${j.optString("error").take(200)}"); toast("The file could not be saved."); return }
        val dataUrl = j.optString("dataUrl")
        val comma = dataUrl.indexOf(',')
        if (!dataUrl.startsWith("data:") || comma < 0 || dataUrl.length > MAX_DATA_URL) { toast("The file could not be saved."); return }
        val head = dataUrl.substring(5, comma)
        val mime = head.substringBefore(';').ifBlank { "application/octet-stream" }
        val name = safeName(j.optString("name"), mime)
        thread(name = "ov-save") {
            val ok = try {
                val bytes = if (head.endsWith(";base64")) Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT)
                else Uri.decode(dataUrl.substring(comma + 1)).toByteArray()
                save(name, mime, bytes)
            } catch (e: Exception) { Log.w(TAG, "saving $name failed", e); false }
            toast(if (ok) "Saved to Downloads/OpenVolley: $name" else "The file could not be saved.")
        }
    }

    /** Downloads/OpenVolley (MediaStore, no permission) from Android 10; the app's own Downloads before. */
    private fun save(name: String, mime: String, bytes: ByteArray): Boolean {
        if (Build.VERSION.SDK_INT >= 29) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/OpenVolley")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val r = activity.contentResolver
            val uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
            r.openOutputStream(uri)?.use { it.write(bytes) } ?: return false
            values.clear(); values.put(MediaStore.Downloads.IS_PENDING, 0)
            r.update(uri, values, null, null)
            return true
        }
        val dir = File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return false, "OpenVolley")
        if (!dir.isDirectory && !dir.mkdirs()) return false
        File(dir, name).writeBytes(bytes)
        return true
    }

    private fun toast(text: String) = activity.runOnUiThread { Toast.makeText(activity, text, Toast.LENGTH_LONG).show() }

    // ---------------------------------------------------------------- clients

    private inner class Host(origin: String, private val main: Boolean) : ConsoleHost {
        override val allowlist = OriginPolicy.Allowlist(null, only = origin)
        override val debug: Boolean get() = this@OpenVolleyLayer.debug
        override fun onMainFrameUrl(url: String?) {}
        override fun onMainFrameVisible(url: String?) {
            if (main) note?.visibility = View.GONE
        }
        override fun onMainFrameFailed(url: String?, reason: String) {
            Log.w(TAG, "OpenVolley did not load ($reason)")
            if (!main) return
            note?.apply {
                text = "OpenVolley on the board is not answering ($reason).\n\nThe board must be set up for it, and this tablet on the board's Wi-Fi.\n\nTap to try again, or ‹ Point Hub to go back."
                visibility = View.VISIBLE
            }
        }
        override fun onRendererGone(view: WebView) {
            // A crashed page cannot be reused: build it again the next time it is opened.
            Log.w(TAG, "OpenVolley renderer gone")
            activity.runOnUiThread { hide(); destroy() }
        }
    }

    private inner class Chrome(private val origin: String) : WebChromeClient() {
        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?): Boolean =
            openWindow(origin, resultMsg)
        override fun onCloseWindow(window: WebView) = closeWindow(window)
        override fun onPermissionRequest(request: PermissionRequest) = request.deny()
        override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) =
            callback.invoke(origin, false, false)
        override fun onShowFileChooser(webView: WebView, filePathCallback: ValueCallback<Array<Uri>>, fileChooserParams: FileChooserParams): Boolean = false
        override fun onConsoleMessage(consoleMessage: android.webkit.ConsoleMessage): Boolean {
            if (debug) Log.d("openvolley", "${consoleMessage.message()} (${consoleMessage.sourceId()}:${consoleMessage.lineNumber()})")
            return true
        }
    }

    companion object {
        private const val TAG = "OpenVolleyLayer"
        private const val FILES = "PointHubFiles"
        /** A data URL of at most ~30 MB of file: the scoresheet PDF is a few hundred KB, a match ZIP a few MB. */
        private const val MAX_DATA_URL = 40 * 1024 * 1024

        /** A file name that is safe on any storage, keeping OpenVolley's own when it has one. */
        fun safeName(raw: String?, mime: String): String {
            val cleaned = (raw ?: "").substringAfterLast('/').substringAfterLast('\\')
                .replace(Regex("[^A-Za-z0-9._ -]"), "_").trim('.', ' ').take(120)
            if (cleaned.isNotEmpty()) return cleaned
            val ext = when (mime) {
                "application/pdf" -> "pdf"; "application/zip" -> "zip"; "application/json" -> "json"
                "text/csv" -> "csv"; "text/plain" -> "txt"; else -> "bin"
            }
            return "openvolley-${System.currentTimeMillis()}.$ext"
        }

        /**
         * Runs at document start in OpenVolley's pages only (addDocumentStartJavaScript with the one
         * origin). OpenVolley saves every file as `a.download = name; a.href = blob:…; a.click()`
         * (pdfOutput.ts downloadBlob, MatchEnd's ZIP, the exports): that click is sent to the app
         * over PointHubFiles instead, as a data URL, and the page goes on as after a download.
         */
        val DOWNLOAD_SHIM = """
            (function () {
              if (!window.$FILES || HTMLAnchorElement.prototype.__phDownloads) return;
              var click = HTMLAnchorElement.prototype.click;
              HTMLAnchorElement.prototype.__phDownloads = true;
              HTMLAnchorElement.prototype.click = function () {
                var href = this.href || '';
                if (this.hasAttribute('download') && /^(blob|data):/.test(href)) {
                  var name = this.getAttribute('download') || '';
                  fetch(href).then(function (r) { return r.blob(); }).then(function (b) {
                    return new Promise(function (ok, bad) {
                      var fr = new FileReader();
                      fr.onload = function () { ok(fr.result); };
                      fr.onerror = function () { bad(fr.error); };
                      fr.readAsDataURL(b);
                    });
                  }).then(function (dataUrl) {
                    window.$FILES.postMessage(JSON.stringify({ name: name, dataUrl: dataUrl }));
                  }).catch(function (e) {
                    window.$FILES.postMessage(JSON.stringify({ name: name, error: String(e) }));
                  });
                  return;
                }
                return click.call(this);
              };
            })();
        """.trimIndent()
    }
}
