package ch.kscw.pointhub.desktop

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.onPointerEvent
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import ch.kscw.pointhub.game.ui.BrandMark
import ch.kscw.pointhub.game.ui.DialogBox
import ch.kscw.pointhub.game.ui.DialogTitle
import ch.kscw.pointhub.game.ui.GameDialogs
import ch.kscw.pointhub.game.ui.GameScreen
import ch.kscw.pointhub.game.ui.Ph
import ch.kscw.pointhub.game.ui.PhDialog
import ch.kscw.pointhub.game.ui.PhShape
import ch.kscw.pointhub.game.ui.PhTextButton
import ch.kscw.pointhub.game.ui.PhTheme
import ch.kscw.pointhub.game.ui.ShellHeader
import ch.kscw.pointhub.game.ui.Tab
import org.jetbrains.skia.Image
import java.awt.Dimension

fun main() {
    // Chromium first: its processes and libraries are set up before any window exists.
    Cef.start()
    val prefs = DesktopPrefs()
    val icon = Thread.currentThread().contextClassLoader?.getResourceAsStream("point-hub.png")?.use { it.readBytes() }
        ?.let { BitmapPainter(Image.makeFromEncoded(it).toComposeImageBitmap()) }
    application {
        val app = remember { DesktopApp(prefs) }
        Window(
            onCloseRequest = { app.dispose(); Cef.shutdown(); exitApplication() },
            title = "Point Hub",
            icon = icon,
            state = rememberWindowState(width = 1340.dp, height = 840.dp),
        ) {
            LaunchedEffect(Unit) { window.minimumSize = Dimension(960, 600) }
            PhTheme(app.consoleTheme) { Root(app) }
        }
    }
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun Root(app: DesktopApp) {
    val c = Ph.colors
    val g = app.game
    Box(Modifier.fillMaxSize().background(c.bg)) {
        when {
            app.origin == null -> SearchScreen(app)
            app.embedded -> Column(Modifier.fillMaxSize()) {
                // A click on the header (or anywhere native) takes the keyboard back from the page.
                Box(Modifier.onPointerEvent(PointerEventType.Press) { app.consoleFocused = false }) {
                    ShellHeader(g, app.tab, onTab = { app.selectTab(it) }, onUplink = { app.selectTab(Tab.SETTINGS, "uplink") })
                }
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    ConsolePane(app.console, app.consoleFocused, { app.consoleFocused = it }, app::keysToConsole)
                    if (app.tab == Tab.GAME) {
                        Box(Modifier.fillMaxSize().onPointerEvent(PointerEventType.Press) { app.consoleFocused = false }) {
                            GameScreen(g, onUplink = { app.selectTab(Tab.SETTINGS, "uplink") })
                        }
                    } else if (app.console.loadError != null) {
                        PageError(app)
                    }
                }
            }
            else -> Box(Modifier.fillMaxSize()) {
                // A console that did not ask for the native Game tab (older board, or switched off).
                ConsolePane(app.console, app.consoleFocused, { app.consoleFocused = it }, app::keysToConsole)
                if (app.console.loadError != null) PageError(app)
                else if (app.console.frame == null) Connecting(app)
            }
        }
        if (app.embedded) GameDialogs(g)
        if (app.settingsOpen) SettingsDialog(app)
    }
}

@Composable
private fun Connecting(app: DesktopApp) {
    val c = Ph.colors
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        BrandMark(48.dp)
        Text("Connecting to the scoreboard at ${app.origin}…", color = c.muted, fontSize = 15.sp, modifier = Modifier.padding(top = 16.dp))
    }
}

@Composable
private fun PageError(app: DesktopApp) {
    val c = Ph.colors
    Column(
        Modifier.fillMaxSize().background(c.bg),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        Text("The console page did not load", color = c.fg, fontSize = 20.sp, fontWeight = FontWeight.ExtraBold)
        Text(app.console.loadError ?: "", color = c.muted, fontSize = 14.sp, modifier = Modifier.padding(top = 6.dp, bottom = 16.dp))
        PhTextButton("Try again", { app.console.reload() }, fg = c.blue, fontSize = 15)
    }
}

/** No board yet: what was tried, and the two things a person can do about it. */
@Composable
private fun SearchScreen(app: DesktopApp) {
    val c = Ph.colors
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        BrandMark(56.dp)
        Text("Looking for the scoreboard…", color = c.fg, fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.padding(top = 18.dp))
        Text(
            "Is it switched on? Is this computer on the board's Wi-Fi (ledbox_C0270), its cable, or the club's tailnet?",
            color = c.muted, fontSize = 15.sp, textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 560.dp).padding(top = 8.dp),
        )
        if (app.probes.isNotEmpty()) {
            Text(
                app.probes.joinToString("  ·  ") { Discovery.label(it.origin) + ": " + it.why },
                color = c.muted, fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 720.dp).padding(top = 14.dp),
            )
        }
        Row(Modifier.padding(top = 22.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PhTextButton("Try again", { app.find() }, fg = c.blue, fontSize = 15)
            PhTextButton("Board address…", { app.settingsOpen = true }, fontSize = 15)
        }
    }
}

/** The desktop's few settings: where the board is, and the native or web Game tab. */
@Composable
private fun SettingsDialog(app: DesktopApp) {
    val c = Ph.colors
    var addr by remember { mutableStateOf(app.prefs.overrideOrigin ?: "") }
    var err by remember { mutableStateOf<String?>(null) }
    PhDialog(onDismiss = { app.settingsOpen = false }) {
        DialogBox(520.dp, padding = 24.dp) {
            DialogTitle("Point Hub settings")
            Text("Version $APP_VERSION", color = c.muted, fontSize = 13.sp, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 18.dp))
            Text("BOARD ADDRESS", color = c.muted, fontSize = 12.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 1.sp)
            Text("Empty = find it (its https name, 172.24.1.1, the cable). Plain http only to 172.24.1.1 or 192.168.5.1.",
                color = c.muted, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp, bottom = 8.dp))
            BasicTextField(
                addr, { addr = it; err = null }, singleLine = true,
                textStyle = TextStyle(color = c.fg, fontSize = 15.sp, fontFamily = Ph.mono),
                cursorBrush = SolidColor(c.fg),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { if (app.setOverride(addr)) app.settingsOpen = false else err = "Not a board address" }),
                modifier = Modifier.fillMaxWidth().border(Ph.hairline, c.line, PhShape).padding(12.dp),
            )
            err?.let { Text(it, color = c.bad, fontSize = 13.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 6.dp)) }
            Row(Modifier.fillMaxWidth().padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PhTextButton("Use this address", { if (app.setOverride(addr)) app.settingsOpen = false else err = "Not a board address" }, fg = c.blue)
                PhTextButton("Find automatically", { addr = ""; app.setOverride(null); app.settingsOpen = false })
            }
            Text("GAME SCREEN", color = c.muted, fontSize = 12.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 1.sp,
                modifier = Modifier.padding(top = 22.dp, bottom = 8.dp))
            PhTextButton(
                if (app.prefs.nativeGame) "Native (switch to the web console)" else "Web console (switch to native)",
                { app.setNativeGame(!app.prefs.nativeGame); app.settingsOpen = false },
            )
            Box(Modifier.fillMaxWidth().padding(top = 22.dp), contentAlignment = Alignment.Center) {
                PhTextButton("Close", { app.settingsOpen = false }, fontSize = 14)
            }
        }
    }
}
