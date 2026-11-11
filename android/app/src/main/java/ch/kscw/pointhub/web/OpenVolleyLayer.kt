package ch.kscw.pointhub.web

import android.app.Activity
import android.graphics.Color
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

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
 * - Its WebView loads that one origin and nothing else ([OriginPolicy.Allowlist] `only`), and gets
 *   no bridge: OpenVolley is not the console. Cloud calls (backend.openvolley.app) are refused;
 *   OpenVolley queues them itself.
 */
class OpenVolleyLayer(
    private val activity: Activity,
    private val userAgent: String,
    private val debug: Boolean,
) {
    private var layer: LinearLayout? = null
    private var web: WebView? = null
    private var note: TextView? = null
    private var origin: String? = null

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

    /** Back inside OpenVolley's own pages; false when there is nowhere to go back to. */
    fun goBack(): Boolean {
        val w = web ?: return false
        if (!w.canGoBack()) return false
        w.goBack()
        return true
    }

    fun destroy() {
        web?.let { (it.parent as? ViewGroup)?.removeView(it); it.destroy() }
        web = null
        layer?.let { (it.parent as? ViewGroup)?.removeView(it) }
        layer = null
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
        bar.addView(Button(activity).apply {
            text = "‹ Point Hub"
            isAllCaps = false
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setOnClickListener { hide() }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(44)))
        bar.addView(TextView(activity).apply {
            text = "OpenVolley eScoresheet on the board"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setPadding(dp(12), 0, 0, 0)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        val holder = FrameLayout(activity)
        val wv = WebView(activity)
        wv.setBackgroundColor(Color.WHITE)
        ConsoleWebView.configure(wv, Host(origin), userAgent)
        // OpenVolley zooms its own scoresheet; the page itself stays at 100 %.
        holder.addView(wv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val msg = TextView(activity).apply {
            setBackgroundColor(Color.WHITE)
            setTextColor(Color.parseColor("#1c1917"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            gravity = Gravity.CENTER
            setPadding(dp(32), dp(32), dp(32), dp(32))
            visibility = View.GONE
            setOnClickListener { visibility = View.GONE; wv.reload() }
        }
        holder.addView(msg, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        val l = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            // Touches stay in the layer: none reach the console underneath.
            isClickable = true
        }
        l.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        l.addView(holder, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(l, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        layer = l
        web = wv
        note = msg
        Log.i(TAG, "OpenVolley from $origin")
        wv.loadUrl("$origin/")
    }

    private inner class Host(origin: String) : ConsoleHost {
        override val allowlist = OriginPolicy.Allowlist(null, only = origin)
        override val debug: Boolean get() = this@OpenVolleyLayer.debug
        override fun onMainFrameUrl(url: String?) {}
        override fun onMainFrameVisible(url: String?) {
            note?.visibility = View.GONE
        }
        override fun onMainFrameFailed(url: String?, reason: String) {
            Log.w(TAG, "OpenVolley did not load ($reason)")
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

    private companion object {
        const val TAG = "OpenVolleyLayer"
    }
}
