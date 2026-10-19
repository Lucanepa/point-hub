import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// The native Game tab, the header and the tabs: ported from web/index.html, shared by the tablet app
// (:app) and the desktop app (:desktop). Both targets are JVM, so everything lives in one shared
// source set, jvmShared, which may use the JDK and org.json; the few platform hooks (a dialog
// window, the crest image) are expect/actual.
plugins {
    id("org.jetbrains.kotlin.multiplatform")
    id("com.android.library")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.compose")
}

kotlin {
    androidTarget {
        compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
    }
    jvm("desktop") {
        compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
    }

    sourceSets {
        val commonMain by getting {
            dependencies {
                api(compose.runtime)
                api(compose.foundation)
                api(compose.material3)
                api(compose.ui)
                api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
            }
        }
        val jvmShared by creating {
            dependsOn(commonMain)
            dependencies {
                // Android has org.json built in; it is excluded from every Android classpath below.
                implementation("org.json:json:20240303")
            }
        }
        val androidMain by getting {
            dependsOn(jvmShared)
            dependencies {
                implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
                implementation("androidx.core:core-ktx:1.16.0")
            }
        }
        val desktopMain by getting {
            dependsOn(jvmShared)
            dependencies {
                implementation("org.jetbrains.kotlinx:kotlinx-coroutines-swing:1.9.0")
            }
        }
        val desktopTest by getting {
            dependencies {
                implementation("junit:junit:4.13.2")
            }
        }
    }
}

android {
    namespace = "ch.kscw.pointhub.shared"
    compileSdk = 35
    defaultConfig {
        minSdk = 26
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    lint {
        abortOnError = true
        lintConfig = rootProject.file("lint.xml")
    }
}

// The platform's own org.json, never a second copy in the APK (lint: DuplicatePlatformClasses).
configurations.configureEach {
    if (name.startsWith("android", ignoreCase = true) || name.startsWith("debug") || name.startsWith("release")) {
        exclude(group = "org.json", module = "json")
    }
}
