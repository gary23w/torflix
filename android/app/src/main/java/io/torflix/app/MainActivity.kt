// SPDX-License-Identifier: MIT OR Apache-2.0

package io.torflix.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.lang.ref.WeakReference

/**
 * The app's window: the same pages as the desktop app, in a full-screen WebView, served by the
 * engine (NodeBackend). The page reaches the app through `window.tpNative` (play a video in the
 * TV's player, stop it, open a link, leave), and hears from it through
 * `window.__tpNativeEmit(name, payloadJson)`: the remote's Back key and the TV player's reports.
 * Each start it also looks for a newer Torflix (Updater), and covers the page while it updates.
 */
class MainActivity : Activity(), NodeBackend.Listener, Updater.Listener {
    companion object {
        private const val TAG = "TorflixPage"
        private const val START_TIMEOUT_MS = 45_000L
        /** Poster images come from these two keyless sources, as on the desktop. */
        private val IMAGE_HOSTS = Regex("""(^|\.)(tvmaze\.com|wikimedia\.org)$""")

        private var current: WeakReference<MainActivity>? = null

        /** Delivers an event to the page, from anywhere in the app. */
        fun emit(name: String, payload: JSONObject?) {
            Handler(Looper.getMainLooper()).post { current?.get()?.emitToPage(name, payload) }
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var web: WebView
    private lateinit var status: TextView
    private lateinit var update: UpdateScreen
    private var loadedOrigin: String? = null
    private var failed = false
    private var leaving = false
    private val startTimeout = Runnable { showProblem(getString(R.string.start_timeout)) }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        current = WeakReference(this)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web = WebView(this).apply {
            setBackgroundColor(Color.rgb(11, 11, 15))
            isFocusable = true
            isFocusableInTouchMode = true
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false
                allowFileAccess = false
                allowContentAccess = false
                javaScriptCanOpenWindowsAutomatically = false
                setSupportMultipleWindows(false)
                setSupportZoom(false)
                cacheMode = WebSettings.LOAD_NO_CACHE
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            }
            webViewClient = PageClient()
            webChromeClient = PageChrome()
            addJavascriptInterface(NativeBridge(), "tpNative")
        }
        status = TextView(this).apply {
            setBackgroundColor(Color.rgb(11, 11, 15))
            setTextColor(Color.WHITE)
            textSize = 20f
            gravity = Gravity.CENTER
            setPadding(64, 64, 64, 64)
            text = getString(R.string.starting)
        }
        update = UpdateScreen(this)
        setContentView(FrameLayout(this).apply {
            addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(status, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(update, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        })
        startEngine()
        // A start of the app, not the window coming back after its page's renderer stopped.
        if (savedInstanceState == null) Updater.check(this)
        if (intent?.action == Updater.ACTION_STATUS) Updater.onStatus(this, intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == Updater.ACTION_STATUS) Updater.onStatus(this, intent)
    }

    override fun onUpdateState(state: Updater.State) {
        update.show(state)
    }

    private fun startEngine() {
        failed = false
        status.text = getString(R.string.starting)
        status.visibility = View.VISIBLE
        main.removeCallbacks(startTimeout)
        main.postDelayed(startTimeout, START_TIMEOUT_MS)
        NodeBackend.addListener(this)
        NodeBackend.retry(this)
    }

    override fun onReady(bridge: NodeBackend.Bridge) {
        main.removeCallbacks(startTimeout)
        failed = false
        if (loadedOrigin == bridge.origin) return
        // A new engine (first start, or a restart on a new port): the page starts over with it.
        loadedOrigin = bridge.origin
        val cookies = CookieManager.getInstance()
        cookies.setCookie(bridge.origin, "tp=${bridge.token}; Path=/; SameSite=Strict") {
            cookies.flush()
            web.loadUrl("${bridge.origin}/renderer/index.html")
        }
    }

    override fun onFailed(message: String) {
        showProblem(message)
    }

    private fun showProblem(message: String) {
        main.removeCallbacks(startTimeout)
        failed = true
        status.text = "$message\n\n${getString(R.string.retry_hint)}"
        status.visibility = View.VISIBLE
    }

    private fun emitToPage(name: String, payload: JSONObject?) {
        val json = payload?.toString() ?: "null"
        web.evaluateJavascript("window.__tpNativeEmit && window.__tpNativeEmit(${JSONObject.quote(name)}, ${JSONObject.quote(json)})", null)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val key = event.keyCode
        if (Updater.state !is Updater.State.Idle) {
            // The update screen has the remote: OK goes on, Back puts the update off.
            if (event.action == KeyEvent.ACTION_UP) {
                when (key) {
                    KeyEvent.KEYCODE_BACK -> Updater.later(this)
                    KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> Updater.ok(this)
                }
            }
            return true
        }
        if (key == KeyEvent.KEYCODE_BACK) {
            // The page decides what Back does (close a panel, go back a page, or leave).
            if (event.action == KeyEvent.ACTION_UP) {
                if (failed || status.visibility == View.VISIBLE) leave() else emitToPage("tv-back", null)
            }
            return true
        }
        if (failed && event.action == KeyEvent.ACTION_UP && (key == KeyEvent.KEYCODE_DPAD_CENTER || key == KeyEvent.KEYCODE_ENTER)) {
            loadedOrigin = null
            startEngine()
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun leave() {
        leaving = true
        finish()
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        Updater.attach(this, this)
    }

    override fun onPause() {
        Updater.detach(this)
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        main.removeCallbacks(startTimeout)
        NodeBackend.removeListener(this)
        if (current?.get() === this) current = null
        web.destroy()
        // Leaving the app stops the engine; the system closing the window does not.
        if (leaving) NodeBackend.stop()
        super.onDestroy()
    }

    private fun allowed(uri: Uri): Boolean {
        val host = uri.host ?: return false
        return when (uri.scheme) {
            "http" -> host == "127.0.0.1"
            "https" -> IMAGE_HOSTS.containsMatchIn(host)
            else -> false
        }
    }

    private inner class PageClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // The page never navigates away from the app.
            val origin = loadedOrigin ?: return true
            return !request.url.toString().startsWith("$origin/")
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            if (allowed(request.url)) return null
            Log.w(TAG, "blocked ${request.url}")
            return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }

        override fun onPageFinished(view: WebView, url: String) {
            if (failed) return
            status.visibility = View.GONE
            web.requestFocus()
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.e(TAG, "the page's renderer stopped; starting the window again")
            recreate()
            return true
        }
    }

    private inner class PageChrome : WebChromeClient() {
        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            val line = "${message.message()} (${message.sourceId()}:${message.lineNumber()})"
            when (message.messageLevel()) {
                ConsoleMessage.MessageLevel.ERROR -> Log.e(TAG, line)
                ConsoleMessage.MessageLevel.WARNING -> Log.w(TAG, line)
                else -> Log.i(TAG, line)
            }
            return true
        }

        /** No grey play button over the search page's preview frames. */
        override fun getDefaultVideoPoster(): Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
    }

    /** `window.tpNative`. Called on a WebView thread; everything runs on the main thread. */
    private inner class NativeBridge {
        /** Play was pressed: the TV's player opens now and waits for the stream (`play`). */
        @JavascriptInterface
        fun prepare(spec: String) {
            main.post { preparePlayer(spec) }
        }

        @JavascriptInterface
        fun play(spec: String) {
            main.post { openPlayer(spec) }
        }

        /** That press came to nothing: its waiting player closes. */
        @JavascriptInterface
        fun cancel(playId: Int) {
            main.post { PlayerActivity.cancelPending(playId) }
        }

        /** A stream stopped: its player closes (not one opening for another video). */
        @JavascriptInterface
        fun stopStream(streamId: Int) {
            main.post { PlayerActivity.closeFromApp(streamId) }
        }

        @JavascriptInterface
        fun stop() {
            main.post { PlayerActivity.closeFromApp(null) }
        }

        @JavascriptInterface
        fun openLink(url: String) {
            main.post { openExternal(url) }
        }

        @JavascriptInterface
        fun exit() {
            main.post { leave() }
        }
    }

    private fun preparePlayer(spec: String) {
        val request = try {
            JSONObject(spec)
        } catch (e: Exception) {
            Log.w(TAG, "bad prepare request: ${e.message}")
            return
        }
        request.put("pending", true)
        request.put("pressedAt", SystemClock.elapsedRealtime())
        startPlayer(request)
    }

    private fun openPlayer(spec: String) {
        val request = try {
            JSONObject(spec)
        } catch (e: Exception) {
            Log.w(TAG, "bad play request: ${e.message}")
            return
        }
        // Only the engine's own stream server.
        val url = request.optString("url")
        if (!url.startsWith("http://127.0.0.1:")) {
            Log.w(TAG, "refused to play $url")
            return
        }
        request.optJSONArray("subtitles")?.let { list ->
            val dir = File(cacheDir, "subtitles")
            for (i in 0 until list.length()) {
                val s = list.optJSONObject(i) ?: continue
                // By address, from the stream server too; or as SRT text, which goes to a file:
                // an Intent carries at most about 1 MB, and a few SRT files are more.
                if (s.has("url")) {
                    if (!s.optString("url").startsWith("http://127.0.0.1:")) s.remove("url")
                    continue
                }
                if (!s.has("srt")) continue
                dir.mkdirs()
                val file = File(dir, "${request.optInt("streamId", -1)}-$i.srt")
                file.writeText(s.optString("srt"))
                s.remove("srt")
                s.put("file", file.path)
            }
        }
        startPlayer(request)
    }

    private fun startPlayer(request: JSONObject) {
        startActivity(
            Intent(this, PlayerActivity::class.java)
                .putExtra(PlayerActivity.EXTRA_SPEC, request.toString())
                // Straight to the picture: no opening animation to wait through.
                .addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION),
        )
    }

    private fun openExternal(url: String) {
        if (!Regex("^https?://\\S+$", RegexOption.IGNORE_CASE).matches(url)) return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_browser, Toast.LENGTH_LONG).show()
        }
    }
}
