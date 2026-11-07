package to.holepunch.bare.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BareWebViewClientTest {
    private val origin = "http://127.0.0.1:49152"

    @Test
    fun `allows navigation within the loopback origin`() {
        assertTrue(BareWebViewClient.isAllowedNavigation("$origin/index.html", origin))
        assertTrue(BareWebViewClient.isAllowedNavigation("$origin/photos?x=1#y", origin))
    }

    @Test
    fun `refuses another host, port or scheme`() {
        assertFalse(BareWebViewClient.isAllowedNavigation("https://evil.example/", origin))
        assertFalse(BareWebViewClient.isAllowedNavigation("http://127.0.0.1:8080/", origin))
        assertFalse(BareWebViewClient.isAllowedNavigation("https://127.0.0.1:49152/", origin))
        assertFalse(BareWebViewClient.isAllowedNavigation("http://localhost:49152/", origin))
        assertFalse(BareWebViewClient.isAllowedNavigation("file:///data/data/x", origin))
        assertFalse(BareWebViewClient.isAllowedNavigation("javascript:alert(1)", origin))
    }

    @Test
    fun `refuses everything before the origin is known`() {
        assertFalse(BareWebViewClient.isAllowedNavigation("$origin/index.html", null))
    }

    @Test
    fun `only http and https leave for the system browser`() {
        assertTrue(BareWebViewClient.isExternalWebUrl("https://example.com/"))
        assertTrue(BareWebViewClient.isExternalWebUrl("http://example.com/"))
        assertFalse(BareWebViewClient.isExternalWebUrl("intent://scan/#Intent;end"))
        assertFalse(BareWebViewClient.isExternalWebUrl("file:///sdcard/x"))
        assertFalse(BareWebViewClient.isExternalWebUrl("content://x/y"))
    }

    @Test
    fun `refuses userinfo that names the loopback origin`() {
        assertFalse(BareWebViewClient.isAllowedNavigation("http://127.0.0.1:49152@evil.example/", origin))
        assertFalse(BareWebViewClient.isAllowedNavigation("http://x@127.0.0.1:49152/", origin))
    }

    @Test
    fun `opens the system browser only for a user gesture`() {
        assertTrue(BareWebViewClient.shouldOpenExternally("https://example.com/", true))
        assertFalse(BareWebViewClient.shouldOpenExternally("https://example.com/", false))
        assertFalse(BareWebViewClient.shouldOpenExternally("intent://x#Intent;end", true))
    }

    @Test
    fun `blocks main-frame network loads off the origin, including POST`() {
        // shouldInterceptRequest sees every main-frame load, so a form POST
        // that skipped shouldOverrideUrlLoading is refused here.
        assertTrue(BareWebViewClient.shouldBlockMainFrameRequest("https://evil.example/", origin, true))
        assertTrue(BareWebViewClient.shouldBlockMainFrameRequest("http://127.0.0.1:8080/", origin, true))
        assertTrue(BareWebViewClient.shouldBlockMainFrameRequest("http://bad_host/", origin, true))
        assertFalse(BareWebViewClient.shouldBlockMainFrameRequest("$origin/index.html", origin, true))
        // Subresources are the CSP's job; non-network URLs never hit the net.
        assertFalse(BareWebViewClient.shouldBlockMainFrameRequest("https://evil.example/", origin, false))
        assertFalse(BareWebViewClient.shouldBlockMainFrameRequest("about:blank", origin, true))
        // Before the origin is known the host's own first loadUrl must work.
        assertFalse(BareWebViewClient.shouldBlockMainFrameRequest("https://evil.example/", null, true))
    }
}
