import AppKit
import MASOfficeKit
import SwiftUI

/// The menu bar: File, Edit (standard), View, Team, Window (standard), Help. Items that do not apply are
/// disabled, with the reason in their help tag.
struct AppCommands: Commands {
    let app: AppController
    let ui: WindowState
    @Environment(\.openWindow) private var openWindow

    static let helpURL = URL(string: "https://github.com/weixijia/mas-office#readme")!
    static let issuesURL = URL(string: "https://github.com/weixijia/mas-office/issues")!

    private var store: OfficeStore { app.store }

    var body: some Commands {
        SidebarCommands()
        InspectorCommands()

        // File
        CommandGroup(replacing: .newItem) {
            let blocker = store.isRunActive ? nil : RunInfo.startBlocker(session: store.session, actReason: store.actReason,
                                                                          structure: store.structure, runActive: false)
            Button(store.isRunActive ? "Run in Progress…" : "New Run…") { inMain { ui.runSheet = .newRun } }
                .keyboardShortcut("n")
                .disabled(blocker != nil)
                .help(blocker ?? "Give the team a task")
            Button("Ask Follow-up…") { inMain { ui.runSheet = .followUp } }
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .disabled(followUpBlocker != nil)
                .help(followUpBlocker ?? "Ask about the result")
            Divider()
            Button("Open Workspace…") { ProjectActions.openWorkspace(app: app) }
                .keyboardShortcut("o")
                .disabled(app.isAttached)
                .help(app.isAttached ? "This app is attached to an engine with its own workspace" : "Use another workspace folder")
            Button("Reveal Project in Finder") { ProjectActions.reveal(app: app, store: store) }
                .disabled(ProjectActions.projectURL(app: app, store: store) == nil)
        }
        CommandGroup(replacing: .importExport) {
            Button("Export Result…") { inMain { ui.exportResult = true } }
                .keyboardShortcut("e", modifiers: [.command, .shift])
                .disabled(store.snapshot.result == nil)
                .help(store.snapshot.result == nil ? "There is no result yet" : "Save the result as a Markdown file")
        }

        // View
        CommandGroup(before: .toolbar) {
            Button("Show Inbox") { inMain { ui.show(.inbox) } }.keyboardShortcut("1")
            Button("Show Agent") { inMain { ui.show(.agent) } }.keyboardShortcut("2")
            Button("Show Result") { inMain { ui.show(.result) } }.keyboardShortcut("3")
            Button("Open Result in Window") { openWindow(id: "result") }
                .keyboardShortcut("3", modifiers: [.command, .option])
                .disabled(store.snapshot.result == nil)
            Divider()
            Button("Team Design") { openWindow(id: "team") }
                .keyboardShortcut("t")
                .disabled(store.structure == nil)
                .help(store.structure == nil ? "This project has no team design" : "Who does what, with which tools")
            Divider()
        }

        // Team
        CommandMenu("Team") {
            Button("Next Agent That Needs You") { inMain { store.selectNextNeedingYou() } }
                .keyboardShortcut("j")
                .disabled(store.waitingAgents.isEmpty)
            Button("Next Idle Agent") { inMain { store.selectNextIdle() } }
                .keyboardShortcut("j", modifiers: [.command, .shift])
                .disabled(store.structure == nil)
            Divider()
            let selected = store.selectedAgentId
            Button("Message \(selected.map(store.displayName) ?? "Agent")…") { inMain { ui.messageTarget = selected } }
                .keyboardShortcut("m", modifiers: [.command, .option])
                .disabled(selected.map { !store.accepts($0, "message") } ?? true)
                .help(selected == nil ? "Select an agent first" : "Send a message to its session")
            Button("Stop \(selected.map(store.displayName) ?? "Agent")") {
                if let id = selected { Task { await store.requestStop(id) } }
            }
            .keyboardShortcut(".", modifiers: [.command, .option])
            .disabled(selected.map { !store.accepts($0, "interrupt") || store.status(of: $0)?.state.isBusy != true } ?? true)
            .help(selected == nil ? "Select an agent first" : "Stop its current turn")
            Button("Stop Run…") { inMain { ui.confirmStopRun = true } }
                .keyboardShortcut(".")
                .disabled(!store.isRunActive || store.stopRunTargets.isEmpty)
                .help(store.isRunActive ? "Stop the Lead and every working role" : "No run is in progress")
            Divider()
            Button("Refresh") { Task { await store.refreshSession() } }
                .keyboardShortcut("r", modifiers: [.command, .shift])
            Button("Restart Engine") { Task { await app.restartDaemon() } }
                .disabled(app.isAttached || app.workspace == nil)
        }

        // Help
        CommandGroup(replacing: .help) {
            Button("MAS Office Help") { NSWorkspace.shared.open(Self.helpURL) }
            Button("Setup Check…") { openWindow(id: "setup") }
            Divider()
            Button("Report an Issue…") { NSWorkspace.shared.open(Self.issuesURL) }
        }
    }

    private var followUpBlocker: String? {
        if store.snapshot.result == nil { return "There is no result to ask about yet" }
        if let r = store.actReason { return r }
        if store.session?.runtime != true { return "This engine only shows the office" }
        if store.isRunActive { return "A run is in progress" }
        return nil
    }

    /// Bring the main window forward, then act on its state.
    private func inMain(_ action: () -> Void) {
        if !NSApp.windows.contains(where: { $0.identifier?.rawValue.hasPrefix("main") == true && $0.isVisible }) {
            openWindow(id: "main")
        }
        action()
    }
}
