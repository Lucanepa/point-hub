import org.jetbrains.compose.desktop.application.dsl.TargetFormat
import java.util.Properties

// The desktop app: the same native Game tab, header and tabs as the tablet (:shared), and the
// console's other tabs embedded through JCEF (Chromium) in off-screen mode, painted into Compose.
// It runs on JetBrains Runtime with JCEF; POINTHUB_JBR is that runtime's path (desktop/README.md).
plugins {
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.compose")
}

val versionProps = Properties().apply { file("version.properties").inputStream().use { load(it) } }
val appVersion: String = versionProps.getProperty("VERSION_NAME").trim()
val jbr: String? = System.getenv("POINTHUB_JBR")?.takeIf { it.isNotBlank() }

kotlin {
    jvmToolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
        vendor.set(JvmVendorSpec.JETBRAINS)
    }
}

dependencies {
    implementation(project(":shared"))
    implementation(compose.desktop.currentOs)
    implementation("org.json:json:20240303")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-swing:1.9.0")
    testImplementation("junit:junit:4.13.2")
}

val generateVersion by tasks.registering {
    val out = layout.buildDirectory.dir("generated/version")
    inputs.property("version", appVersion)
    outputs.dir(out)
    doLast {
        val f = out.get().file("ch/kscw/pointhub/desktop/AppVersion.kt").asFile
        f.parentFile.mkdirs()
        f.writeText("package ch.kscw.pointhub.desktop\n\n/** Generated from desktop/version.properties. */\nconst val APP_VERSION = \"$appVersion\"\n")
    }
}
kotlin.sourceSets["main"].kotlin.srcDir(generateVersion)

compose.desktop {
    application {
        mainClass = "ch.kscw.pointhub.desktop.MainKt"
        if (jbr != null) javaHome = jbr
        nativeDistributions {
            targetFormats(TargetFormat.Deb, TargetFormat.Rpm, TargetFormat.Msi, TargetFormat.Dmg)
            packageName = "point-hub"
            packageVersion = appVersion
            description = "Point Hub: the console of the KSCW LedBox scoreboard"
            vendor = "KSC Wiedikon"
            copyright = "© 2026 KSC Wiedikon. MIT License."
            licenseFile.set(rootProject.file("../LICENSE"))
            // jlink: what the app and Chromium need, and nothing else.
            modules("jcef", "java.naming", "java.net.http", "jdk.crypto.ec", "jdk.unsupported", "java.management", "jdk.accessibility")
            linux {
                iconFile.set(project.file("icons/point-hub.png"))
                packageName = "point-hub"
                debMaintainer = "info@kscw.ch"
                menuGroup = "Utility"
                appCategory = "utils"
                rpmLicenseType = "MIT"
                shortcut = true
            }
            windows {
                iconFile.set(project.file("icons/point-hub.ico"))
                menuGroup = "Point Hub"
                // Fixed for good: Windows matches installs and upgrades by it.
                upgradeUuid = "6f0c3a2e-6c7b-4d44-9a3e-2f5a8e1b7c10"
                shortcut = true
                dirChooser = true
            }
            macOS {
                iconFile.set(project.file("icons/point-hub.icns"))
                bundleID = "ch.kscw.pointhub"
                appCategory = "public.app-category.sports"
            }
        }
    }
}

// jlink copies the jcef module's helper binaries without their executable bit; Chromium cannot start
// its processes without it. Put it back on the runtime every package is made from.
afterEvaluate {
    tasks.named("createRuntimeImage") {
        doLast {
            val lib = layout.buildDirectory.dir("compose/tmp/main/runtime/lib").get().asFile
            for (n in listOf("jcef_helper", "cef_server", "chrome-sandbox")) {
                val f = File(lib, n)
                if (f.isFile) f.setExecutable(true, false)
            }
            // Chromium's UI strings in 55 languages are 45 MB; the console is English, and the
            // country's languages cover a Swiss scorer's machine. The rest only make packages bigger.
            val keep = setOf("en-US.pak", "en-GB.pak", "de.pak", "fr.pak", "it.pak")
            layout.buildDirectory.dir("compose/tmp/main/runtime").get().asFile.walkTopDown()
                .filter { it.isDirectory && it.name == "locales" }
                .forEach { dir -> dir.listFiles()?.filter { it.name.endsWith(".pak") && it.name !in keep }?.forEach { it.delete() } }
        }
    }
}
