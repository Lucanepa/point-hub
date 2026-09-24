package ch.kscw.pointhub.ui

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.InputFilter
import android.text.InputType
import android.util.TypedValue
import android.view.WindowManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import ch.kscw.pointhub.R
import ch.kscw.pointhub.pointHub
import ch.kscw.pointhub.store.AdminPin
import kotlin.concurrent.thread

object Ui {
    fun dp(activity: Activity, v: Float): Float =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, activity.resources.displayMetrics)

    /** Fullscreen immersive: bars hidden, swipe shows them transiently, content under the cutout. */
    fun immersive(activity: Activity) {
        val window = activity.window
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        if (Build.VERSION.SDK_INT >= 30) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            }
        } else if (Build.VERSION.SDK_INT >= 28) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
    }

    private fun pinField(activity: Activity, hint: String) = EditText(activity).apply {
        this.hint = hint
        inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
        filters = arrayOf(InputFilter.LengthFilter(8))
        textSize = 24f
        minHeight = dp(activity, 56f).toInt()
    }

    private fun column(activity: Activity, vararg views: android.view.View) = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        val p = dp(activity, 24f).toInt()
        setPadding(p, p / 2, p, 0)
        views.forEach { addView(it) }
    }

    /**
     * Asks for the app-local admin PIN, verifies it off the main thread (PBKDF2), and runs
     * [onSuccess] on the main thread. Wrong PINs and lockouts are reported in the dialog.
     */
    fun askPin(activity: Activity, message: String? = null, onSuccess: () -> Unit) {
        val pin = activity.pointHub.adminPin
        val field = pinField(activity, "PIN")
        val info = TextView(activity).apply { setTextColor(Color.rgb(248, 113, 113)); textSize = 16f }
        val dialog = AlertDialog.Builder(activity)
            .setTitle(R.string.pin_title)
            .setMessage(message)
            .setView(column(activity, field, info))
            .setPositiveButton(R.string.ok, null)
            .setNegativeButton(R.string.cancel, null)
            .create()
        dialog.setOnShowListener {
            val ok = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
            val locked = pin.remainingLockMs()
            if (locked > 0) info.text = "Too many wrong PINs. Try again in ${(locked + 999) / 1000} s."
            ok.setOnClickListener {
                ok.isEnabled = false
                val entered = field.text.toString()
                thread(name = "pin-verify") {
                    val r = pin.verify(entered)
                    Handler(Looper.getMainLooper()).post {
                        ok.isEnabled = true
                        when (r) {
                            AdminPin.Result.Ok -> { dialog.dismiss(); onSuccess() }
                            is AdminPin.Result.Wrong -> {
                                field.setText("")
                                info.text = if (r.lockedForMs > 0) "Wrong PIN. Locked for ${r.lockedForMs / 1000} s."
                                else "Wrong PIN. ${r.attemptsBeforeLock} tries left before a lockout."
                            }
                            is AdminPin.Result.LockedOut -> info.text = "Too many wrong PINs. Try again in ${(r.remainingMs + 999) / 1000} s."
                        }
                    }
                }
            }
        }
        dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)
        dialog.show()
        field.requestFocus()
    }

    /** New PIN + confirmation. */
    fun changePin(activity: Activity, onDone: (String) -> Unit) {
        val a = pinField(activity, "New PIN (4–8 digits)")
        val b = pinField(activity, "New PIN again")
        val info = TextView(activity).apply { setTextColor(Color.rgb(248, 113, 113)); textSize = 16f }
        val dialog = AlertDialog.Builder(activity)
            .setTitle("Change admin PIN")
            .setView(column(activity, a, b, info))
            .setPositiveButton(R.string.ok, null)
            .setNegativeButton(R.string.cancel, null)
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val p = a.text.toString()
                when {
                    !AdminPin.isValidFormat(p) -> info.text = "The PIN must be 4 to 8 digits."
                    p != b.text.toString() -> info.text = "The two PINs differ."
                    else -> {
                        dialog.dismiss()
                        thread(name = "pin-set") {
                            activity.pointHub.adminPin.set(p)
                            Handler(Looper.getMainLooper()).post { onDone(p) }
                        }
                    }
                }
            }
        }
        dialog.show()
    }
}
