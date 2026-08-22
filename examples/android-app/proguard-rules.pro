# Example app ProGuard rules. Release builds ship minified (isMinifyEnabled),
# so keep the :bare-host host API and the Bare Kit IPC/JNI entry points the
# worklet reaches from native.

-keep class to.holepunch.bare.android.** { *; }
-keep class to.holepunch.bare.kit.** { *; }
