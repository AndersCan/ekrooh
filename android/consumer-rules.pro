# Consumer ProGuard rules for the :bare-host library. These ship inside the
# published AAR and are applied to consumer apps so R8 does not strip the host
# API surface or the Bare Kit IPC entry points the worklet reaches across the
# JNI boundary.

# Public host API: classes consumers subclass/implement (WebView client,
# plugin registry, IPC coordinator, protocol helpers).
-keep class to.holepunch.bare.android.** { *; }

# Bare Kit IPC + Worklet entry points crossed from native via JNI.
-keep class to.holepunch.bare.kit.** { *; }
