// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Torflix for Android TV. What it ships besides its own code is made by two tools:
//   tools/android/build.mjs       (npm run android:build)  the backend and pages → src/main/assets/torflix/
//   tools/android/build-node.sh   (in WSL)                  Node.js → src/main/jniLibs/<abi>/libnode.so
//   tools/android/build-ffmpeg.sh (in WSL)                  FFmpeg's audio decoders → src/main/jniLibs/<abi>/libffmpegJNI.so,
//                                                           and Media3's FFmpeg extension → src/main/ffmpeg/java
// One APK per processor family; install the one that matches the TV.

import groovy.json.JsonSlurper
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val pkg = JsonSlurper().parse(rootDir.resolve("../package.json")) as Map<*, *>
// -Ptorflix.version=<an older version> builds a copy that updates itself to the current one.
val torflixVersion = providers.gradleProperty("torflix.version").orNull ?: pkg["version"] as String
val (major, minor, patch) = torflixVersion.split(".").map { it.toInt() }
// Each start, the app asks this for the latest release and updates itself to it (Updater.kt;
// tools/android/release.mjs publishes them). To try an update without publishing one, serve a
// feed of the same shape to the TV's own 127.0.0.1 (adb reverse) and build with
// -Ptorflix.updateFeed=http://127.0.0.1:<port>/<path>.
val updateFeed = providers.gradleProperty("torflix.updateFeed").orNull
    ?: "https://api.github.com/repos/gary23w/torflix/releases/latest"

android {
    namespace = "io.torflix.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.torflix.app"
        minSdk = 24
        targetSdk = 34
        versionCode = major * 10_000 + minor * 100 + patch
        versionName = torflixVersion
        buildConfigField("String", "UPDATE_FEED", "\"$updateFeed\"")
    }

    splits {
        abi {
            isEnable = true
            reset()
            // x86_64 is for the Android TV emulator.
            include("armeabi-v7a", "arm64-v8a", "x86_64")
            isUniversalApk = false
        }
    }

    sourceSets {
        // Without the extension the player still builds and plays, but a video whose sound the TV
        // cannot decode (Dolby on many boxes) plays silent.
        getByName("main").java.srcDir("src/main/ffmpeg/java")
    }

    packaging {
        // libnode.so is a program, not a library: it has to be extracted to be run.
        jniLibs {
            useLegacyPackaging = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // A test build: signed with the debug key, like the debug build. Updates install only
            // over a Torflix signed with the same key, so releases must keep being signed with it
            // (this PC's ~/.android/debug.keystore) unless every TV reinstalls once.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.media3:media3-exoplayer:1.11.1")
    implementation("androidx.media3:media3-ui:1.11.1")
    // The annotations Media3's FFmpeg extension classes are written with; needed to compile them only.
    compileOnly("androidx.annotation:annotation:1.6.0")
    compileOnly("org.checkerframework:checker-qual:3.43.0")
}
