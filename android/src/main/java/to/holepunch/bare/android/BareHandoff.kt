package to.holepunch.bare.android

import org.json.JSONObject
import java.io.File
import java.net.URI

/**
 * The worklet's `handoff.json` (`{ origin, port, bootstrap }`), checked.
 *
 * [origin] is the only source for both the page URL and the WebView's
 * allowed origin (navigation confinement and the bootstrap script rule), so
 * they can never disagree. It must be a plain `http://<loopback>:<port>`
 * origin: no path, query, fragment or userinfo, on `127.0.0.1`, `localhost`
 * or `[::1]`. A `port` field, when present, must match it.
 *
 * Errors never include the file's text: it carries the bootstrap nonce.
 */
class BareHandoff private constructor(
    /** The loopback origin, e.g. `http://127.0.0.1:49152` (no trailing slash). */
    val origin: String,
    /** The port of [origin]. */
    val port: Int,
    /** The single-use bootstrap nonce the page exchanges at `POST /login`. */
    val bootstrap: String,
) {
    /** The page the host loads: `<origin>/index.html`. */
    val indexUrl: String get() = "$origin/index.html"

    /** The document-start script that hands [bootstrap] to the page. */
    val bootstrapScript: String
        get() = "window.__ekrooh={bootstrap:${JSONObject.quote(bootstrap)}};window.BareShell=true;"

    override fun toString(): String = "BareHandoff(origin=$origin)"

    companion object {
        private val LOOPBACK_HOSTS = setOf("127.0.0.1", "localhost", "[::1]")
        private val NONCE = Regex("^[A-Za-z0-9_-]{16,256}$")

        /** Parses and checks handoff JSON. Throws [IllegalArgumentException]
         * (with a message that never echoes [json]) when it is invalid. */
        @JvmStatic
        fun parse(json: String): BareHandoff {
            val obj = try {
                JSONObject(json)
            } catch (e: Exception) {
                throw IllegalArgumentException("handoff is not a JSON object")
            }
            val rawOrigin = obj.optString("origin", "")
            val bootstrap = obj.optString("bootstrap", "")
            val uri = try {
                URI(rawOrigin)
            } catch (e: Exception) {
                throw IllegalArgumentException("handoff origin is not a URI")
            }
            val host = uri.host?.lowercase()
            require(uri.scheme.equals("http", ignoreCase = true)) { "handoff origin must be http" }
            require(host != null && host in LOOPBACK_HOSTS) { "handoff origin must be loopback" }
            require(uri.port in 1..65535) { "handoff origin must carry a port" }
            require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null) {
                "handoff origin must be a bare origin"
            }
            require(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") { "handoff origin must have no path" }
            if (obj.has("port")) {
                require(obj.optInt("port", -1) == uri.port) { "handoff port does not match its origin" }
            }
            require(NONCE.matches(bootstrap)) { "handoff bootstrap is missing or malformed" }
            return BareHandoff("http://$host:${uri.port}", uri.port, bootstrap)
        }

        /** Reads [file], parses it and deletes it. Returns null while the file
         * is missing or not yet valid (the worklet may still be writing it),
         * so callers poll. The file is deleted only once it parsed. */
        @JvmStatic
        fun consume(file: File): BareHandoff? {
            val text = try {
                if (!file.isFile) return null
                file.readText()
            } catch (e: Exception) {
                return null
            }
            val handoff = try {
                parse(text)
            } catch (e: IllegalArgumentException) {
                return null
            }
            file.delete()
            return handoff
        }
    }
}
