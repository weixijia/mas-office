import AppKit
import MASOfficeKit
import Observation

/// App lifecycle: start the engine, keep running in the menu bar when the window closes, confirm before
/// quitting during a run, stop the engine on quit; launch modes `--self-check` and `--render`.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var badgeTask: Task<Void, Never>?

    /// Become the notification delegate before launch finishes, so a notification click that launched the
    /// app is delivered.
    func applicationWillFinishLaunching(_ notification: Notification) {
        AttentionNotifier.shared.activate(store: Shared.app.store)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let app = Shared.app
        Task { await app.start() }
        badgeTask = Task {
            while !Task.isCancelled {
                AttentionNotifier.shared.tick() // the Dock badge and system notifications
                try? await Task.sleep(for: .seconds(1))
            }
        }
        if let path = app.options.selfCheckPath {
            Task { await SelfCheck.run(path: path, seconds: app.options.selfCheckSeconds) }
        }
        if let path = ChromeChecks.reportPath {
            Task { await ChromeChecks.run(path: path) }
        }
        if let dir = app.options.renderDirectory {
            Task { await Renderer.run(directory: dir) }
        }
    }

    /// Closing the window keeps the app (and a run) alive in the menu bar, unless Settings says otherwise.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { !Shared.app.keepRunningInMenuBar }

    /// Quitting during a run asks first; quitting stops the engine this app started.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let app = Shared.app
        if !app.options.isAutomated, let question = app.quitConfirmation {
            let alert = NSAlert()
            alert.messageText = question
            alert.informativeText = "Their sessions are closed and can resume next time."
            alert.addButton(withTitle: "Quit and Stop")
            alert.addButton(withTitle: "Cancel")
            alert.alertStyle = .warning
            if alert.runModal() != .alertFirstButtonReturn { return .terminateCancel }
        }
        badgeTask?.cancel()
        // Synchronous on purpose: AppKit's terminate loop does not run Swift tasks, so `.terminateLater` with a
        // Task would never get its reply. Closing the daemon's stdin stops it; this waits a few seconds at most.
        app.shutdownNow()
        return .terminateNow
    }
}
