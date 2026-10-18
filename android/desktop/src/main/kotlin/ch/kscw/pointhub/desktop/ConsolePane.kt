package ch.kscw.pointhub.desktop

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.onPointerEvent
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntSize
import java.awt.Cursor
import java.awt.KeyboardFocusManager
import java.awt.event.MouseEvent
import java.awt.event.MouseWheelEvent
import kotlin.math.roundToInt

/**
 * The console's page, drawn from Chromium's frames, taking the mouse and (while it has focus) the
 * keyboard. [keysToConsole] decides whether a key belongs to the page: not while a native dialog is
 * open over it.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun ConsolePane(console: Console, focused: Boolean, onFocus: (Boolean) -> Unit, keysToConsole: () -> Boolean, modifier: Modifier = Modifier) {
    val density = LocalDensity.current.density
    fun dip(p: Offset) = (p.x / density).roundToInt() to (p.y / density).roundToInt()

    fun forward(e: MouseEvent?, at: Offset, id: Int) {
        val (x, y) = dip(at)
        val src = console.awtSource
        if (e is MouseWheelEvent) {
            console.sendWheel(
                MouseWheelEvent(src, MouseEvent.MOUSE_WHEEL, e.`when`, e.modifiersEx, x, y, 0, false, e.scrollType, e.scrollAmount, e.wheelRotation),
            )
            return
        }
        val button = e?.button ?: MouseEvent.NOBUTTON
        val clicks = e?.clickCount ?: 0
        console.sendMouse(MouseEvent(src, id, e?.`when` ?: System.currentTimeMillis(), e?.modifiersEx ?: 0, x, y, clicks, false, button))
    }

    // Keys, straight from AWT while the page has focus: Compose's own key events do not carry the
    // typed characters, and Chromium needs pressed, typed and released.
    DisposableEffect(console, focused) {
        val kfm = KeyboardFocusManager.getCurrentKeyboardFocusManager()
        val dispatcher = java.awt.KeyEventDispatcher { e ->
            if (focused && keysToConsole()) { console.sendKey(e); true } else false
        }
        if (focused) kfm.addKeyEventDispatcher(dispatcher)
        console.focus(focused)
        onDispose { kfm.removeKeyEventDispatcher(dispatcher) }
    }

    Box(
        modifier
            .fillMaxSize()
            .onSizeChanged { s: IntSize -> console.resize((s.width / density).roundToInt(), (s.height / density).roundToInt(), density.toDouble()) }
            .pointerHoverIcon(PointerIcon(Cursor.getPredefinedCursor(console.cursorType.coerceIn(0, 13))))
            .onPointerEvent(PointerEventType.Press) { ev ->
                onFocus(true)
                forward(ev.nativeEvent as? MouseEvent, ev.changes.first().position, MouseEvent.MOUSE_PRESSED)
            }
            .onPointerEvent(PointerEventType.Release) { ev ->
                forward(ev.nativeEvent as? MouseEvent, ev.changes.first().position, MouseEvent.MOUSE_RELEASED)
            }
            .onPointerEvent(PointerEventType.Move) { ev ->
                val ne = ev.nativeEvent as? MouseEvent
                val dragging = ne != null && (ne.modifiersEx and MouseEvent.BUTTON1_DOWN_MASK) != 0
                forward(ne, ev.changes.first().position, if (dragging) MouseEvent.MOUSE_DRAGGED else MouseEvent.MOUSE_MOVED)
            }
            .onPointerEvent(PointerEventType.Exit) { ev ->
                forward(ev.nativeEvent as? MouseEvent, ev.changes.first().position, MouseEvent.MOUSE_EXITED)
            }
            .onPointerEvent(PointerEventType.Scroll) { ev ->
                forward(ev.nativeEvent as? MouseEvent, ev.changes.first().position, MouseEvent.MOUSE_WHEEL)
            },
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val f = console.frame ?: return@Canvas
            // The frame is in device pixels; draw it at its own size (it was sized for this box).
            drawImage(f)
            console.popup?.let { (r, img) ->
                drawImage(img, topLeft = Offset(r.x * density, r.y * density))
            }
        }
    }
}
