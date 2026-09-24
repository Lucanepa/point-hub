import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ---- Version: android/version.properties (tracked, bumped by build-release.sh) ----
val versionProps = Properties().apply {
    rootProject.file("version.properties").inputStream().use { load(it) }
}
val appVersionCode = versionProps.getProperty("VERSION_CODE").trim().toInt()
val appVersionName = versionProps.getProperty("VERSION_NAME").trim()

// ---- Signing: the ONE release key, resolved in this order ----
//   1. android/keystore.properties (either the four keys, or propertiesFile=<path>)
//   2. env POINTHUB_KEYSTORE_PROPERTIES
//   3. ~/.config/pointhub-android/keystore.properties
// If none resolves, release has no signingConfig and build-release.sh refuses to ship.
fun loadProps(f: File): Properties? =
    if (f.isFile) Properties().apply { f.inputStream().use { load(it) } } else null

fun resolveSigning(): Properties? {
    val candidates = listOfNotNull(
        rootProject.file("keystore.properties"),
        System.getenv("POINTHUB_KEYSTORE_PROPERTIES")?.takeIf { it.isNotBlank() }?.let { File(it) },
        File(System.getProperty("user.home"), ".config/pointhub-android/keystore.properties"),
    )
    for (f in candidates) {
        var p = loadProps(f) ?: continue
        p.getProperty("propertiesFile")?.let { ind -> p = loadProps(File(ind.trim())) ?: return null }
        if (listOf("storeFile", "storePassword", "keyAlias", "keyPassword").all { !p.getProperty(it).isNullOrBlank() }) {
            return p
        }
    }
    return null
}
val signingProps = resolveSigning()

android {
    namespace = "ch.kscw.pointhub"
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "ch.kscw.pointhub"
        minSdk = 26
        // Deliberately 35: API 36 ignores screenOrientation on large screens (sw >= 600dp).
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
    }

    signingConfigs {
        if (signingProps != null) {
            create("release") {
                storeFile = file(signingProps.getProperty("storeFile").trim())
                storePassword = signingProps.getProperty("storePassword").trim()
                keyAlias = signingProps.getProperty("keyAlias").trim()
                keyPassword = signingProps.getProperty("keyPassword").trim()
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            isDebuggable = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
        debug {
            // Same package as release on purpose (see README: adb uninstall before switching).
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
        warningsAsErrors = false
        checkReleaseBuilds = true
        lintConfig = rootProject.file("lint.xml")
    }

    testOptions {
        unitTests.isReturnDefaultValues = false
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module", "DebugProbesKt.bin", "kotlin-tooling-metadata.json")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    // Android's org.json is a stub on the JVM; the real one for the adapter tests.
    testImplementation("org.json:json:20240303")
}
