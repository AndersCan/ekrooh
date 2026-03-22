# Bare-Android IPC Learnings

This document summarizes the key technical hurdles and solutions encountered while setting up the communication bridge between the Android Kotlin host and the Bare JavaScript worklet.

## 1. IPC Initialization Timing

**Issue:** Initializing the `IPC` object before starting the worklet resulted in `Error adding epoll events for fd -1: Bad file descriptor`.
**Solution:** Always call `worklet.start()` before initializing the `IPC` object. The native file descriptors for the IPC channel are only valid once the worklet process has been initiated.

## 2. JavaScript Stream State

**Issue:** Messages sent from Kotlin were not triggering the `IPC.on('data')` listener in JavaScript.
**Solution:** The `IPC` object in the Bare environment often starts in a "paused" state. You must explicitly call `IPC.resume()` in your `app.js` to begin flowing data.

## 3. Logcat Visibility & Filtering

**Issue:** `Log.d` messages and JavaScript `console.log` were difficult to find or filtered out.
**Solution:**

- Use `Log.i` or `Log.e` in Kotlin for critical lifecycle and IPC events to bypass default debug filters.
- In Android Studio Logcat, use the **Package Filter** (`package:mine` or `package:to.holepunch.bare.android`) rather than a Tag filter. This allows you to see the interleaved stream of Kotlin logs and `<no-tag>` JavaScript logs in chronological order.

## 4. JNI & Buffer Stability

**Issue:** Recursive asynchronous reading patterns (`ipc.read(callback)` calling itself) caused native crashes: `JNI DETECTED ERROR: non-zero capacity for nullptr pointer`.
**Solution:** Use the **Polling IPC** pattern. Implement `ipc.readable { ... }` in Kotlin and perform a single `ipc.read()` inside the callback. This matches the BareKit documentation and avoids race conditions in the JNI layer.

## 5. Module Bundling with `bare-pack`

**Issue:** `require('buffer')` failed with `MODULE_NOT_FOUND`.
**Solution:** Use `bare-buffer` specifically. In your JS code, use `const Buffer = require('bare-buffer')`. Ensure it is listed in your `package.json` dependencies so that `bare-pack` includes it in the `app.bundle`.

## 6. Data Integrity

**Issue:** Large messages or rapid-fire commands could potentially be truncated or merged.
**Solution:** When reading from the IPC stream, ensure you handle the raw bytes with a consistent encoding (UTF-8) and use a try-catch wrapper around `JSON.parse` to handle partial data if necessary.
