import AppKit
import MASOfficeKit
import SwiftUI

/// The main window: projects and the team in the sidebar, the office drawing in the middle with a status bar, the
/// inspector (Inbox / Agent / Result) on the right. The toolbar carries the project switcher, the run state, the
/// "Needs you" button, New Run, the inspector pages and the inspector toggle.
struct MainWindow: View {
    @Environment(AppController.self) private var app
    @Environment(OfficeStore.self) private var store
    @Environment(WindowState.self) private var ui
    @Environment(\.openWindow) private var openWindow
    @ViewState private var exportError: String?

    /// Setup Check opens by itself once per launch when something the team needs is not ready.
    @MainActor static var setupShown = false

    var body: some View {
        @Bindable var ui = ui
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 360)
        } detail: {
            OfficeArea()
                .safeAreaInset(edge: .bottom, spacing: 0) { StatusBar() }
                .inspector(isPresented: $ui.showInspector) {
                    InspectorView()
                        .inspectorColumnWidth(min: 330, ideal: 390, max: 620)
                }
        }
        .navigationTitle(title)
        .navigationSubtitle(subtitle)
        .toolbar { MainToolbar() }
        .sheet(item: $ui.runSheet) { mode in
            RunSheet(mode: mode)
        }
        .sheet(item: Binding(get: { ui.messageTarget.map(AgentRef.init) }, set: { ui.messageTarget = $0?.id })) { ref in
            MessageAgentSheet(agentId: ref.id)
        }
        .confirmationDialog("Stop the run?", isPresented: $ui.confirmStopRun) {
            Button("Stop Run", role: .destructive) { Task { await store.stopRun() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The Lead and every working role stop their current turn. Their sessions stay open, the work so far is kept, and you can start a new run.")
        }
        .fileExporter(isPresented: $ui.exportResult, document: B_MarkdownFile(text: exportText), contentType: B_MarkdownFile.type,
                      defaultFilename: ResultExport.fileName(store.snapshot.result?.title)) { r in
            if case .failure(let e) = r { exportError = e.localizedDescription }
        }
        .alert("The result could not be saved", isPresented: Binding(get: { exportError != nil }, set: { if !$0 { exportError = nil } })) {
            Button("OK") { exportError = nil }
        } message: {
            Text((exportError ?? "") + " Choose another folder and try again.")
        }
        .alert("Something went wrong", isPresented: Binding(get: { store.lastError != nil }, set: { if !$0 { store.dismissError() } })) {
            Button("OK") { store.dismissError() }
        } message: {
            Text(store.lastError ?? "")
        }
        .onChange(of: store.selectedAgentId) { _, id in
            // The inbox selects a card's agent to highlight it in the office without leaving the inbox.
            if id != nil && store.selectionOrigin != .inbox { ui.show(.agent) }
        }
        .onChange(of: setupAttention) { _, needs in
            guard needs == true, !Self.setupShown, !app.options.isAutomated, !app.needsWorkspace else { return }
            Self.setupShown = true
            openWindow(id: "setup")
        }
    }

    /// True when a required setup row is not ready, nil while still checking.
    private var setupAttention: Bool? {
        guard store.session != nil || app.daemonState.failure != nil else { return nil }
        let items = SetupCheck.items(OnboardingView.input(app: app, store: store))
        if items.contains(where: { $0.required && $0.state == .pending }) { return nil }
        return !SetupCheck.allReady(items)
    }

    private var exportText: String {
        store.snapshot.result.map { ResultExport.markdown($0, verification: store.snapshot.verification, nameOf: store.displayName) } ?? ""
    }

    private var title: String {
        if let s = store.structure?.title { return s }
        if let p = store.currentProject, let entry = store.projects?.projects.first(where: { $0.folder == p }) { return entry.title }
        return "MAS Office"
    }

    private var subtitle: String {
        if let p = store.currentProject, let entry = store.projects?.projects.first(where: { $0.folder == p }), entry.title != title {
            return entry.title
        }
        return ""
    }
}

/// An agent id as a sheet item.
struct AgentRef: Identifiable {
    var id: String
}

/// The window toolbar.
struct MainToolbar: ToolbarContent {
    @Environment(OfficeStore.self) private var store
    @Environment(WindowState.self) private var ui

    var body: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            ProjectSwitcher()
        }
        ToolbarItem(placement: .principal) {
            RunStatePill()
        }
        ToolbarItemGroup(placement: .primaryAction) {
            if store.needsYouCount > 0 {
                Button {
                    ui.show(.inbox)
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "hand.raised.fill")
                        Text("Needs you")
                        Text("\(store.needsYouCount)").monospacedDigit().fontWeight(.semibold)
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(Palette.verm))
                }
                .buttonStyle(.plain)
                .help("\(store.needsYouCount) " + (store.needsYouCount == 1 ? "thing needs" : "things need") + " you: open the inbox (⌘1)")
                .accessibilityLabel("Needs you: \(store.needsYouCount)")
            }
            Button {
                ui.runSheet = store.snapshot.result != nil && !store.isRunActive ? .followUp : .newRun
            } label: {
                Label(store.isRunActive ? "Run" : "New Run", systemImage: store.isRunActive ? "play.circle" : "play.fill")
            }
            .help(store.isRunActive ? "See the run's progress" : "Give the team a task (⌘N)")
            Button {
                ui.showInspector.toggle()
            } label: {
                Label("Inspector", systemImage: "sidebar.trailing")
            }
            .help(ui.showInspector ? "Hide the inspector" : "Show the inspector")
        }
    }
}

/// The project menu in the toolbar.
struct ProjectSwitcher: View {
    @Environment(AppController.self) private var app
    @Environment(OfficeStore.self) private var store

    var body: some View {
        let projects = store.projects?.projects ?? []
        let current = projects.first { $0.folder == store.currentProject }
        Menu {
            if projects.isEmpty {
                Text("No projects yet")
            }
            ForEach(projects) { p in
                Toggle(isOn: Binding(get: { p.folder == store.currentProject }, set: { if $0 { store.selectProject(p.folder) } })) {
                    Text(p.title + (p.phase.map { "  —  \($0)" } ?? ""))
                }
            }
            Divider()
            Button("Reveal Project in Finder") { ProjectActions.reveal(app: app, store: store) }
                .disabled(ProjectActions.projectURL(app: app, store: store) == nil)
            Button("Open Workspace…") { ProjectActions.openWorkspace(app: app) }
                .disabled(app.isAttached)
        } label: {
            Label(current?.title ?? "Projects", systemImage: "folder")
                .labelStyle(.iconOnly)
        }
        .help("Switch project")
        .accessibilityLabel("Project: \(current?.title ?? "none")")
    }
}

/// Project-level actions shared by the toolbar and the menus.
@MainActor
enum ProjectActions {
    static func projectURL(app: AppController, store: OfficeStore) -> URL? {
        guard let w = app.workspace, let p = store.currentProject else { return nil }
        let url = w.appendingPathComponent(p, isDirectory: true)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    static func reveal(app: AppController, store: OfficeStore) {
        if let url = projectURL(app: app, store: store) { NSWorkspace.shared.activateFileViewerSelecting([url]) }
    }

    static func openWorkspace(app: AppController) {
        if let url = WorkspacePicker.choose(current: app.workspace) {
            Task { try? await app.chooseWorkspace(url) }
        }
    }
}

/// The middle: the office when the engine runs, otherwise what is going on with it.
struct OfficeArea: View {
    @Environment(AppController.self) private var app
    @Environment(OfficeStore.self) private var store

    var body: some View {
        Group {
            if app.needsWorkspace {
                OnboardingView()
            } else if let info = app.daemonState.info {
                OfficeWebView(daemonURL: info.url, token: info.token, project: store.currentProject, selection: store.selectedAgentId,
                              store: store, web: Shared.web)
            } else {
                EngineStatusView()
            }
        }
        .frame(minWidth: 380, minHeight: 360)
    }
}

/// The line at the bottom of the office: connection, what happens next, last update.
struct StatusBar: View {
    @Environment(AppController.self) private var app
    @Environment(OfficeStore.self) private var store

    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(dot).frame(width: 7, height: 7).accessibilityHidden(true)
            Text(line).lineLimit(1)
            if let next = store.snapshot.state?.next, store.connection.isUsable {
                Text("·").accessibilityHidden(true)
                Text(next).lineLimit(1).truncationMode(.tail)
            }
            Spacer(minLength: 8)
            if let updated = store.lastUpdated, store.connection.isUsable {
                B_Ticking { now in Text(Self.ago(now.timeIntervalSince(updated))).monospacedDigit() }
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .frame(height: 24)
        .frame(maxWidth: .infinity)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Status: \(line)")
    }

    private var line: String {
        guard case .running = app.daemonState else { return app.daemonState.line }
        return store.connection.line
    }

    private var dot: Color {
        guard case .running = app.daemonState else { return app.daemonState.failure == nil ? Palette.hair : Palette.vermInk }
        switch store.connection {
        case .live: return Palette.sage
        case .polling, .connecting: return Palette.ochre
        case .offline: return Palette.vermInk
        case .disconnected: return Palette.hair
        }
    }

    static func ago(_ s: TimeInterval) -> String {
        if s < 5 { return "Updated just now" }
        if s < 60 { return "Updated \(Int(s)) s ago" }
        return "Updated \(Int(s / 60)) min ago"
    }
}

/// Starting, or why the engine is not running, with what to do.
struct EngineStatusView: View {
    @Environment(AppController.self) private var app
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        switch app.daemonState {
        case .failed(let failure):
            ContentUnavailableView {
                Label(failure.reason, systemImage: "exclamationmark.triangle")
            } description: {
                if let hint = failure.hint { Text(hint).textSelection(.enabled) }
            } actions: {
                Button("Try Again") { Task { await app.restartDaemon() } }
                    .keyboardShortcut(.defaultAction)
                Button("Setup Check…") { openWindow(id: "setup") }
                Button("Choose Workspace…") { ProjectActions.openWorkspace(app: app) }
            }
        case .notStarted:
            ContentUnavailableView {
                Label("The engine is not running", systemImage: "power")
            } description: {
                Text("The engine runs your team on this Mac with your own Claude Code and Codex sign-in.")
            } actions: {
                Button("Start Engine") { Task { await app.startEngine() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(app.workspace == nil || app.isAttached)
            }
        default:
            VStack(spacing: 12) {
                ProgressView()
                Text(app.daemonState.line).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// The inspector: Inbox / Agent / Result, switched from the segmented control at its top (⌘1 ⌘2 ⌘3).
struct InspectorView: View {
    @Environment(WindowState.self) private var ui
    @Environment(OfficeStore.self) private var store

    var body: some View {
        @Bindable var ui = ui
        VStack(spacing: 0) {
            Picker("Inspector page", selection: $ui.inspectorTab) {
                ForEach(InspectorTab.allCases) { tab in
                    Text(label(tab)).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .help("Inbox ⌘1 · Agent ⌘2 · Result ⌘3")
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            Divider()
            switch ui.inspectorTab {
            case .inbox: InboxView()
            case .agent: AgentDetailView()
            case .result: ResultView()
            }
        }
    }

    private func label(_ tab: InspectorTab) -> String {
        tab == .inbox && store.needsYouCount > 0 ? "Inbox (\(store.needsYouCount))" : tab.rawValue
    }
}

/// Message… : a message to one agent's real session, with how it is delivered.
struct MessageAgentSheet: View {
    var agentId: String
    @Environment(OfficeStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @ViewState private var text = ""
    @ViewState private var delivery: Delivery = .steer
    @ViewState private var cmdId: String?
    @FocusState private var focused: Bool

    var body: some View {
        let accepts = store.accepts(agentId, "message")
        VStack(alignment: .leading, spacing: 14) {
            Text("Message \(store.displayName(agentId))").font(.title2.weight(.semibold))
            Text(accepts ? "Goes to its own session. It reads it as coming from you." : "This agent does not take messages right now.")
                .font(.callout).foregroundStyle(.secondary)
            TextEditor(text: $text)
                .font(.body)
                .scrollContentBackground(.hidden)
                .focused($focused)
                .padding(6)
                .frame(minHeight: 90)
                .background(RoundedRectangle(cornerRadius: 7).fill(Color(nsColor: .textBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Color(nsColor: .separatorColor)))
                .disabled(!accepts)
            Picker("Deliver", selection: $delivery) {
                ForEach(Delivery.allCases) { d in Text(d.label).tag(d) }
            }
            .pickerStyle(.segmented)
            Text(delivery.explanation).font(.caption).foregroundStyle(.secondary)
            if let cmdId, let r = store.receipt(for: cmdId) {
                Label(r.text, systemImage: r.ok ? "checkmark.circle" : "exclamationmark.triangle").font(.callout)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Send") {
                    let t = text
                    Task {
                        cmdId = await store.sendMessage(to: agentId, text: t, delivery: delivery)
                        if cmdId != nil {
                            text = ""
                            try? await Task.sleep(for: .milliseconds(600))
                            dismiss()
                        }
                    }
                }
                .keyboardShortcut(.return, modifiers: .command)
                .buttonStyle(.borderedProminent)
                .disabled(!accepts || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear { focused = true }
    }
}
