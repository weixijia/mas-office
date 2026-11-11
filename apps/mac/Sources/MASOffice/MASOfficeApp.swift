import AppKit
import MASOfficeKit
import SwiftUI

@main
struct MASOfficeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        Window("MAS Office", id: "main") {
            MainWindow()
                .environment(Shared.app)
                .environment(Shared.app.store)
                .environment(Shared.ui)
                .frame(minWidth: 960, minHeight: 600)
        }
        .defaultSize(width: 1320, height: 820)
        .windowToolbarStyle(.unified)
        .commands { AppCommands(app: Shared.app, ui: Shared.ui) }

        Window("Result", id: "result") {
            ResultWindow()
                .environment(Shared.app)
                .environment(Shared.app.store)
                .environment(Shared.ui)
        }
        .defaultSize(width: 860, height: 900)

        Window("Team Design", id: "team") {
            TeamInspectorView()
                .environment(Shared.app)
                .environment(Shared.app.store)
                .environment(Shared.ui)
        }
        .defaultSize(width: 780, height: 860)

        Window("Setup Check", id: "setup") {
            SetupCheckWindow()
                .environment(Shared.app)
                .environment(Shared.app.store)
                .environment(Shared.ui)
        }
        .defaultSize(width: 680, height: 720)
        .windowResizability(.contentMinSize)

        Settings {
            SettingsView()
                .environment(Shared.app)
                .environment(Shared.app.store)
                .environment(Shared.ui)
        }

        MenuBarExtra {
            MenuBarContent()
                .environment(Shared.app)
                .environment(Shared.app.store)
                .environment(Shared.ui)
        } label: {
            MenuBarLabel(store: Shared.app.store)
        }
    }
}

// The menu bar extra's label and menu are in MenuBar/MenuBarExtraViews.swift.
