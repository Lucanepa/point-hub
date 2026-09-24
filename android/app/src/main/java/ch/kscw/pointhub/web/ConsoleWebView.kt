package ch.kscw.pointhub.web

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.net.http.SslError
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream

/** What the WebView reports to its host (MainActivity). All calls on the main thread. */
interface ConsoleHost {
    /** Read from WebView's IO thread too, so it must be an immutable snapshot. */
    val allowlist: OriginPolicy.Allowlist
    fun onMainFrameUrl(url: String?)
    fun onMainFrameVisible(url: String?)
    /** [url] is the failed main-frame URL when known. */
    fun onMainFrameFailed(url: String?, reason: String)
    fun onRendererGone(view: WebView)
    val debug: Boolean
}

object ConsoleWebView {
    private const val TAG = "ConsoleWebView"

    fun userAgent(context: Context, versionName: String): String =
        WebSettings.getDefaultUserAgent(context) + " PointHubApp/" + versionName

    // JavaScript is the console itself; the bridge is exposed only to board origins (see
    // PointHubBridge) and every other origin is blocked from loading at all (see the client).
    @SuppressLint("SetJavaScriptEnabled")
    fun configure(webView: WebView, host: ConsoleHost, userAgent: String) {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            @Suppress("DEPRECATION")
            databaseEnabled = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            setGeolocationEnabled(false)
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = true
            cacheMode = WebSettings.LOAD_DEFAULT
            builtInZoomControls = false
            displayZoomControls = false
            setSupportZoom(false)
            textZoom = 100
            userAgentString = userAgent
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, false)
        }
        webView.webViewClient = Client(host)
        webView.webChromeClient = Chrome(host)
    }

    private val EMPTY = ByteArray(0)

    private class Client(private val host: ConsoleHost) : WebViewClient() {
        private fun permitted(url: String?): Boolean {
            val a = host.allowlist
            return a.isAllowed(url) || a.isInertLocal(url) || (url?.startsWith("blob:") == true && a.isAllowed(url.removePrefix("blob:")))
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url?.toString()
            if (permitted(url)) return false
            Log.w(TAG, "blocked navigation to $url")
            return true
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val url = request.url?.toString()
            if (permitted(url)) return null
            Log.w(TAG, "blocked request to $url")
            return WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(EMPTY))
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            host.onMainFrameUrl(url)
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            host.onMainFrameUrl(url)
        }

        override fun onPageCommitVisible(view: WebView, url: String?) {
            host.onMainFrameVisible(url)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            // A navigation we replaced ourselves (e.g. with about:blank) is not a failure.
            if (error.description?.contains("ERR_ABORTED") == true) return
            host.onMainFrameFailed(request.url?.toString(), "load error: ${error.description}")
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
            if (!request.isForMainFrame) return
            val status = errorResponse.statusCode
            val path = request.url?.path ?: ""
            if (status >= 500 || (status == 404 && (path == "" || path == "/"))) host.onMainFrameFailed(request.url?.toString(), "HTTP $status")
        }

        @SuppressLint("WebViewClientOnReceivedSslError")
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel() // never proceed past a certificate error
            host.onMainFrameFailed(
                error.url,
                if (error.primaryError == SslError.SSL_EXPIRED || error.primaryError == SslError.SSL_NOTYETVALID ||
                    error.primaryError == SslError.SSL_DATE_INVALID
                ) "certificate date (tablet clock?)" else "certificate",
            )
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.w(TAG, "renderer gone, crashed=${detail.didCrash()}")
            host.onRendererGone(view)
            return true
        }
    }

    private class Chrome(private val host: ConsoleHost) : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) = request.deny()
        override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) =
            callback.invoke(origin, false, false)
        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<android.net.Uri>>,
            fileChooserParams: FileChooserParams,
        ): Boolean = false
        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message?) = false
        override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
            if (host.debug) Log.d("console", "${consoleMessage.message()} (${consoleMessage.sourceId()}:${consoleMessage.lineNumber()})")
            return true
        }
    }
}
