// SPDX-License-Identifier: MIT OR Apache-2.0

package io.torflix.app

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArraySet
import kotlin.concurrent.thread

/**
 * Torflix's engine: Node.js (shipped as libnode.so) running backend.mjs, the same services as
 * the desktop app, which serves the page, its commands and its events on 127.0.0.1 behind a
 * per-run token. One per app process: it outlives the activities, and starts again if it stops.
 */
object NodeBackend {
    private const val TAG = "TorflixNode"
    private const val READY = "TORFLIX_READY "
    private const val MAX_RESTARTS = 5
    private const val KEPT_LINES = 12

    /** Where the page and its commands are served, and the token every request must carry. */
    data class Bridge(val port: Int, val token: String) {
        val origin get() = "http://127.0.0.1:$port"
    }

    interface Listener {
        fun onReady(bridge: Bridge)
        fun onFailed(message: String)
    }

    @Volatile
    var bridge: Bridge? = null
        private set

    private val main = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArraySet<Listener>()
    private val lastLines = ArrayDeque<String>()
    private var process: Process? = null
    private var starting = false
    private var stopping = false
    private var restarts = 0

    fun addListener(listener: Listener) {
        listeners.add(listener)
        bridge?.let { b -> main.post { listener.onReady(b) } }
    }

    fun removeListener(listener: Listener) {
        listeners.remove(listener)
    }

    /** Starts the engine unless it runs (or is starting) already. */
    @Synchronized
    fun start(context: Context) {
        if (process != null || starting) return
        starting = true
        stopping = false
        val app = context.applicationContext
        thread(name = "torflix-node-start") { launch(app) }
    }

    /** Starts again after it gave up (the viewer pressed OK on the error). */
    @Synchronized
    fun retry(context: Context) {
        restarts = 0
        start(context)
    }

    /** Stops the engine; it shuts down cleanly on SIGTERM. */
    @Synchronized
    fun stop() {
        stopping = true
        bridge = null
        process?.destroy()
        process = null
    }

    private fun launch(app: Context) {
        try {
            val node = File(app.applicationInfo.nativeLibraryDir, "libnode.so")
            if (!node.canExecute()) {
                return fail(app.getString(R.string.no_engine, Build.SUPPORTED_ABIS.joinToString()))
            }
            val root = unpack(app)
            val token = randomHex(16)
            val downloads = File(app.getExternalFilesDir(null) ?: File(app.filesDir, "downloads"), "Torflix")
            val builder = ProcessBuilder(node.path, File(root, "backend.mjs").path).directory(root)
            builder.environment().apply {
                put("TORFLIX_TOKEN", token)
                put("TORFLIX_DATA", File(app.filesDir, "data").path)
                put("TORFLIX_DOWNLOADS", downloads.path)
                put("TORFLIX_STATIC", root.path)
                put("UV_THREADPOOL_SIZE", "16")
                put("HOME", app.filesDir.path)
                put("TMPDIR", app.cacheDir.path)
                // Test builds log every stream request and peer to logcat.
                if (BuildConfig.DEBUG) put("TORRENTPLAYER_DEBUG", "1")
            }
            val p = builder.start()
            synchronized(this) {
                process = p
                starting = false
            }
            Log.i(TAG, "started ${node.path}")
            read(p.errorStream) { line -> keep(line); Log.w(TAG, line) }
            read(p.inputStream) { line ->
                if (line.startsWith(READY)) {
                    val port = JSONObject(line.removePrefix(READY)).getInt("port")
                    val b = Bridge(port, token)
                    bridge = b
                    main.post { listeners.forEach { it.onReady(b) } }
                } else {
                    keep(line)
                }
                Log.i(TAG, line)
            }
            thread(name = "torflix-node-wait") { exited(app, p, p.waitFor()) }
        } catch (e: Exception) {
            Log.e(TAG, "could not start", e)
            fail("${app.getString(R.string.engine_failed)}\n${e.message ?: e}")
        }
    }

    private fun exited(app: Context, p: Process, code: Int) {
        val again: Boolean
        synchronized(this) {
            if (process !== p) return
            process = null
            bridge = null
            again = !stopping && restarts < MAX_RESTARTS
            if (again) restarts += 1
        }
        Log.w(TAG, "stopped with code $code")
        if (stopping) return
        if (!again) {
            val tail = synchronized(lastLines) { lastLines.joinToString("\n") }
            return fail("${app.getString(R.string.engine_failed)}\n$tail")
        }
        // Back off a little more each time: 1, 2, 4, 8, 16 seconds.
        main.postDelayed({ start(app) }, 1000L shl (restarts - 1))
    }

    private fun fail(message: String) {
        synchronized(this) { starting = false }
        main.post { listeners.forEach { it.onFailed(message) } }
    }

    /**
     * Copies the backend and the pages out of the APK the first time, and again after every
     * install of a new build (the file names in the APK cannot be run or served as they are).
     */
    private fun unpack(app: Context): File {
        val root = File(app.filesDir, "torflix")
        val info = app.packageManager.getPackageInfo(app.packageName, 0)
        val stamp = "${info.lastUpdateTime}"
        val stampFile = File(root, ".stamp")
        if (stampFile.isFile && stampFile.readText() == stamp) return root
        val fresh = File(app.filesDir, "torflix.new")
        fresh.deleteRecursively()
        copyAssets(app, "torflix", fresh)
        File(fresh, ".stamp").writeText(stamp)
        root.deleteRecursively()
        if (!fresh.renameTo(root)) error("could not move the app's files into place")
        return root
    }

    private fun copyAssets(app: Context, path: String, to: File) {
        val children = app.assets.list(path) ?: emptyArray()
        if (children.isEmpty()) {
            to.parentFile?.mkdirs()
            app.assets.open(path).use { input -> to.outputStream().use { input.copyTo(it) } }
            return
        }
        to.mkdirs()
        for (child in children) copyAssets(app, "$path/$child", File(to, child))
    }

    private fun read(stream: InputStream, onLine: (String) -> Unit) {
        thread(name = "torflix-node-output", isDaemon = true) {
            try {
                stream.bufferedReader().useLines { lines -> lines.forEach(onLine) }
            } catch (e: IOException) {
                // Stopping the engine (leaving the app) interrupts the read; that is not an error.
            }
        }
    }

    private fun keep(line: String) {
        synchronized(lastLines) {
            lastLines.addLast(line)
            while (lastLines.size > KEPT_LINES) lastLines.removeFirst()
        }
    }

    private fun randomHex(bytes: Int): String {
        val b = ByteArray(bytes).also { SecureRandom().nextBytes(it) }
        return b.joinToString("") { "%02x".format(it) }
    }
}
