package to.holepunch.bare.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BareHostAbiTest {
    @Test
    fun `accepts a 64-bit-only device`() {
        assertTrue(BareHostAbi.has64BitAbi(listOf("arm64-v8a")))
        assertTrue(BareHostAbi.has64BitAbi(listOf("x86_64")))
    }

    @Test
    fun `accepts a 64-bit capable device that also ships 32-bit ABIs`() {
        assertTrue(BareHostAbi.has64BitAbi(listOf("arm64-v8a", "armeabi-v7a")))
        assertTrue(BareHostAbi.has64BitAbi(listOf("x86_64", "x86")))
    }

    @Test
    fun `rejects a 32-bit-only device`() {
        assertFalse(BareHostAbi.has64BitAbi(listOf("armeabi-v7a")))
        assertFalse(BareHostAbi.has64BitAbi(listOf("x86")))
        assertFalse(BareHostAbi.has64BitAbi(listOf("armeabi-v7a", "armeabi")))
    }

    @Test
    fun `rejects an empty or unknown ABI list`() {
        assertFalse(BareHostAbi.has64BitAbi(emptyList()))
        assertFalse(BareHostAbi.has64BitAbi(listOf("mips")))
    }
}
