package ch.kscw.pointhub.game.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import ch.kscw.pointhub.game.ToastMsg

val PhShape = RoundedCornerShape(Ph.radius)



/** The console's flat primitive: card background, hairline edge, a darker fill while pressed. */
@Composable
fun PhButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    bg: Color = Ph.colors.card,
    border: Color = Ph.colors.line,
    fg: Color = Ph.colors.fg,
    pressedBg: Color = Ph.colors.fill,
    borderWidth: Dp = Ph.hairline,
    minHeight: Dp = Ph.tap,
    minWidth: Dp = Ph.tap,
    contentPadding: PaddingValues = PaddingValues(horizontal = 14.dp),
    notSent: Boolean = false,
    label: String? = null,
    arrangement: Arrangement.Horizontal = Arrangement.spacedBy(7.dp, Alignment.CenterHorizontally),
    contentAlignment: Alignment = Alignment.Center,
    content: @Composable RowScope.(Color) -> Unit,
) {
    val src = remember { MutableInteractionSource() }
    val pressed by src.collectIsPressedAsState()
    val c = Ph.colors
    Box(
        modifier
            .defaultMinSize(minWidth, minHeight)
            .then(if (notSent) Modifier.border(3.dp, c.bad, PhShape).padding(2.dp) else Modifier)
            .border(borderWidth, border, PhShape)
            .background(if (pressed && enabled) pressedBg else bg, PhShape)
            .clickable(src, null, enabled = enabled, role = Role.Button, onClickLabel = label, onClick = onClick)
            .then(if (label != null) Modifier.semantics { contentDescription = label } else Modifier)
            .alpha(if (enabled) 1f else 0.45f)
            .padding(contentPadding),
        contentAlignment = contentAlignment,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = arrangement) {
            content(fg)
        }
        if (notSent) {
            Box(
                Modifier.align(Alignment.TopEnd).size(18.dp).background(c.bad, CircleShape),
                contentAlignment = Alignment.Center,
            ) { Text("!", color = c.onAccent, fontSize = 12.sp, fontWeight = FontWeight.ExtraBold) }
        }
    }
}

/** A text button in the console's style (the actions row, dialog buttons). */
@Composable
fun PhTextButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    icon: ImageVector? = null,
    fg: Color = Ph.colors.fg,
    bg: Color = Ph.colors.card,
    border: Color = Ph.colors.line,
    fontSize: Int = 13,
    minHeight: Dp = Ph.tap,
    notSent: Boolean = false,
) {
    PhButton(onClick, modifier, enabled, bg = bg, border = border, fg = fg, minHeight = minHeight, notSent = notSent) { color ->
        if (icon != null) Icon(icon, null, Modifier.size(17.dp), tint = color)
        Text(text, color = color, fontSize = fontSize.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1)
    }
}

@Composable
fun Hairline(modifier: Modifier = Modifier, color: Color = Ph.colors.line) =
    Box(modifier.background(color))

/**
 * A modal over everything, with the theme's scrim. A tap on the scrim is [onDismiss] (null = the
 * scrim does nothing, e.g. the lock gate). The tablet puts it in its own immersive window; the
 * desktop draws it as an overlay inside the main window (PhModalHost).
 */
@Composable
fun PhDialog(onDismiss: (() -> Unit)?, content: @Composable BoxScope.() -> Unit) {
    PhModalHost(onDismiss) {
        val c = Ph.colors
        Box(
            Modifier
                .fillMaxSize()
                .background(c.scrim)
                .clickable(remember { MutableInteractionSource() }, null) { onDismiss?.invoke() },
            contentAlignment = Alignment.Center,
            content = content,
        )
    }
}

/** Where a PhDialog lives on this platform: its own window, or an overlay in the main one. */
@Composable
expect fun PhModalHost(onDismiss: (() -> Unit)?, content: @Composable () -> Unit)

/** The box a dialog's content sits in (`.editbox` / `.spbox`). Taps inside never reach the scrim. */
@Composable
fun DialogBox(width: Dp = 300.dp, modifier: Modifier = Modifier, padding: Dp = 18.dp, content: @Composable ColumnScope.() -> Unit) {
    val c = Ph.colors
    Column(
        modifier
            .padding(12.dp)
            .widthIn(max = width)
            .border(if (c.eink) 2.5.dp else Ph.hairline, c.line, PhShape)
            .background(c.card, PhShape)
            .clickable(remember { MutableInteractionSource() }, null) {}
            .verticalScroll(rememberScrollState())
            .padding(padding),
        content = content,
    )
}

@Composable
fun DialogTitle(text: String) = Text(
    text, color = Ph.colors.fg, fontSize = 20.sp, fontWeight = FontWeight.ExtraBold,
    textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
)

@Composable
fun DialogSub(text: String, color: Color = Ph.colors.muted) = Text(
    text, color = color, fontSize = 13.sp, textAlign = TextAlign.Center,
    modifier = Modifier.fillMaxWidth().padding(top = 6.dp, bottom = 16.dp),
)

/** The bottom-centre toast, in its own small window: it covers nothing but itself. */
@Composable
fun ToastHost(t: ToastMsg?, onAction: () -> Unit, onClose: () -> Unit) {
    if (t == null) return
    val c = Ph.colors
    val interactive = t.actionLabel != null || t.sticky
    Popup(
        popupPositionProvider = BottomCentre,
        properties = PopupProperties(focusable = false, dismissOnBackPress = false, dismissOnClickOutside = false, clippingEnabled = false),
    ) {
        Row(
            Modifier
                .padding(bottom = 18.dp)
                .widthIn(max = 640.dp)
                .border(if (t.bad) 2.dp else Ph.hairline, if (t.bad) c.bad else c.line, PhShape)
                .background(c.card, PhShape)
                .padding(start = 16.dp, end = if (interactive) 4.dp else 16.dp, top = if (interactive) 4.dp else 12.dp, bottom = if (interactive) 4.dp else 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                t.msg, color = if (t.bad) c.bad else c.fg, fontSize = 14.sp,
                fontWeight = if (t.bad) FontWeight.Bold else FontWeight.Normal,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (t.actionLabel != null) PhTextButton(t.actionLabel, onAction, fg = c.blue, fontSize = 14)
            if (t.sticky) PhButton(onClose, border = Color.Transparent, label = "Dismiss") { col ->
                Icon(PhIcons.x, null, Modifier.size(16.dp), tint = c.muted)
            }
        }
    }
}

private object BottomCentre : PopupPositionProvider {
    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset =
        IntOffset((windowSize.width - popupContentSize.width) / 2, windowSize.height - popupContentSize.height)
}

/** Monospace numerals, as the console's `font-variant-numeric: tabular-nums; font-family: var(--mono)`. */
val MonoStyle = TextStyle(fontFamily = Ph.mono, fontWeight = FontWeight.ExtraBold)

/** A numeral in its own box (CSS line-height ≤ 1): no leading above or below it. */
val TightNumber = MonoStyle.copy(
    lineHeightStyle = androidx.compose.ui.text.style.LineHeightStyle(
        androidx.compose.ui.text.style.LineHeightStyle.Alignment.Center,
        androidx.compose.ui.text.style.LineHeightStyle.Trim.None,
    ),
)
