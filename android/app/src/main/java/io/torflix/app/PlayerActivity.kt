// SPDX-License-Identifier: MIT OR Apache-2.0

@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package io.torflix.app

import android.app.Activity
import android.content.Intent
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
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.media3.exoplayer.util.EventLogger
import androidx.media3.ui.PlayerView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.lang.ref.WeakReference
import java.util.Locale

/**
 * The TV's own player for a Torflix stream. It plays what the WebView's player cannot (Matroska,
 * HEVC, and Dolby or DTS audio: decoded by the TV, passed through to the receiver, or, on TVs with
 * no decoder an app may use, decoded by FFmpeg's, built by tools/android/build-ffmpeg.sh), reports
 * the position to the engine as the desktop player does, and tells the page when the first frame
 * shows, when the video ends, and when the viewer leaves.
 *
 * The request (EXTRA_SPEC), as MainActivity passes on the page's: `{ streamId, url, title,
 * resumePositionSecs, subtitles: [{ label, language, selected, file }] }`.
 */
class PlayerActivity : Activity() {
    companion object {
        const val EXTRA_SPEC = "io.torflix.app.SPEC"
        private const val TAG = "TorflixPlayer"
        private const val REPORT_MS = 5_000L
        private const val SKIP_MS = 10_000L
        private const val STATUS_MS = 1_500L
        private const val NOTICE_MS = 10_000L
        /** The desktop's rule (shared/copies.js): a copy that sends this little in this long is given up. */
        private const val NO_DATA_MS = 20_000L
        private const val NO_DATA_BYTES = 2L * 1024 * 1024

        /** How long a player opened at a Play press waits for its stream before giving up. */
        private const val PENDING_MS = 90_000L

        private var current: WeakReference<PlayerActivity>? = null

        /**
         * The page stopped a stream (another video, or the torrent went away): its player closes,
         * not one already opening for the next video. Null: whatever it shows.
         */
        fun closeFromApp(streamId: Int?) {
            val p = current?.get() ?: return
            if (streamId == null || p.streamId == streamId) p.finish()
        }

        /** The Play press it was opened for came to nothing (the stream could not start). */
        fun cancelPending(playId: Int) {
            val p = current?.get() ?: return
            if (p.streamId < 0 && p.playId == playId) p.finish()
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var view: PlayerView
    /** What the swarm is doing while the video starts or buffers: the page that says so is hidden. */
    private lateinit var status: TextView
    /** Something the viewer should know while the video plays, such as sound the TV cannot play. */
    private lateinit var notice: TextView
    private val hideNoticeLater = Runnable { hideNotice() }
    private var player: ExoPlayer? = null
    private var streamId = -1
    /** The Play press this player is for, and when it was pressed (for the timing in the log). */
    private var playId = -1
    private var pressedAt = 0L
    private val pendingTimeout = Runnable { if (streamId < 0) finish() }
    private var openedAt = 0L
    private var firstFrameMs: Long? = null
    private var seekStartedAt = 0L
    private var lastSeekMs: Long? = null
    private var ended = false
    private var closedSent = false
    /** Bytes the torrent had when this video opened, and whether it was given up for sending nothing. */
    private var receivedAtOpen: Long? = null
    private var gaveUp = false
    private val tick = object : Runnable {
        override fun run() {
            report()
            main.postDelayed(this, REPORT_MS)
        }
    }
    private val statusTick = object : Runnable {
        override fun run() {
            pollStatus()
            main.postDelayed(this, STATUS_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        current = WeakReference(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        view = PlayerView(this).apply {
            keepScreenOn = true
            controllerShowTimeoutMs = 3_500
            setShowSubtitleButton(true)
            setShowNextButton(false)
            setShowPreviousButton(false)
            setShowBuffering(PlayerView.SHOW_BUFFERING_ALWAYS)
        }
        status = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 18f
            gravity = Gravity.CENTER
            setShadowLayer(6f, 0f, 0f, Color.BLACK)
        }
        notice = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 18f
            gravity = Gravity.CENTER
            setShadowLayer(6f, 0f, 0f, Color.BLACK)
            visibility = View.GONE
        }
        val dp = resources.displayMetrics.density
        setContentView(FrameLayout(this).apply {
            addView(view, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            // Under the buffering spinner, clear of the controls.
            addView(status, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.CENTER).apply { topMargin = (110 * dp).toInt() })
            addView(notice, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.TOP).apply { topMargin = (48 * dp).toInt() })
        })
        open(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // Another video in the same window: the one playing is left first (a player still
        // waiting for its stream simply gets it).
        if (streamId >= 0) {
            report()
            sendClosed()
        }
        open(intent)
    }

    private fun open(intent: Intent) {
        val spec = try {
            JSONObject(intent.getStringExtra(EXTRA_SPEC) ?: "{}")
        } catch (e: Exception) {
            Log.w(TAG, "bad request: ${e.message}")
            return finish()
        }
        if (spec.optBoolean("pending")) {
            // Opened at the Play press: ready (player built, decoders warm) when the stream is.
            playId = spec.optInt("playId", -1)
            pressedAt = spec.optLong("pressedAt", SystemClock.elapsedRealtime())
            streamId = -1
            closedSent = false
            firstFrameMs = null
            ended = false
            main.removeCallbacks(statusTick)
            main.removeCallbacks(tick)
            showStatus("Opening…")
            if (player == null) player = build()
            main.removeCallbacks(pendingTimeout)
            main.postDelayed(pendingTimeout, PENDING_MS)
            Log.i(TAG, "[timing] play $playId: player open +${SystemClock.elapsedRealtime() - pressedAt} ms, waiting for the stream")
            return
        }
        main.removeCallbacks(pendingTimeout)
        val press = spec.optInt("playId", -1)
        if (press < 0 || press != playId) pressedAt = SystemClock.elapsedRealtime()
        playId = press
        streamId = spec.optInt("streamId", -1)
        Log.i(TAG, "stream $streamId: opening \"${spec.optString("title")}\" at ${spec.optDouble("resumePositionSecs", 0.0)} s")
        openedAt = SystemClock.elapsedRealtime()
        firstFrameMs = null
        lastSeekMs = null
        seekStartedAt = 0L
        ended = false
        closedSent = false
        receivedAtOpen = null
        gaveUp = false
        showStatus("Opening…")
        main.removeCallbacks(statusTick)
        main.post(statusTick)
        val item = MediaItem.Builder()
            .setUri(spec.getString("url"))
            .setMediaMetadata(MediaMetadata.Builder().setTitle(spec.optString("title")).build())
            .setSubtitleConfigurations(subtitles(spec.optJSONArray("subtitles")))
            .build()
        val p = player ?: build().also { player = it }
        p.setMediaItem(item, (spec.optDouble("resumePositionSecs", 0.0) * 1000).toLong().coerceAtLeast(0))
        p.prepare()
        p.playWhenReady = true
        main.removeCallbacks(tick)
        main.postDelayed(tick, REPORT_MS)
    }

    /** The torrent's subtitle files, as SRT files (written by MainActivity) the player loads itself. */
    private fun subtitles(list: JSONArray?): List<MediaItem.SubtitleConfiguration> {
        if (list == null) return emptyList()
        return (0 until list.length()).mapNotNull { i ->
            val s = list.optJSONObject(i) ?: return@mapNotNull null
            // From the stream server, which answers at once and sends the text when it is in.
            val uri = s.optString("url").takeIf { it.startsWith("http://127.0.0.1:") }?.let { Uri.parse(it) }
                ?: File(s.optString("file")).takeIf { it.isFile }?.let { Uri.fromFile(it) }
                ?: return@mapNotNull null
            MediaItem.SubtitleConfiguration.Builder(uri)
                .setMimeType(MimeTypes.APPLICATION_SUBRIP)
                .setLabel(s.optString("label").ifEmpty { null })
                .setLanguage(s.optString("language").ifEmpty { null })
                .setSelectionFlags(if (s.optBoolean("selected")) C.SELECTION_FLAG_DEFAULT else 0)
                .build()
        }
    }

    private fun build(): ExoPlayer {
        // The stream server answers as pieces arrive from the swarm: a read may wait a while.
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent("Torflix")
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(120_000)
        val sources = DefaultMediaSourceFactory(DefaultDataSource.Factory(this, http))
        val tracks = DefaultTrackSelector(this).apply {
            parameters = buildUponParameters().setPreferredAudioLanguage(Locale.getDefault().language).build()
        }
        val audio = AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build()
        // The TV's decoders first; FFmpeg's only for sound they cannot decode.
        val renderers = DefaultRenderersFactory(this)
            .setEnableDecoderFallback(true)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
        return ExoPlayer.Builder(this, renderers)
            .setMediaSourceFactory(sources)
            .setTrackSelector(tracks)
            .setAudioAttributes(audio, true)
            .setSeekBackIncrementMs(SKIP_MS)
            .setSeekForwardIncrementMs(SKIP_MS)
            // A seek (and Resume) starts at the nearest keyframe: shown at once, not decoded up to.
            .setSeekParameters(SeekParameters.CLOSEST_SYNC)
            .build()
            .also {
                it.addListener(Events())
                // Each track and whether this TV can play it, in logcat.
                if (BuildConfig.DEBUG) it.addAnalyticsListener(EventLogger())
                view.player = it
            }
    }

    private inner class Events : Player.Listener {
        override fun onRenderedFirstFrame() = firstFrame()

        override fun onTracksChanged(tracks: Tracks) {
            // A video with sound none of the decoders can play would otherwise play silent, unexplained.
            val audio = tracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
            if (audio.isEmpty() || tracks.isTypeSelected(C.TRACK_TYPE_AUDIO)) return hideNotice()
            val kinds = audio.map { soundName(it.getTrackFormat(0).sampleMimeType) }.distinct().joinToString(", ")
            Log.w(TAG, "stream $streamId: no audio track this TV can play ($kinds)")
            showNotice("This copy's sound ($kinds) can't play on this TV.")
        }

        override fun onPlaybackStateChanged(state: Int) {
            val p = player ?: return
            Log.i(TAG, "stream $streamId: ${stateName(state)} at ${p.currentPosition / 1000} s, buffered to ${p.bufferedPosition / 1000} s")
            if (state == Player.STATE_READY) {
                // Audio alone has no frame to render: ready to play is its first frame.
                if (!p.currentTracks.isTypeSelected(C.TRACK_TYPE_VIDEO)) firstFrame()
                if (seekStartedAt > 0) {
                    lastSeekMs = SystemClock.elapsedRealtime() - seekStartedAt
                    seekStartedAt = 0
                    report(seek = true)
                }
            } else if (state == Player.STATE_ENDED && !ended) {
                ended = true
                report()
                emit("ended")
                finish()
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (!isPlaying) report()
        }

        override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
            if (reason == Player.DISCONTINUITY_REASON_SEEK) seekStartedAt = SystemClock.elapsedRealtime()
        }

        override fun onPlayerError(error: PlaybackException) {
            Log.w(TAG, "playback failed", error)
            emit("error", "The TV could not play this file (${error.errorCodeName}).")
            finish()
        }
    }

    /** Peers, speed and progress from the engine while the video starts or buffers. */
    private fun pollStatus() {
        val p = player ?: return
        val starting = firstFrameMs == null
        if (!starting && p.playbackState != Player.STATE_BUFFERING) return hideStatus()
        val id = streamId
        Rpc.call("streamStats", JSONArray().put(id)) { value ->
            val s = value as? JSONObject ?: return@call
            if (id != streamId || isFinishing) return@call
            val received = s.optLong("receivedBytes")
            val since = received - (receivedAtOpen ?: received.also { receivedAtOpen = it })
            val peers = s.optInt("peersLive")
            val rate = rateText(s.optDouble("downloadBps"))
            val peersText = "$peers peer${if (peers == 1) "" else "s"}"
            showStatus(
                when {
                    firstFrameMs == null && s.optLong("fileDownloaded") == 0L ->
                        if (peers > 0) "Connected to $peersText, waiting for data…" else "Finding peers…"
                    else -> "Buffering… · ↓ $rate · $peersText"
                },
            )
            // A copy that sends nothing: the page tries another copy of the same title.
            if (firstFrameMs == null && !gaveUp && SystemClock.elapsedRealtime() - openedAt >= NO_DATA_MS && since < NO_DATA_BYTES) {
                gaveUp = true
                Log.i(TAG, "stream $streamId: nothing arrived in ${NO_DATA_MS / 1000} s ($since bytes, $peers peers)")
                emit("nodata", "Nothing arrived in ${NO_DATA_MS / 1000} seconds.")
                finish()
            }
        }
    }

    private fun rateText(bps: Double) = if (bps >= 1_000_000) "%.1f MB/s".format(bps / 1_000_000) else "%.0f KB/s".format(bps / 1_000)

    private fun showStatus(text: String) {
        status.text = text
        status.visibility = View.VISIBLE
    }

    private fun hideStatus() {
        status.visibility = View.GONE
    }

    private fun showNotice(text: String) {
        notice.text = text
        notice.visibility = View.VISIBLE
        main.removeCallbacks(hideNoticeLater)
        main.postDelayed(hideNoticeLater, NOTICE_MS)
    }

    private fun hideNotice() {
        main.removeCallbacks(hideNoticeLater)
        notice.visibility = View.GONE
    }

    private fun soundName(mime: String?) = when (mime) {
        MimeTypes.AUDIO_AC3 -> "Dolby Digital"
        MimeTypes.AUDIO_E_AC3, MimeTypes.AUDIO_E_AC3_JOC -> "Dolby Digital Plus"
        MimeTypes.AUDIO_TRUEHD -> "Dolby TrueHD"
        MimeTypes.AUDIO_DTS, MimeTypes.AUDIO_DTS_HD, MimeTypes.AUDIO_DTS_EXPRESS -> "DTS"
        null -> "unknown"
        else -> mime.removePrefix("audio/")
    }

    private fun stateName(state: Int) = when (state) {
        Player.STATE_IDLE -> "idle"
        Player.STATE_BUFFERING -> "buffering"
        Player.STATE_READY -> "ready"
        Player.STATE_ENDED -> "ended"
        else -> "state $state"
    }

    private fun firstFrame() {
        if (firstFrameMs != null) return
        firstFrameMs = SystemClock.elapsedRealtime() - openedAt
        Log.i(TAG, "stream $streamId: first frame after $firstFrameMs ms")
        Log.i(TAG, "[timing] play $playId: first frame +${SystemClock.elapsedRealtime() - pressedAt} ms from Play (stream ready +${openedAt - pressedAt} ms)")
        hideStatus()
        report()
        emit("firstFrame")
    }

    /** The position, to the engine (library resume, buffering ahead), as the desktop player reports it. */
    private fun report(seek: Boolean = false) {
        val p = player ?: return
        if (streamId < 0) return
        val r = JSONObject()
            .put("positionSecs", p.currentPosition / 1000.0)
            .put("durationSecs", durationSecs(p))
            .put("ended", ended)
            .put("seek", seek)
        firstFrameMs?.let { r.put("firstFrameMs", it) }
        lastSeekMs?.let { r.put("lastSeekMs", it) }
        Rpc.post("reportPlayback", JSONArray().put(streamId).put(r))
    }

    private fun durationSecs(p: ExoPlayer) = if (p.duration == C.TIME_UNSET || p.duration < 0) 0.0 else p.duration / 1000.0

    private fun emit(type: String, message: String? = null) {
        val p = player
        val payload = JSONObject()
            .put("type", type)
            .put("streamId", streamId)
            .put("playId", playId)
            .put("positionSecs", (p?.currentPosition ?: 0L) / 1000.0)
            .put("durationSecs", p?.let { durationSecs(it) } ?: 0.0)
        if (message != null) payload.put("message", message)
        MainActivity.emit("native-player", payload)
    }

    private fun sendClosed() {
        if (closedSent) return
        closedSent = true
        emit("closed")
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // With the controls hidden, left and right skip back and ahead, as on most TV players.
        val p = player
        if (p != null && !view.isControllerFullyVisible && event.action == KeyEvent.ACTION_DOWN) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_DPAD_LEFT -> {
                    p.seekBack()
                    return true
                }
                KeyEvent.KEYCODE_DPAD_RIGHT -> {
                    p.seekForward()
                    return true
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    override fun finish() {
        report()
        sendClosed()
        super.finish()
    }

    override fun onStop() {
        super.onStop()
        // Home pressed, or the TV went to sleep: pause where it is.
        if (!isFinishing) player?.pause()
        report()
    }

    override fun onDestroy() {
        main.removeCallbacks(tick)
        main.removeCallbacks(statusTick)
        main.removeCallbacks(hideNoticeLater)
        main.removeCallbacks(pendingTimeout)
        report()
        sendClosed()
        view.player = null
        player?.release()
        player = null
        if (current?.get() === this) current = null
        super.onDestroy()
    }
}
