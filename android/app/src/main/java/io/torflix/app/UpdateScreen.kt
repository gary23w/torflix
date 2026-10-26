// SPDX-License-Identifier: MIT OR Apache-2.0

package io.torflix.app

import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.SystemClock
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

/**
 * What the viewer sees while Torflix updates itself (Updater's state): the app's black and red,
 * its icon, and a bar that fills as the new version comes down and runs while it installs.
 * It covers the page until the update is done or put off.
 */
class UpdateScreen(context: Context) : FrameLayout(context) {
    private companion object {
        const val BACKGROUND = 0xFF0B0B0F.toInt()
        const val SURFACE = 0xFF262626.toInt()
        const val TEXT = 0xFFFFFFFF.toInt()
        const val MUTED = 0xFFB3B3B3.toInt()
        const val DIM = 0xFF808080.toInt()
        const val ACCENT = 0xFFE50914.toInt()
        const val FADE_MS = 200L
        val UNITS = arrayOf("B", "KB", "MB", "GB")
    }

    private val dp = resources.displayMetrics.density
    private val glow = Paint()
    private val badge: TextView
    private val title: TextView
    private val detail: TextView
    private val bar: UpdateBar
    private val row: LinearLayout
    private val amount: TextView
    private val percent: TextView
    private val hint: TextView

    init {
        setWillNotDraw(false)
        visibility = GONE
        // Touches stop here, not on the page underneath.
        isClickable = true
        val width = min(520 * dp, resources.displayMetrics.widthPixels - 64 * dp).toInt()

        val icon = ImageView(context).apply { setImageResource(R.drawable.torflix_icon) }
        badge = text(14f, MUTED).apply {
            background = GradientDrawable().apply {
                setColor(SURFACE)
                cornerRadius = 100 * dp
            }
            setPadding((14 * dp).toInt(), (5 * dp).toInt(), (14 * dp).toInt(), (5 * dp).toInt())
            fontFeatureSettings = "tnum"
        }
        title = text(30f, TEXT).apply { typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL) }
        detail = text(17f, MUTED).apply {
            gravity = Gravity.CENTER
            maxWidth = (600 * dp).toInt()
            setLineSpacing(0f, 1.2f)
        }
        bar = UpdateBar(context)
        amount = text(15f, DIM).apply { fontFeatureSettings = "tnum" }
        percent = text(15f, TEXT).apply {
            typeface = Typeface.DEFAULT_BOLD
            fontFeatureSettings = "tnum"
        }
        row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(amount, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(percent, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
        }
        hint = text(15f, DIM)

        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            addView(icon, LinearLayout.LayoutParams((88 * dp).toInt(), (88 * dp).toInt()))
            addView(badge, spaced(WRAP_CONTENT, 24))
            addView(title, spaced(WRAP_CONTENT, 14))
            addView(detail, spaced(WRAP_CONTENT, 8))
            // The bar's view is taller than the bar, for its glow.
            addView(bar, spaced(width, 28).apply { height = (28 * dp).toInt() })
            addView(row, spaced(width, 2))
        }
        addView(column, LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.CENTER))
        addView(hint, LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply {
            bottomMargin = (40 * dp).toInt()
        })
    }

    private fun text(sp: Float, color: Int) = TextView(context).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        setTextColor(color)
    }

    private fun spaced(width: Int, topDp: Int) =
        LinearLayout.LayoutParams(width, WRAP_CONTENT).apply { topMargin = (topDp * dp).toInt() }

    fun show(state: Updater.State) {
        if (state is Updater.State.Idle) {
            disappear()
            return
        }
        val release = when (state) {
            is Updater.State.NeedsPermission -> state.release
            is Updater.State.Downloading -> state.release
            is Updater.State.Installing -> state.release
            else -> null
        }
        badge.visibility = if (release != null) VISIBLE else GONE
        if (release != null) badge.text = context.getString(R.string.update_versions, BuildConfig.VERSION_NAME, release.version)
        title.text = context.getString(R.string.update_title)
        bar.visibility = VISIBLE
        row.visibility = VISIBLE
        amount.text = ""
        percent.text = ""
        hint.text = context.getString(R.string.update_later_hint)
        when (state) {
            is Updater.State.NeedsPermission -> {
                title.text = context.getString(R.string.update_permission_title, state.release.version)
                detail.text = context.getString(R.string.update_permission)
                bar.visibility = GONE
                row.visibility = GONE
                hint.text = context.getString(R.string.update_permission_hint)
            }
            is Updater.State.Downloading -> {
                detail.text = context.getString(R.string.update_downloading, state.release.version)
                if (state.total > 0) {
                    bar.progress = state.done.toFloat() / state.total
                    percent.text = "${(100 * state.done / state.total).coerceIn(0, 100)}%"
                    amount.text = context.getString(R.string.update_amount, bytes(state.done), bytes(state.total))
                } else {
                    bar.progress = -1f
                    amount.text = bytes(state.done)
                }
                if (state.bytesPerSec > 0) amount.append(" · ${bytes(state.bytesPerSec)}/s")
            }
            is Updater.State.Installing -> {
                if (state.waitingForOk) {
                    detail.text = context.getString(R.string.update_confirm, state.release.version)
                    bar.progress = 1f
                    hint.text = context.getString(R.string.update_confirm_hint)
                } else {
                    detail.text = context.getString(R.string.update_installing, state.release.version)
                    bar.progress = -1f
                }
            }
            is Updater.State.Failed -> {
                title.text = context.getString(R.string.update_failed_title)
                detail.text = state.message
                bar.visibility = GONE
                row.visibility = GONE
                hint.text = context.getString(R.string.update_failed_hint)
            }
            else -> Unit
        }
        appear()
    }

    private fun appear() {
        animate().cancel()
        if (visibility != VISIBLE) {
            alpha = 0f
            visibility = VISIBLE
        }
        animate().alpha(1f).setDuration(FADE_MS).start()
    }

    private fun disappear() {
        if (visibility != VISIBLE) return
        animate().cancel()
        animate().alpha(0f).setDuration(FADE_MS).withEndAction { visibility = GONE }.start()
    }

    /** `42.6 MB`, in decimal units, as the pages show sizes (src/shared/format.js). */
    private fun bytes(n: Long): String {
        var value = n.toDouble()
        var unit = 0
        while (value >= 1000 && unit < UNITS.size - 1) {
            value /= 1000
            unit += 1
        }
        return if (unit == 0 || value >= 100) "${value.roundToLong()} ${UNITS[unit]}" else String.format(Locale.US, "%.1f %s", value, UNITS[unit])
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        // A red glow behind the icon, fading into the black.
        glow.shader = RadialGradient(w / 2f, h * 0.34f, max(w, h) * 0.5f, intArrayOf(0x38E50914, 0x10E50914, 0x00E50914), floatArrayOf(0f, 0.45f, 1f), Shader.TileMode.CLAMP)
    }

    override fun onDraw(canvas: Canvas) {
        canvas.drawColor(BACKGROUND)
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), glow)
    }

    /** A rounded red bar on a grey track, with a light running along it. */
    private class UpdateBar(context: Context) : View(context) {
        private companion object {
            const val DEEP = 0xFFB20710.toInt()
            const val BRIGHT = 0xFFFF3D47.toInt()
            const val GLOW = 0x99E50914.toInt()
            const val SWEEP_MS = 1_400L
            const val SHINE_MS = 1_800L
        }

        private val dp = resources.displayMetrics.density
        private val barHeight = 8 * dp
        private val shineWidth = 120 * dp
        private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = SURFACE }
        private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
        private val shine = Paint(Paint.ANTI_ALIAS_FLAG)
        private val shineAt = Matrix()
        private val rect = RectF()
        private var shown = 0f

        /** 0 to 1; below 0 while there is no telling how far along it is. */
        var progress = -1f
            set(value) {
                // Fills forward smoothly; jumps when it starts over, or after a sweep.
                if (value >= 0 && (field < 0 || value < shown)) shown = value
                field = value
                invalidate()
            }

        override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
            fill.shader = LinearGradient(0f, 0f, w.toFloat(), 0f, intArrayOf(DEEP, ACCENT, BRIGHT), floatArrayOf(0f, 0.45f, 1f), Shader.TileMode.CLAMP)
            // Drawn by the GPU from Android 9; older TVs show the bar without the glow.
            fill.setShadowLayer(10 * dp, 0f, 0f, GLOW)
            shine.shader = LinearGradient(0f, 0f, shineWidth, 0f, intArrayOf(0x00FFFFFF, 0x59FFFFFF, 0x00FFFFFF), null, Shader.TileMode.CLAMP)
        }

        override fun onDraw(canvas: Canvas) {
            val w = width.toFloat()
            val top = (height - barHeight) / 2
            val radius = barHeight / 2
            rect.set(0f, top, w, top + barHeight)
            canvas.drawRoundRect(rect, radius, radius, track)

            val now = SystemClock.uptimeMillis()
            var from = 0f
            val to: Float
            if (progress < 0) {
                // A run of red sweeping along the track.
                val length = w * 0.28f
                val p = (now % SWEEP_MS) / SWEEP_MS.toFloat()
                val x = -length + (w + length) * (p * p * (3 - 2 * p))
                from = max(0f, x)
                to = min(w, x + length)
            } else {
                shown += (progress - shown) * 0.18f
                if (abs(progress - shown) < 0.001f) shown = progress
                to = w * shown
            }
            if (to - from >= 1f) {
                rect.set(from, top, min(w, max(to, from + barHeight)), top + barHeight)
                canvas.drawRoundRect(rect, radius, radius, fill)
                val p = (now % SHINE_MS) / SHINE_MS.toFloat()
                shineAt.setTranslate(rect.left - shineWidth + p * (rect.width() + shineWidth), 0f)
                shine.shader.setLocalMatrix(shineAt)
                canvas.drawRoundRect(rect, radius, radius, shine)
            }
            if (isShown) postInvalidateOnAnimation()
        }
    }
}
