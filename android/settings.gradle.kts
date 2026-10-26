// SPDX-License-Identifier: MIT OR Apache-2.0
// Torflix for Android TV: the app around the shared backend and pages (see app/build.gradle.kts).

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

rootProject.name = "torflix-android"
include(":app")
