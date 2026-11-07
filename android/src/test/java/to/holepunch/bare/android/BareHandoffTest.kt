package to.holepunch.bare.android

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class BareHandoffTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val nonce = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd"

    private fun json(origin: String, port: Int? = null, bootstrap: String = nonce): String =
        JSONObject().put("origin", origin).put("bootstrap", bootstrap).apply {
            if (port != null) put("port", port)
        }.toString()

    private fun rejects(text: String) {
        try {
            BareHandoff.parse(text)
            fail("accepted $text")
        } catch (e: IllegalArgumentException) {
            // The message must never echo the file (it carries the nonce).
            assertFalse(e.message!!.contains(nonce))
        }
    }

    @Test
    fun `parses the worklet handoff and derives every URL from the origin`() {
        val h = BareHandoff.parse(json("http://127.0.0.1:49152", 49152))
        assertEquals("http://127.0.0.1:49152", h.origin)
        assertEquals(49152, h.port)
        assertEquals(nonce, h.bootstrap)
        assertEquals("http://127.0.0.1:49152/index.html", h.indexUrl)
        assertTrue(h.bootstrapScript.startsWith("window.__ekrooh={bootstrap:\"$nonce\"}"))
        assertFalse(h.toString().contains(nonce))
        assertEquals("http://localhost:8080", BareHandoff.parse(json("http://localhost:8080")).origin)
    }

    @Test
    fun `rejects a non-loopback, non-http or non-bare origin`() {
        rejects(json("http://evil.example:49152"))
        rejects(json("https://127.0.0.1:49152"))
        rejects(json("http://127.0.0.1"))
        rejects(json("http://127.0.0.1:49152/app"))
        rejects(json("http://x@127.0.0.1:49152"))
        rejects(json("http://127.0.0.1:49152?q=1"))
        rejects(json("not a uri at all"))
    }

    @Test
    fun `rejects a port that disagrees with the origin`() {
        rejects(json("http://127.0.0.1:49152", 8080))
    }

    @Test
    fun `rejects a missing or malformed nonce and never echoes the input`() {
        rejects(json("http://127.0.0.1:49152", bootstrap = ""))
        rejects(json("http://127.0.0.1:49152", bootstrap = "\"};alert(1);//aaaaaaaaaaaa"))
        rejects("{\"origin\":\"http://127.0.0.1:1\",\"bootstrap\":\"$nonce")
    }

    @Test
    fun `consume deletes a valid file and leaves a partial one for the next poll`() {
        val file = File(tmp.root, "handoff.json")
        assertNull(BareHandoff.consume(file))

        val full = json("http://127.0.0.1:49152", 49152)
        file.writeText(full.substring(0, full.length / 2))
        assertNull(BareHandoff.consume(file))
        assertTrue("a partial file stays for the next poll", file.exists())

        file.writeText(full)
        assertEquals("http://127.0.0.1:49152", BareHandoff.consume(file)?.origin)
        assertFalse("a consumed handoff is deleted", file.exists())
    }
}
