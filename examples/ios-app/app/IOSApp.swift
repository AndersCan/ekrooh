import SwiftUI

@main
struct IOSApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      ContentView(runtime: appDelegate.runtime)
    }
    .onChange(of: scenePhase) { phase in
      switch phase {
      case .background:
        appDelegate.runtime.suspend()
      case .active:
        appDelegate.runtime.resume()
      default:
        break
      }
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
