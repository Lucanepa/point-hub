pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "pointhub-android"
// :app     the tablet app (Android)
// :shared  the native Game tab, header and tabs, shared by both apps (Kotlin Multiplatform + Compose)
// :desktop the desktop app (Compose Desktop, the console's tabs embedded through JCEF)
include(":app", ":shared", ":desktop")
