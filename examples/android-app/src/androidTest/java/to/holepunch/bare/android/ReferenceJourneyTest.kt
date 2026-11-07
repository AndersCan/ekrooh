package to.holepunch.bare.android

import android.content.Context
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import to.holepunch.bare.android.app.R
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * End-to-end journey through the real reference shell on the emulator:
 * MainActivity boots the worklet, the page logs in with the bootstrap nonce
 * (proved by a gated `GET /logs` answering 200 on the session cookie), the
 * health ping round-trips, and the handoff file is gone. It also pins the
 * WebView hardening (file/content access off, confinement origin) and that a
 * reload gets no bootstrap nonce but still reconnects on the session cookie.
 */
@RunWith(AndroidJUnit4::class)
class ReferenceJourneyTest {
    private fun eval(scenario: ActivityScenario<MainActivity>, script: String): String? {
        val latch = CountDownLatch(1)
        var result: String? = null
        scenario.onActivity { activity ->
            activity.findViewById<WebView>(R.id.webview).evaluateJavascript(script) {
                result = it
                latch.countDown()
            }
        }
        if (!latch.await(10, TimeUnit.SECONDS)) return null
        // evaluateJavascript returns the JSON encoding of the value.
        return result?.let { if (it == "null") null else JSONArray("[$it]").opt(0)?.toString() }
    }

    private fun waitFor(
        scenario: ActivityScenario<MainActivity>,
        what: String,
        timeoutMs: Long,
        script: String,
        done: (String?) -> Boolean,
    ): String? {
        val deadline = System.currentTimeMillis() + timeoutMs
        var last: String? = null
        while (System.currentTimeMillis() < deadline) {
            last = eval(scenario, script)
            if (done(last)) return last
            Thread.sleep(500)
        }
        fail("Timed out waiting for $what; last value: ${last?.take(500)}")
        return null
    }

    private fun waitForText(scenario: ActivityScenario<MainActivity>, text: String, timeoutMs: Long) {
        waitFor(scenario, "\"$text\"", timeoutMs, "document.body ? document.body.innerText : ''") {
            it?.contains(text) == true
        }
    }

    @Test
    fun pageLogsInPingsAndLeavesNoHandoff() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            // Worklet boot + handoff + page load + login + discovery.
            waitForText(scenario, "Discovery v1:", 150_000)

            assertFalse(
                "handoff.json must be deleted once read",
                File(context.noBackupFilesDir, "bare/handoff.json").exists(),
            )

            scenario.onActivity { activity ->
                val settings = activity.findViewById<WebView>(R.id.webview).settings
                assertFalse("file access must be off", settings.allowFileAccess)
                assertFalse("content access must be off", settings.allowContentAccess)
            }

            // The session cookie from POST /login opens a gated route.
            eval(scenario, "fetch('/logs').then(r=>{window.__journeyLogs=r.status}).catch(()=>{window.__journeyLogs=-1});'started'")
            val status = waitFor(scenario, "GET /logs", 20_000, "String(window.__journeyLogs)") {
                it != null && it != "undefined"
            }
            assertEquals("gated GET /logs with the session cookie", "200", status)

            val clicked = eval(
                scenario,
                "(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Ping');" +
                    "if(!b)return 'missing';b.click();return 'clicked'})()",
            )
            assertEquals("Ping button", "clicked", clicked)
            waitForText(scenario, "PING ok:", 30_000)

            // A reload is a new document: the bootstrap script was removed after
            // the first load, so it gets no nonce, and it reconnects on the
            // session cookie.
            scenario.onActivity { it.findViewById<WebView>(R.id.webview).reload() }
            Thread.sleep(1_000)
            waitForText(scenario, "Discovery v1:", 60_000)
            assertEquals("typeof window.__ekrooh after reload", "undefined", eval(scenario, "typeof window.__ekrooh"))
        }
    }
}
