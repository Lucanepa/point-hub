package ch.kscw.pointhub.game.ui

import android.os.Build
import android.view.ViewGroup
import android.view.WindowManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import ch.kscw.pointhub.shared.R

@Composable
actual fun PhModalHost(onDismiss: (() -> Unit)?, content: @Composable () -> Unit) {
    Dialog(onDismissRequest = { onDismiss?.invoke() }, properties = phDialogProperties(dismissOnBack = onDismiss != null)) {
        DialogWindowSetup()
        content()
    }
}

private fun phDialogProperties(dismissOnBack: Boolean): DialogProperties = DialogProperties(
    dismissOnBackPress = dismissOnBack,
    dismissOnClickOutside = false,
    usePlatformDefaultWidth = false,
    decorFitsSystemWindows = false,
)

/**
 * A modal in its own window, edge to edge over the whole screen, header and cutout included, like
 * the console's fixed overlays, and keeping the kiosk immersive: no status or navigation bar popping
 * up because a dialog took focus.
 */
@Composable
private fun DialogWindowSetup() {
    val view = LocalView.current
    DisposableEffect(view) {
        (view.parent as? DialogWindowProvider)?.window?.let { w ->
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            w.addFlags(WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS)
            if (Build.VERSION.SDK_INT >= 30) {
                w.attributes = w.attributes.apply {
                    layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                }
            }
            WindowCompat.setDecorFitsSystemWindows(w, false)
            WindowInsetsControllerCompat(w, w.decorView).apply {
                hide(WindowInsetsCompat.Type.systemBars())
                systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
            w.setDimAmount(0f)
        }
        onDispose {}
    }
}

@Composable
actual fun crestImage(): ImageBitmap = ImageBitmap.imageResource(R.drawable.kscw_crest)
