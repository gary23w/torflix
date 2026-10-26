// SPDX-License-Identifier: MIT OR Apache-2.0

package io.torflix.app

import android.app.Activity
import android.app.ActivityOptions
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlin.concurrent.thread

/**
 * Torflix keeps itself up to date from its GitHub releases. Each time the app starts it asks for
 * the latest release (BuildConfig.UPDATE_FEED); one with a newer version and an APK for this TV's
 * processor (`torflix-<version>-<abi>.apk`, as tools/android/release.mjs names them) is
 * downloaded straight into an install session and installed. The system only lets that APK
 * replace this app if it is the same app signed with the same key; the download is also checked
 * against the release's size and SHA-256 before it is handed over.
 *
 * Everything here runs on the main thread except the network, which posts back to it. The
 * listener is MainActivity while it is in front (UpdateScreen shows the state).
 */
object Updater {
    private const val TAG = "TorflixUpdate"
    const val ACTION_STATUS = "io.torflix.app.UPDATE_STATUS"
    private const val PREFS = "update"
    private const val PROGRESS_MS = 100L
    private const val FAILED_SHOWN_MS = 8_000L
    private const val LOCAL = "http://127.0.0.1:"

    data class Release(val version: String, val url: String, val size: Long, val sha256: String?)

    sealed class State {
        object Idle : State()
        /** Android 8 and later: the viewer has to let Torflix install apps first. */
        data class NeedsPermission(val release: Release) : State()
        data class Downloading(val release: Release, val done: Long, val total: Long, val bytesPerSec: Long) : State()
        /** Handed to the system; `waitingForOk` while it asks the viewer to confirm. */
        data class Installing(val release: Release, val waitingForOk: Boolean) : State()
        data class Failed(val message: String) : State()
    }

    interface Listener {
        fun onUpdateState(state: State)
    }

    private val main = Handler(Looper.getMainLooper())
    private var listener: Listener? = null
    private var checking = false
    @Volatile
    private var cancelled = false
    private var sessionId = -1
    /** The system's "install this update?" screen, once it asks for it. */
    private var confirm: Intent? = null
    private var confirmShown = false
    private val dismissFailed = Runnable { if (state is State.Failed) set(State.Idle) }

    var state: State = State.Idle
        private set

    /** MainActivity came to the front: it shows the state, and anything waiting on it goes on. */
    fun attach(activity: Activity, l: Listener) {
        listener = l
        l.onUpdateState(state)
        val s = state
        if (s is State.NeedsPermission && canInstall(activity)) download(activity, s.release)
        showConfirm(activity)
    }

    fun detach(l: Listener) {
        if (listener === l) listener = null
    }

    /** At each start of the app: is there a newer release? Quietly does nothing if not. */
    fun check(context: Context) {
        if (state !is State.Idle || checking) return
        val app = context.applicationContext
        updated(app)
        checking = true
        thread(name = "torflix-update-check") {
            val release = try {
                latest()
            } catch (e: Exception) {
                Log.i(TAG, "no update check: ${e.message}")
                null
            }
            main.post {
                checking = false
                if (release == null || state !is State.Idle) return@post
                Log.i(TAG, "version ${release.version} is out (this is ${BuildConfig.VERSION_NAME})")
                if (canInstall(app)) download(app, release) else set(State.NeedsPermission(release))
            }
        }
    }

    /** OK on the update screen. */
    fun ok(activity: Activity) {
        when (val s = state) {
            is State.NeedsPermission -> openPermission(activity, s.release)
            is State.Installing -> if (s.waitingForOk) {
                confirmShown = false
                showConfirm(activity)
            }
            is State.Failed -> set(State.Idle)
            else -> Unit
        }
    }

    /** Back on the update screen: this update waits for the next start. */
    fun later(context: Context) {
        when (state) {
            is State.Idle -> return
            is State.Downloading -> cancelled = true
            is State.Installing -> abandon(context)
            else -> Unit
        }
        set(State.Idle)
    }

    /** The install session's result, which the system delivers to MainActivity. */
    fun onStatus(activity: Activity, intent: Intent) {
        val context: Context = activity
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1) != sessionId) return
        val s = state as? State.Installing ?: return
        Log.i(TAG, "install status $status: ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                confirm = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(Intent.EXTRA_INTENT)
                }
                confirmShown = false
                set(s.copy(waitingForOk = true))
                showConfirm(activity)
            }
            // A new version replaces this process, so this is only heard when it did not.
            PackageInstaller.STATUS_SUCCESS -> set(State.Idle)
            else -> {
                sessionId = -1
                confirm = null
                prefs(context).edit().clear().apply()
                fail(context.getString(when (status) {
                    PackageInstaller.STATUS_FAILURE_ABORTED -> R.string.update_cancelled
                    PackageInstaller.STATUS_FAILURE_CONFLICT -> R.string.update_conflict
                    PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> R.string.update_incompatible
                    PackageInstaller.STATUS_FAILURE_STORAGE -> R.string.update_storage
                    else -> R.string.update_install_failed
                }))
            }
        }
    }

    private fun set(next: State) {
        state = next
        main.removeCallbacks(dismissFailed)
        if (next is State.Failed) main.postDelayed(dismissFailed, FAILED_SHOWN_MS)
        listener?.onUpdateState(next)
    }

    private fun fail(message: String) = set(State.Failed(message))

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** The first start after an update says so. */
    private fun updated(context: Context) {
        val p = prefs(context)
        val to = p.getString("to", null) ?: return
        p.edit().clear().apply()
        if (to == BuildConfig.VERSION_NAME) Toast.makeText(context, context.getString(R.string.update_done, to), Toast.LENGTH_LONG).show()
    }

    fun canInstall(context: Context) = Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()

    private fun openPermission(activity: Activity, release: Release) {
        try {
            activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
        } catch (e: ActivityNotFoundException) {
            // No such page on this TV: the system asks instead when the update installs.
            Log.i(TAG, "no install-permission setting: ${e.message}")
            download(activity, release)
        }
    }

    private fun showConfirm(activity: Activity) {
        val intent = confirm ?: return
        if (confirmShown || (state as? State.Installing)?.waitingForOk != true) return
        confirmShown = true
        try {
            activity.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            abandon(activity)
            fail(activity.getString(R.string.update_install_failed))
        }
    }

    private fun abandon(context: Context) {
        val id = sessionId
        sessionId = -1
        confirm = null
        prefs(context).edit().clear().apply()
        if (id < 0) return
        try {
            context.packageManager.packageInstaller.abandonSession(id)
        } catch (e: Exception) {
            Log.i(TAG, "could not abandon session $id: ${e.message}")
        }
    }

    private fun open(url: String): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 20_000
            setRequestProperty("User-Agent", "Torflix/${BuildConfig.VERSION_NAME} (https://github.com/gary23w/torflix; android-tv)")
        }

    /** The latest release, if it is newer than this build and has an APK for this TV. */
    private fun latest(): Release? {
        val c = open(BuildConfig.UPDATE_FEED)
        c.setRequestProperty("Accept", "application/vnd.github+json")
        try {
            // 404: nothing released yet.
            if (c.responseCode != 200) {
                Log.i(TAG, "update feed: HTTP ${c.responseCode}")
                return null
            }
            val r = JSONObject(c.inputStream.use { String(it.readBytes()) })
            val version = r.optString("tag_name").removePrefix("v")
            if (!newer(version, BuildConfig.VERSION_NAME)) return null
            val assets = r.optJSONArray("assets") ?: return null
            // The TV's preferred processor family first.
            for (abi in Build.SUPPORTED_ABIS) {
                for (i in 0 until assets.length()) {
                    val a = assets.optJSONObject(i) ?: continue
                    if (!a.optString("name").endsWith("-$abi.apk")) continue
                    val url = a.optString("browser_download_url")
                    // Plain HTTP only from a test feed on this device (see app/build.gradle.kts).
                    if (!url.startsWith("https://") && !(url.startsWith(LOCAL) && BuildConfig.UPDATE_FEED.startsWith(LOCAL))) continue
                    val digest = a.optString("digest")
                    return Release(version, url, a.optLong("size", -1), digest.takeIf { it.startsWith("sha256:") }?.substring(7)?.lowercase())
                }
            }
            Log.i(TAG, "version $version has no APK for ${Build.SUPPORTED_ABIS.joinToString()}")
            return null
        } finally {
            c.disconnect()
        }
    }

    /** `0.10.0` is newer than `0.9.2`; anything after a `-` is ignored. */
    internal fun newer(version: String, than: String): Boolean {
        fun parts(v: String): List<Int>? = v.substringBefore('-').split('.').map { it.toIntOrNull() ?: return null }
        val a = parts(version) ?: return false
        val b = parts(than) ?: return false
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }
            val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    private fun download(context: Context, release: Release) {
        val app = context.applicationContext
        cancelled = false
        set(State.Downloading(release, 0, release.size, 0))
        thread(name = "torflix-update-download") {
            val installer = app.packageManager.packageInstaller
            var id = -1
            try {
                // Sessions an earlier run left unfinished.
                for (old in installer.mySessions) {
                    try {
                        installer.abandonSession(old.sessionId)
                    } catch (_: Exception) {
                    }
                }
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                    // Anything but Torflix is refused.
                    setAppPackageName(app.packageName)
                    if (release.size > 0) setSize(release.size)
                    // Android 12 and later let an app update itself without asking.
                    if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                }
                id = installer.createSession(params)
                installer.openSession(id).use { session ->
                    val c = open(release.url)
                    try {
                        if (c.responseCode != 200) throw IOException("HTTP ${c.responseCode}")
                        val total = if (release.size > 0) release.size else c.contentLengthLong
                        val sha = MessageDigest.getInstance("SHA-256")
                        var done = 0L
                        var lastAt = SystemClock.elapsedRealtime()
                        var lastDone = 0L
                        var rate = 0L
                        session.openWrite("torflix.apk", 0, total).use { out ->
                            c.inputStream.use { input ->
                                val buf = ByteArray(64 * 1024)
                                while (true) {
                                    if (cancelled) throw IOException("cancelled")
                                    val n = input.read(buf)
                                    if (n < 0) break
                                    sha.update(buf, 0, n)
                                    out.write(buf, 0, n)
                                    done += n
                                    val now = SystemClock.elapsedRealtime()
                                    if (now - lastAt >= PROGRESS_MS) {
                                        val instant = (done - lastDone) * 1000 / (now - lastAt)
                                        rate = if (rate == 0L) instant else (rate * 4 + instant) / 5
                                        lastAt = now
                                        lastDone = done
                                        val progress = State.Downloading(release, done, total, rate)
                                        main.post { if (state is State.Downloading && !cancelled) set(progress) }
                                    }
                                }
                            }
                            session.fsync(out)
                        }
                        if (release.size > 0 && done != release.size) throw IOException("got $done of ${release.size} bytes")
                        val hex = sha.digest().joinToString("") { "%02x".format(it) }
                        if (release.sha256 != null && hex != release.sha256) throw IOException("SHA-256 $hex, expected ${release.sha256}")
                    } finally {
                        c.disconnect()
                    }
                    if (cancelled) throw IOException("cancelled")
                    val committed = id
                    main.post {
                        if (cancelled) return@post
                        sessionId = committed
                        confirm = null
                        set(State.Installing(release, waitingForOk = false))
                    }
                    // So the new version says it was updated, the first time it starts.
                    prefs(app).edit().putString("to", release.version).commit()
                    // The result comes to the window: with it the system opens the new version,
                    // where Android lets it (before Android 10; later ones keep a background app
                    // from opening, so the viewer opens it again from the home screen).
                    val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                    val status = Intent(app, MainActivity::class.java).setAction(ACTION_STATUS)
                    // While the window is on screen it may be brought back with the result (apps
                    // targeting Android 15 or later have to ask for that).
                    val options = if (Build.VERSION.SDK_INT >= 34) {
                        val mode = if (Build.VERSION.SDK_INT >= 36) {
                            ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOW_IF_VISIBLE
                        } else {
                            @Suppress("DEPRECATION")
                            ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED
                        }
                        ActivityOptions.makeBasic().setPendingIntentCreatorBackgroundActivityStartMode(mode).toBundle()
                    } else {
                        null
                    }
                    session.commit(PendingIntent.getActivity(app, id, status, flags, options).intentSender)
                    Log.i(TAG, "version ${release.version} downloaded (${release.size} bytes) and handed to the system")
                }
            } catch (e: Exception) {
                if (id >= 0) {
                    try {
                        installer.abandonSession(id)
                    } catch (_: Exception) {
                    }
                }
                Log.w(TAG, "update to ${release.version} stopped: ${e.message}")
                main.post {
                    if (cancelled) return@post
                    prefs(app).edit().clear().apply()
                    fail(app.getString(R.string.update_download_failed))
                }
            }
        }
    }
}
