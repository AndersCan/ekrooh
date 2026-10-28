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
}
