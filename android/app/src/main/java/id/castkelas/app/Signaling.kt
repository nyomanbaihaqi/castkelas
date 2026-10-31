package id.castkelas.app

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Minimal Supabase Realtime (Phoenix channels, protocol vsn 1.0.0) client that
 * only does broadcast — the same channel the laptop joins with supabase-js.
 * See src/wireless/protocol.ts for the message shapes.
 */
class Signaling(
    private val http: OkHttpClient,
    private val config: RemoteConfig,
    channelId: String,
    private val onMessage: (JSONObject) -> Unit,
    private val onJoined: () -> Unit,
) {
    private val topic = "realtime:castkelas:$channelId"
    private val ref = AtomicInteger(0)
    private val timer = Executors.newSingleThreadScheduledExecutor()
    private var heartbeat: ScheduledFuture<*>? = null
    private var socket: WebSocket? = null
    private var joinRef: String? = null

    @Volatile
    private var closed = false

    @Synchronized
    fun connect() {
        if (closed) return
        val base = config.supabaseUrl.trimEnd('/')
            .replaceFirst("https://", "wss://")
            .replaceFirst("http://", "ws://")
        val url = "$base/realtime/v1/websocket?apikey=${config.supabaseKey}&vsn=1.0.0"
        socket = http.newWebSocket(Request.Builder().url(url).build(), listener)
    }

    fun send(payload: JSONObject) {
        val message = JSONObject()
            .put("topic", topic)
            .put("event", "broadcast")
            .put("payload", JSONObject().put("type", "broadcast").put("event", "signal").put("payload", payload))
            .put("ref", nextRef())
            .put("join_ref", joinRef)
        socket?.send(message.toString())
    }

    fun close() {
        closed = true
        heartbeat?.cancel(false)
        socket?.close(1000, null)
        timer.shutdownNow()
    }

    private fun nextRef() = ref.incrementAndGet().toString()

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            val jref = nextRef()
            joinRef = jref
            val joinConfig = JSONObject()
                .put("broadcast", JSONObject().put("ack", false).put("self", false))
                .put("presence", JSONObject().put("key", ""))
                .put("postgres_changes", JSONArray())
                .put("private", false)
            val payload = JSONObject().put("config", joinConfig)
            // Legacy anon keys are JWTs and double as the access token; publishable keys are not.
            if (config.supabaseKey.count { it == '.' } == 2) payload.put("access_token", config.supabaseKey)
            webSocket.send(
                JSONObject()
                    .put("topic", topic)
                    .put("event", "phx_join")
                    .put("payload", payload)
                    .put("ref", jref)
                    .put("join_ref", jref)
                    .toString(),
            )
            heartbeat?.cancel(false)
            heartbeat = timer.scheduleWithFixedDelay({
                webSocket.send(
                    JSONObject()
                        .put("topic", "phoenix")
                        .put("event", "heartbeat")
                        .put("payload", JSONObject())
                        .put("ref", nextRef())
                        .toString(),
                )
            }, 25, 25, TimeUnit.SECONDS)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val json = runCatching { JSONObject(text) }.getOrNull() ?: return
            if (json.optString("topic") != topic) return
            when (json.optString("event")) {
                "phx_reply" -> {
                    val status = json.optJSONObject("payload")?.optString("status")
                    if (json.optString("ref") == joinRef) {
                        if (status == "ok") onJoined() else Log.w(TAG, "join rejected: $text")
                    }
                }
                "broadcast" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    if (payload.optString("event") == "signal") {
                        payload.optJSONObject("payload")?.let(onMessage)
                    }
                }
                "phx_error", "phx_close" -> {
                    webSocket.cancel()
                    reconnectLater(webSocket)
                }
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "socket failure", t)
            reconnectLater(webSocket)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            reconnectLater(webSocket)
        }
    }

    /** Only the current socket may trigger a reconnect, so failures can't fan out. */
    @Synchronized
    private fun reconnectLater(failed: WebSocket) {
        if (closed || failed !== socket) return
        socket = null
        heartbeat?.cancel(false)
        runCatching { timer.schedule(Runnable { connect() }, 2, TimeUnit.SECONDS) }
    }

    companion object {
        private const val TAG = "CastKelasSignaling"
    }
}
