package id.castkelas.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import id.castkelas.app.CastState.Phase
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.webrtc.IceCandidate
import org.webrtc.PeerConnection
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Foreground service that keeps the cast alive while the teacher uses other
 * apps. Signaling and WebRTC calls all run on one worker thread.
 */
class CastService : Service() {
    private val worker = Executors.newSingleThreadScheduledExecutor()
    private val http = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private val sessionId = UUID.randomUUID().toString()
    private val deviceName = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}"

    private var signaling: Signaling? = null
    private var streamer: ScreenStreamer? = null
    private var helloTask: ScheduledFuture<*>? = null
    private var recoveryTask: ScheduledFuture<*>? = null
    private var welcomed = false
    private var started = false
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        // Must be in the foreground with type mediaProjection before capture starts.
        val notification = buildNotification(getString(R.string.notif_preparing))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        val origin = intent?.getStringExtra(EXTRA_ORIGIN)
        val channel = intent?.getStringExtra(EXTRA_CHANNEL)
        val data = intent?.let { IntentCompat.getParcelableExtra(it, EXTRA_DATA, Intent::class.java) }
        if (started || origin == null || channel == null || data == null) {
            if (!started) stopSelf()
            return START_NOT_STICKY
        }
        started = true
        acquireWakeLock()
        worker.execute { begin(origin, channel, data) }
        return START_NOT_STICKY
    }

    private fun begin(origin: String, channel: String, projectionData: Intent) {
        CastState.update(Phase.PREPARING, getString(R.string.status_loading_config))
        val config = try {
            RemoteConfig.load(http, origin)
        } catch (e: Exception) {
            Log.e(TAG, "config failed", e)
            fail(getString(R.string.error_config, e.message ?: ""))
            return
        }

        try {
            streamer = ScreenStreamer(applicationContext, projectionData, config.iceServers, streamerListener)
        } catch (e: Exception) {
            Log.e(TAG, "capture failed", e)
            fail(getString(R.string.error_capture, e.message ?: ""))
            return
        }

        signaling = Signaling(
            http,
            config,
            channel,
            onMessage = { msg -> post { onSignal(msg) } },
            onJoined = { post { if (!welcomed) sendHello() } },
        ).also { it.connect() }

        CastState.update(Phase.WAITING_LAPTOP, getString(R.string.status_finding_laptop))
        startHelloLoop()
    }

    /** Hello is repeated because broadcasts aren't stored: the laptop may join a moment later. */
    private fun startHelloLoop() {
        helloTask?.cancel(false)
        helloTask = worker.scheduleWithFixedDelay({ if (!welcomed) sendHello() }, 0, 2, TimeUnit.SECONDS)
    }

    private fun sendHello() {
        signaling?.send(JSONObject().put("from", "tablet").put("type", "hello").put("id", sessionId).put("device", deviceName))
    }

    private fun onSignal(msg: JSONObject) {
        if (msg.optString("from") != "laptop" || msg.optString("to") != sessionId) return
        val streamer = streamer ?: return
        when (msg.optString("type")) {
            "welcome" -> if (!welcomed) {
                welcomed = true
                CastState.update(Phase.CONNECTING, getString(R.string.status_connecting))
                streamer.createOffer()
            }
            "busy" -> fail(getString(R.string.error_busy))
            "answer" -> streamer.setAnswer(msg.getString("sdp"))
            "ice" -> streamer.addRemoteIce(
                IceCandidate(
                    msg.optString("sdpMid").takeIf { it.isNotEmpty() && it != "null" } ?: "0",
                    msg.optInt("sdpMLineIndex", 0),
                    msg.getString("candidate"),
                ),
            )
            "bye" -> {
                CastState.update(Phase.IDLE, getString(R.string.status_laptop_stopped))
                stopSelf()
            }
        }
    }

    private val streamerListener = object : ScreenStreamer.Listener {
        override fun onOffer(sdp: String) {
            post {
                signaling?.send(JSONObject().put("from", "tablet").put("type", "offer").put("id", sessionId).put("sdp", sdp))
            }
        }

        override fun onIceCandidate(candidate: IceCandidate) {
            post {
                signaling?.send(
                    JSONObject()
                        .put("from", "tablet")
                        .put("type", "ice")
                        .put("id", sessionId)
                        .put("candidate", candidate.sdp)
                        .put("sdpMid", candidate.sdpMid)
                        .put("sdpMLineIndex", candidate.sdpMLineIndex),
                )
            }
        }

        override fun onConnectionState(state: PeerConnection.PeerConnectionState) {
            post { handleConnectionState(state) }
        }

        override fun onControlOpen() {
            post { sendInfo() }
            // Audio capture starts with the first outgoing audio buffer; report again once it's settled.
            post(delaySeconds = 3) { sendInfo() }
        }

        override fun onQualityRequest(quality: Quality) {
            post { streamer?.setQuality(quality) }
        }

        override fun onProjectionStopped() {
            CastState.update(Phase.IDLE, getString(R.string.status_stopped))
            stopSelf()
        }
    }

    private fun sendInfo() {
        val streamer = streamer ?: return
        streamer.sendControl(
            JSONObject()
                .put("type", "info")
                .put("device", deviceName)
                .put("audio", if (streamer.audioAvailable) "on" else "unavailable"),
        )
    }

    private fun handleConnectionState(state: PeerConnection.PeerConnectionState) {
        when (state) {
            PeerConnection.PeerConnectionState.CONNECTED -> {
                recoveryTask?.cancel(false)
                CastState.update(Phase.STREAMING, getString(R.string.status_streaming))
                updateNotification(getString(R.string.status_streaming))
            }
            PeerConnection.PeerConnectionState.DISCONNECTED -> {
                CastState.update(Phase.RECONNECTING, getString(R.string.status_reconnecting))
                updateNotification(getString(R.string.status_reconnecting))
                // Brief WiFi hiccups often recover on their own; renegotiate if not.
                recoveryTask?.cancel(false)
                recoveryTask = worker.schedule(Runnable { restartPeer() }, 5, TimeUnit.SECONDS)
            }
            PeerConnection.PeerConnectionState.FAILED -> restartPeer()
            else -> Unit
        }
    }

    private fun restartPeer() {
        if (worker.isShutdown) return
        CastState.update(Phase.RECONNECTING, getString(R.string.status_reconnecting))
        welcomed = false
        startHelloLoop()
    }

    /** Callbacks can still arrive from WebRTC/OkHttp threads after shutdown; drop them. */
    private fun post(delaySeconds: Long = 0, block: () -> Unit) {
        if (worker.isShutdown) return
        runCatching {
            if (delaySeconds > 0) worker.schedule(Runnable(block), delaySeconds, TimeUnit.SECONDS) else worker.execute(Runnable(block))
        }
    }

    private fun fail(message: String) {
        CastState.update(Phase.ERROR, message)
        stopSelf()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        post { streamer?.applyCaptureSize() }
    }

    override fun onDestroy() {
        worker.execute {
            helloTask?.cancel(false)
            recoveryTask?.cancel(false)
            signaling?.send(JSONObject().put("from", "tablet").put("type", "bye").put("id", sessionId))
            signaling?.close()
            signaling = null
            runCatching { streamer?.dispose() }.onFailure { Log.w(TAG, "dispose failed", it) }
            streamer = null
        }
        worker.shutdown()
        wakeLock?.takeIf { it.isHeld }?.release()
        val current = CastState.state
        if (current.isActive) CastState.update(Phase.IDLE)
        super.onDestroy()
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(PowerManager::class.java)
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CastKelas:cast").apply {
            setReferenceCounted(false)
            acquire(4 * 60 * 60 * 1000L) // a long lesson, but never forever
        }
    }

    private fun buildNotification(text: String): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW),
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, CastService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, getString(R.string.action_stop), stop).build())
            .build()
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(text))
    }

    companion object {
        private const val TAG = "CastKelasService"
        private const val CHANNEL_ID = "cast"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_STOP = "id.castkelas.app.STOP"
        private const val EXTRA_ORIGIN = "origin"
        private const val EXTRA_CHANNEL = "channel"
        private const val EXTRA_DATA = "projectionData"

        fun start(context: Context, link: JoinLink, projectionData: Intent) {
            val intent = Intent(context, CastService::class.java)
                .putExtra(EXTRA_ORIGIN, link.origin)
                .putExtra(EXTRA_CHANNEL, link.channel)
                .putExtra(EXTRA_DATA, projectionData)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CastService::class.java))
        }
    }
}
