package ch.kscw.pointhub.game.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import org.jetbrains.skia.Image

/**
 * On the desktop a modal is a layer of the main window's own composition (the dialogs are composed
 * last, over a full-window box), not a popup: a focusable popup there swallowed the first click
 * after it closed, so the tab tapped next did nothing.
 */
@Composable
actual fun PhModalHost(onDismiss: (() -> Unit)?, content: @Composable () -> Unit) = content()

@Composable
actual fun crestImage(): ImageBitmap = remember {
    val bytes = Thread.currentThread().contextClassLoader?.getResourceAsStream("kscw_crest.png")?.use { it.readBytes() }
        ?: object {}.javaClass.getResourceAsStream("/kscw_crest.png")!!.use { it.readBytes() }
    Image.makeFromEncoded(bytes).toComposeImageBitmap()
}
