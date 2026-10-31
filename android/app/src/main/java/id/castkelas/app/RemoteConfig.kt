package id.castkelas.app

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.PeerConnection

/** Signaling + ICE config served by the web app at `<origin>/api/config`. */
data class RemoteConfig(
    val supabaseUrl: String,
    val supabaseKey: String,
    val iceServers: List<PeerConnection.IceServer>,
) {
    companion object {
        /** Blocking: call off the main thread. */
        fun load(http: OkHttpClient, origin: String): RemoteConfig {
            val request = Request.Builder().url("$origin/api/config").build()
            val body = http.newCall(request).execute().use { res ->
                check(res.isSuccessful) { "HTTP ${res.code}" }
                res.body?.string() ?: error("Respons kosong")
            }
            val json = JSONObject(body)
            val url = json.optString("supabaseUrl").takeIf { it.isNotBlank() && it != "null" }
            val key = json.optString("supabaseKey").takeIf { it.isNotBlank() && it != "null" }
            check(url != null && key != null) { "Server belum dikonfigurasi (Supabase)" }
            return RemoteConfig(url, key, parseIceServers(json.optJSONArray("iceServers")))
        }

        private fun parseIceServers(array: JSONArray?): List<PeerConnection.IceServer> {
            val servers = mutableListOf<PeerConnection.IceServer>()
            if (array != null) {
                for (i in 0 until array.length()) {
                    val entry = array.getJSONObject(i)
                    val urls = when (val raw = entry.get("urls")) {
                        is JSONArray -> List(raw.length()) { raw.getString(it) }
                        else -> listOf(raw.toString())
                    }
                    val builder = PeerConnection.IceServer.builder(urls)
                    entry.optString("username").takeIf { it.isNotEmpty() }?.let { builder.setUsername(it) }
                    entry.optString("credential").takeIf { it.isNotEmpty() }?.let { builder.setPassword(it) }
                    servers += builder.createIceServer()
                }
            }
            if (servers.isEmpty()) {
                servers += PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()
            }
            return servers
        }
    }
}
