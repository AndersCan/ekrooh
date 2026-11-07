package to.holepunch.bare.android

import android.app.Application

/**
 * Owns the one [ReferenceHost] (worklet + host plugins) for the process, so
 * an Activity being recreated, or a second Activity instance started by
 * another app, attaches to the running backend instead of starting another
 * worklet on the same storage.
 */
class BareApplication : Application() {
    val host: ReferenceHost by lazy { ReferenceHost(this) }
}
