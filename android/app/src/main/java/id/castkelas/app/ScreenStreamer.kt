package id.castkelas.app

import android.content.Context
import android.content.Intent
import android.graphics.Point
import android.hardware.display.DisplayManager
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.util.Log
import android.view.Display
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpParameters
import org.webrtc.RtpSender
import org.webrtc.RtpTransceiver
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.roundToInt

/** Resolution/bitrate target requested by the laptop (see quality.ts). */
data class Quality(val maxSize: Int, val bitrate: Int, val fps: Int)

/**
 * Owns screen capture + audio and one WebRTC peer connection to the laptop.
 * Capture survives reconnects; only the peer connection is recreated.
 * All public methods must be called from the service's worker thread.
 */
class ScreenStreamer(
    private val context: Context,
    projectionData: Intent,
    private val iceServers: List<PeerConnection.IceServer>,
    private val listener: Listener,
) {
    interface Listener {
        fun onOffer(sdp: String)
        fun onIceCandidate(candidate: IceCandidate)
        fun onConnectionState(state: PeerConnection.PeerConnectionState)
        fun onControlOpen()
        fun onQualityRequest(quality: Quality)
        fun onProjectionStopped()
    }

    private val egl = EglBase.create()
    private val audioCapture = PlaybackAudioCapture()
    private val adm: JavaAudioDeviceModule
    private val factory: PeerConnectionFactory
    private val capturer: ScreenCapturerAndroid
    private val surfaceHelper: SurfaceTextureHelper
    private val videoSource: VideoSource
    private val videoTrack: VideoTrack
    private val audioSource: AudioSource
    private val audioTrack: AudioTrack

    private var pc: PeerConnection? = null
    private var videoSender: RtpSender? = null
    private var control: DataChannel? = null
    private val pendingIce = mutableListOf<IceCandidate>()
    private var quality = Quality(maxSize = 1600, bitrate = 4_000_000, fps = 30)

    val audioAvailable: Boolean
        get() = audioCapture.isAvailable

    init {
        ensureInitialized(context)

        adm = JavaAudioDeviceModule.builder(context)
            .setAudioSource(MediaRecorder.AudioSource.MIC)
            .setUseHardwareAcousticEchoCanceler(false)
            .setUseHardwareNoiseSuppressor(false)
            .setUseStereoInput(true)
            .setInputSampleRate(48_000)
            .setAudioBufferCallback { buffer: ByteBuffer, audioFormat: Int, channelCount: Int, sampleRate: Int, bytesRead: Int, captureTimeNs: Long ->
                audioCapture.fill(buffer, audioFormat, channelCount, sampleRate, bytesRead)
                captureTimeNs
            }
            .createAudioDeviceModule()

        factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(adm)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()

        capturer = ScreenCapturerAndroid(projectionData, object : MediaProjection.Callback() {
            override fun onStop() = listener.onProjectionStopped()
        })
        surfaceHelper = SurfaceTextureHelper.create("CastKelasCapture", egl.eglBaseContext)
        videoSource = factory.createVideoSource(true)
        capturer.initialize(surfaceHelper, context, videoSource.capturerObserver)
        val (width, height) = captureSize(quality.maxSize)
        capturer.startCapture(width, height, quality.fps)
        capturer.mediaProjection?.let(audioCapture::attach)
        videoTrack = factory.createVideoTrack("screen", videoSource)

        // Music and video sound, not a voice call: turn off voice processing.
        val constraints = MediaConstraints().apply {
            listOf(
                "googEchoCancellation",
                "googAutoGainControl",
                "googNoiseSuppression",
                "googHighpassFilter",
                "googTypingNoiseDetection",
            ).forEach { mandatory.add(MediaConstraints.KeyValuePair(it, "false")) }
        }
        audioSource = factory.createAudioSource(constraints)
        audioTrack = factory.createAudioTrack("audio", audioSource)
    }

    /** Starts a fresh negotiation (first connect or after the link dropped). */
    fun createOffer() {
        closePeer()
        val config = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        val peer = factory.createPeerConnection(config, PeerObserver()) ?: error("Gagal membuat koneksi WebRTC")
        pc = peer

        val sendOnly = RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, listOf("cast"))
        val videoTransceiver = peer.addTransceiver(videoTrack, sendOnly)
        preferHardwareCodec(videoTransceiver)
        videoSender = videoTransceiver.sender
        peer.addTransceiver(audioTrack, sendOnly)

        control = peer.createDataChannel("control", DataChannel.Init()).also { channel ->
            channel.registerObserver(object : DataChannel.Observer {
                override fun onBufferedAmountChange(previousAmount: Long) {}
                override fun onStateChange() {
                    if (channel.state() == DataChannel.State.OPEN) listener.onControlOpen()
                }
                override fun onMessage(buffer: DataChannel.Buffer) {
                    val bytes = ByteArray(buffer.data.remaining()).also { buffer.data.get(it) }
                    val json = runCatching { JSONObject(String(bytes)) }.getOrNull() ?: return
                    if (json.optString("type") == "quality") {
                        listener.onQualityRequest(
                            Quality(json.optInt("maxSize", 1600), json.optInt("bitrate", 4_000_000), json.optInt("fps", 30)),
                        )
                    }
                }
            })
        }

        peer.createOffer(object : SimpleSdpObserver() {
            override fun onCreateSuccess(description: SessionDescription) {
                peer.setLocalDescription(object : SimpleSdpObserver() {
                    override fun onSetSuccess() {
                        listener.onOffer(description.description)
                        applyEncoding()
                    }
                }, description)
            }
        }, MediaConstraints())
    }

    fun setAnswer(sdp: String) {
        val peer = pc ?: return
        peer.setRemoteDescription(object : SimpleSdpObserver() {
            override fun onSetSuccess() {
                synchronized(pendingIce) {
                    pendingIce.forEach { peer.addIceCandidate(it) }
                    pendingIce.clear()
                }
            }
        }, SessionDescription(SessionDescription.Type.ANSWER, sdp))
    }

    fun addRemoteIce(candidate: IceCandidate) {
        val peer = pc ?: return
        synchronized(pendingIce) {
            if (peer.remoteDescription == null) pendingIce += candidate else peer.addIceCandidate(candidate)
        }
    }

    fun sendControl(json: JSONObject) {
        val channel = control ?: return
        if (channel.state() != DataChannel.State.OPEN) return
        channel.send(DataChannel.Buffer(ByteBuffer.wrap(json.toString().toByteArray()), false))
    }

    fun setQuality(next: Quality) {
        quality = next
        applyCaptureSize()
        applyEncoding()
    }

    /** Call when the tablet rotates so the stream keeps the right aspect ratio. */
    fun applyCaptureSize() {
        val (width, height) = captureSize(quality.maxSize)
        capturer.changeCaptureFormat(width, height, quality.fps)
    }

    fun dispose() {
        closePeer()
        runCatching { capturer.stopCapture() }
        audioCapture.stop()
        capturer.dispose()
        videoTrack.dispose()
        videoSource.dispose()
        audioTrack.dispose()
        audioSource.dispose()
        surfaceHelper.dispose()
        factory.dispose()
        adm.release()
        egl.release()
    }

    private fun closePeer() {
        control?.unregisterObserver()
        control?.close()
        control?.dispose()
        control = null
        videoSender = null
        pc?.dispose()
        pc = null
        synchronized(pendingIce) { pendingIce.clear() }
    }

    private fun applyEncoding() {
        val sender = videoSender ?: return
        val params = sender.parameters
        // Teaching content: keep text sharp, drop frames first when WiFi struggles.
        params.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION
        params.encodings.forEach {
            it.maxBitrateBps = quality.bitrate
            it.maxFramerate = quality.fps
        }
        sender.parameters = params
    }

    /** Hardware H.264 is far lighter on tablets than software VP8. */
    private fun preferHardwareCodec(transceiver: RtpTransceiver) {
        runCatching {
            val codecs = factory.getRtpSenderCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO).codecs
            transceiver.setCodecPreferences(codecs.sortedBy { if (it.name.equals("H264", ignoreCase = true)) 0 else 1 })
        }.onFailure { Log.w(TAG, "codec preference not applied", it) }
    }

    /** Real display size scaled to [maxSize] (0 = native), aligned to 16 for hardware encoders. */
    private fun captureSize(maxSize: Int): Pair<Int, Int> {
        val display = context.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
        val real = Point()
        @Suppress("DEPRECATION")
        display.getRealSize(real)
        val longest = max(real.x, real.y)
        val scale = if (maxSize in 1 until longest) maxSize.toDouble() / longest else 1.0
        fun align(v: Int) = max(16, ((v * scale) / 16).roundToInt() * 16)
        return align(real.x) to align(real.y)
    }

    private inner class PeerObserver : PeerConnection.Observer {
        override fun onIceCandidate(candidate: IceCandidate) = listener.onIceCandidate(candidate)
        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
            listener.onConnectionState(newState)
        }
        override fun onSignalingChange(state: PeerConnection.SignalingState) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {}
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
        override fun onAddStream(stream: org.webrtc.MediaStream) {}
        override fun onRemoveStream(stream: org.webrtc.MediaStream) {}
        override fun onDataChannel(channel: DataChannel) {}
        override fun onRenegotiationNeeded() {}
    }

    private open class SimpleSdpObserver : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String) {
            Log.e(TAG, "SDP create failed: $error")
        }
        override fun onSetFailure(error: String) {
            Log.e(TAG, "SDP set failed: $error")
        }
    }

    companion object {
        private const val TAG = "CastKelasStreamer"
        private var initialized = false

        @Synchronized
        private fun ensureInitialized(context: Context) {
            if (initialized) return
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                    .createInitializationOptions(),
            )
            initialized = true
        }
    }
}
