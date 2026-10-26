// SPDX-License-Identifier: MIT OR Apache-2.0

package io.torflix.app

import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Commands to the engine from the app itself (the TV player's position reports and status), in
 * order, off the main thread.
 */
object Rpc {
    private const val TAG = "TorflixRpc"
    private val queue = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    fun post(command: String, args: JSONArray) = call(command, args, null)

    /** Runs a command; `onValue` gets its value on the main thread, or null if it failed. */
    fun call(command: String, args: JSONArray, onValue: ((Any?) -> Unit)?) {
        val bridge = NodeBackend.bridge ?: return
        queue.execute {
            val value = try {
                val c = URL("${bridge.origin}/rpc/$command").openConnection() as HttpURLConnection
                c.requestMethod = "POST"
                c.doOutput = true
                c.connectTimeout = 5_000
                c.readTimeout = 10_000
                c.setRequestProperty("Content-Type", "application/json")
                c.setRequestProperty("Cookie", "tp=${bridge.token}")
                c.outputStream.use { it.write(args.toString().toByteArray()) }
                if (c.responseCode != 200) Log.w(TAG, "$command: HTTP ${c.responseCode}")
                val body = c.inputStream.use { String(it.readBytes()) }
                c.disconnect()
                val r = JSONObject(body)
                if (r.optBoolean("ok")) r.opt("value") else null
            } catch (e: Exception) {
                Log.w(TAG, "$command failed: ${e.message}")
                null
            }
            if (onValue != null) main.post { onValue(value) }
        }
    }
}
