package to.holepunch.bare.android

import android.annotation.SuppressLint
import android.os.Bundle
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import to.holepunch.bare.kit.IPC
import to.holepunch.bare.kit.Worklet
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets

class MainActivity : AppCompatActivity() {
    private lateinit var worklet: Worklet
    private lateinit var ipc: IPC
    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        Log.i("BARE_KOTLIN", "!!! APP STARTING - VERSION 12 !!!")

        // 1. Initialize Worklet first
        worklet = Worklet(Worklet.Options().memoryLimit(128 * 1024 * 1024))
        
        // 2. Start Worklet
        try {
            val bundleStream = assets.open("main.core.bundle")
            Log.i("BARE_KOTLIN", "Starting worklet...")
            worklet.start("/main.core.bundle", bundleStream, null)
            
            // 3. Initialize IPC *AFTER* worklet.start() to avoid "Bad file descriptor"
            ipc = IPC(worklet)
            
            setupIpcRead()
            
        } catch (e: Exception) {
            Log.e("BARE_KOTLIN", "Failed to start worklet", e)
        }

        // 4. Setup WebView
        webView = findViewById(R.id.webview)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                Log.i("BARE_KOTLIN", "WebView loaded")
            }
        }
        webView.addJavascriptInterface(BareBridge(), "NativeBridge")
        webView.loadUrl("file:///android_asset/index.html")
    }

    private fun setupIpcRead() {
        ipc.readable {
            try {
                val data = ipc.read()
                if (data != null && data.remaining() > 0) {
                    val bytes = ByteArray(data.remaining()).also { data.get(it) }
                    val msg = String(bytes, StandardCharsets.UTF_8)
                    Log.i("BARE_KOTLIN", "!!! IPC READ !!!: $msg")
                    
                    runOnUiThread {
                        if (::webView.isInitialized) {
                            webView.evaluateJavascript("window.onBareEvent(${escapeJson(msg)})", null)
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e("BARE_KOTLIN", "Error in readable callback", e)
            }
        }
    }

    private fun escapeJson(s: String): String {
        return "'" + s.replace("\\", "\\\\")
                     .replace("'", "\\'")
                     .replace("\n", "\\n")
                     .replace("\r", "\\r") + "'"
    }

    inner class BareBridge {
        @JavascriptInterface
        fun send(message: String) {
            if (!::ipc.isInitialized) return
            try {
                val bytes = message.toByteArray(StandardCharsets.UTF_8)
                val data = ByteBuffer.wrap(bytes)
                val written = ipc.write(data)
                Log.i("BARE_KOTLIN", "IPC WRITE: $message (Written: $written bytes)")
            } catch (e: Exception) {
                Log.e("BARE_KOTLIN", "IPC Write Error", e)
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        if (::ipc.isInitialized) ipc.close()
        if (::worklet.isInitialized) worklet.terminate()
    }
}
