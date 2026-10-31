package id.castkelas.app

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.util.Log
import java.nio.ByteBuffer

/**
 * Captures what other apps are playing (YouTube, games, video lessons…) via
 * AudioPlaybackCapture and swaps it into WebRTC's microphone buffer, so the
 * laptop hears the tablet's sound instead of the room.
 *
 * Apps that opt out of capture (some streaming/call apps) stay silent.
 */
class PlaybackAudioCapture {
    private var projection: MediaProjection? = null
    private var record: AudioRecord? = null
    private var thread: Thread? = null
    private var format: Pair<Int, Int>? = null // sampleRate to channelCount

    // Ring buffer of captured PCM16, ~0.5s.
    private var ring = ByteArray(0)
    private var readPos = 0
    private var size = 0
    private val lock = Object()

    @Volatile
    private var running = false

    @Volatile
    var isAvailable = false
        private set

    fun attach(mediaProjection: MediaProjection) {
        projection = mediaProjection
    }

    /** Called on WebRTC's audio thread with every ~10ms mic buffer. */
    fun fill(buffer: ByteBuffer, audioFormat: Int, channelCount: Int, sampleRate: Int, bytesRead: Int) {
        if (audioFormat != AudioFormat.ENCODING_PCM_16BIT) return
        if (format != sampleRate to channelCount) start(sampleRate, channelCount)

        val out = ByteArray(bytesRead)
        synchronized(lock) {
            val n = minOf(bytesRead, size)
            for (i in 0 until n) {
                out[i] = ring[(readPos + i) % ring.size]
            }
            readPos = (readPos + n) % maxOf(ring.size, 1)
            size -= n
            // Underflow leaves the rest as silence rather than leaking mic audio.
        }
        val dst = buffer.duplicate()
        dst.clear()
        dst.put(out, 0, minOf(bytesRead, dst.remaining()))
    }

    @SuppressLint("MissingPermission")
    private fun start(sampleRate: Int, channelCount: Int) {
        stop()
        format = sampleRate to channelCount
        val projection = projection ?: return
        val channelMask = if (channelCount == 2) AudioFormat.CHANNEL_IN_STEREO else AudioFormat.CHANNEL_IN_MONO
        val minBuffer = AudioRecord.getMinBufferSize(sampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT)

        val created = runCatching {
            val capture = AudioPlaybackCaptureConfiguration.Builder(projection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build()
            AudioRecord.Builder()
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(sampleRate)
                        .setChannelMask(channelMask)
                        .build(),
                )
                .setBufferSizeInBytes(maxOf(minBuffer, 4096) * 2)
                .setAudioPlaybackCaptureConfig(capture)
                .build()
        }.onFailure { Log.w(TAG, "playback capture unavailable", it) }.getOrNull()

        if (created == null || created.state != AudioRecord.STATE_INITIALIZED) {
            created?.release()
            isAvailable = false
            return
        }

        synchronized(lock) {
            ring = ByteArray(sampleRate * channelCount * 2 / 4) // 250ms
            readPos = 0
            size = 0
        }
        record = created
        running = true
        isAvailable = true
        created.startRecording()
        thread = Thread({ readLoop(created, channelCount * 2) }, "CastKelasAudio").apply { start() }
    }

    private fun readLoop(source: AudioRecord, frameBytes: Int) {
        val chunk = ByteArray(frameBytes * 480) // 10ms at 48kHz
        while (running) {
            val read = source.read(chunk, 0, chunk.size)
            val n = read - read % frameBytes
            if (n <= 0) continue
            synchronized(lock) {
                val overflow = size + n - ring.size
                if (overflow > 0) {
                    // Full: drop the oldest whole frames so latency stays bounded.
                    val drop = overflow + (frameBytes - overflow % frameBytes) % frameBytes
                    readPos = (readPos + drop) % ring.size
                    size -= drop
                }
                for (i in 0 until n) {
                    ring[(readPos + size + i) % ring.size] = chunk[i]
                }
                size += n
            }
        }
    }

    fun stop() {
        running = false
        thread?.join(500)
        thread = null
        record?.let {
            runCatching { it.stop() }
            it.release()
        }
        record = null
        format = null
    }

    companion object {
        private const val TAG = "CastKelasAudio"
    }
}
