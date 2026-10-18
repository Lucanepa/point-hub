package ch.kscw.pointhub.game.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import org.jetbrains.skia.Image

/**
 * On the desktop a modal is an overlay in the main window, not a window of its own: no second
 * window to take focus, and the click after it closes always reaches the window under it.
 */
@Composable
actual fun PhModalHost(onDismiss: (() -> Unit)?, content: @Composable () -> Unit) {
    Popup(
        popupPositionProvider = WholeWindow,
        onDismissRequest = { onDismiss?.invoke() },
        properties = PopupProperties(focusable = true, dismissOnBackPress = onDismiss != null, dismissOnClickOutside = false),
        content = content,
    )
}

private object WholeWindow : PopupPositionProvider {
    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset =
        IntOffset.Zero
}

@Composable
actual fun crestImage(): ImageBitmap = remember {
    val bytes = Thread.currentThread().contextClassLoader?.getResourceAsStream("kscw_crest.png")?.use { it.readBytes() }
        ?: object {}.javaClass.getResourceAsStream("/kscw_crest.png")!!.use { it.readBytes() }
    Image.makeFromEncoded(bytes).toComposeImageBitmap()
}
