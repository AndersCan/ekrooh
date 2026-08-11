import SwiftUI

@main
struct IOSApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

  var body: some Scene {
    WindowGroup {
      ContentView(runtime: appDelegate.runtime)
    }
  }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
  /// Owns the worklet/IPC lifecycle for the app's lifetime; terminated when the
  /// app closes (mirror of `MainActivity.onDestroy`).
  let runtime = BareRuntime()

  func applicationWillTerminate(_ application: UIApplication) {
    runtime.terminate()
  }
}
