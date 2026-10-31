package id.castkelas.app

import android.net.Uri

/**
 * Where to cast to. Parsed from the laptop's QR code, which is either
 *   https://<web-origin>/join?c=<channel>       (scanned in-app or with a camera)
 *   castkelas://join?o=<web-origin>&c=<channel> (handed over by the web join page)
 */
data class JoinLink(val origin: String, val channel: String) {
    companion object {
        private val CHANNEL = Regex("^[a-z0-9]{8,64}$")

        fun parse(text: String): JoinLink? {
            val uri = runCatching { Uri.parse(text.trim()) }.getOrNull() ?: return null
            val (origin, channel) = when (uri.scheme?.lowercase()) {
                "castkelas" -> uri.getQueryParameter("o") to uri.getQueryParameter("c")
                "https", "http" -> {
                    if (uri.path?.trimEnd('/') != "/join") return null
                    "${uri.scheme}://${uri.encodedAuthority}" to uri.getQueryParameter("c")
                }
                else -> return null
            }
            if (origin.isNullOrBlank() || channel == null || !CHANNEL.matches(channel)) return null
            if (!origin.startsWith("https://") && !origin.startsWith("http://")) return null
            return JoinLink(origin.trimEnd('/'), channel)
        }
    }
}
