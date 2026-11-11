import AppKit
import MASOfficeKit
import SwiftUI

/// MAS Office ▸ Settings… (⌘,): General, Notifications, Advanced, About.
struct SettingsView: View {
    enum Tab: String, Hashable { case general, notifications, advanced, about }
    var initialTab: Tab = .general
    @ViewState private var tab: Tab?

    var body: some View {
        TabView(selection: Binding(get: { tab ?? initialTab }, set: { tab = $0 })) {
            GeneralSettings()
                .tabItem { Label("General", systemImage: "gearshape") }
                .tag(Tab.general)
            NotificationSettings()
                .tabItem { Label("Notifications", systemImage: "bell.badge") }
                .tag(Tab.notifications)
            AdvancedSettings()
                .tabItem { Label("Advanced", systemImage: "wrench.and.screwdriver") }
                .tag(Tab.advanced)
            AboutSettings()
                .tabItem { Label("About", systemImage: "info.circle") }
                .tag(Tab.about)
        }
        .frame(width: 560)
    }
}

private struct GeneralSettings: View {
    @Environment(AppController.self) private var app

    var body: some View {
        @Bindable var app = app
        Form {
            Section {
                LabeledContent("Folder") {
                    VStack(alignment: .trailing, spacing: 4) {
                        Text(app.workspace.map { ($0.path as NSString).abbreviatingWithTildeInPath } ?? (app.isAttached ? "Chosen by the attached engine" : "Not chosen"))
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                            .help(app.workspace?.path ?? "")
                        HStack {
                            Button("Reveal in Finder") {
                                if let w = app.workspace { NSWorkspace.shared.activateFileViewerSelecting([w]) }
                            }
                            .disabled(app.workspace == nil)
                            Button("Choose…") {
                                if let url = WorkspacePicker.choose(current: app.workspace) {
                                    Task { try? await app.chooseWorkspace(url) }
                                }
                            }
                            .disabled(app.isAttached)
                            .help(app.isAttached ? "This app is attached to an engine that has its own workspace" : "Use another folder (the engine restarts)")
                        }
                        .controlSize(.small)
                    }
                }
            } header: {
                Text("Workspace")
            } footer: {
                Text("Projects, their files and the team's work live here.").font(.caption).foregroundStyle(.secondary)
            }

            Section {
                Picker("Sessions at once", selection: Binding(get: { app.maxParallel }, set: { v in
                    Task { await app.setMaxParallel(SettingsValidation.clampSessions(v)) }
                })) {
                    ForEach(1...12, id: \.self) { n in Text("\(n)").tag(n) }
                }
                .disabled(app.isAttached)
                Text("How many roles work at the same time, plus the Lead. Each session uses your own plan's limits, so fewer at once uses less. Changing it restarts the engine.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } header: {
                Text("Team")
            }

            Section {
                Toggle("Start the engine when MAS Office opens", isOn: $app.startEngineAtLaunch)
                    .disabled(app.isAttached)
                Toggle("Keep running in the menu bar when the window closes", isOn: $app.keepRunningInMenuBar)
                Text("A run keeps going while the window is closed, and the menu bar shows what needs you.")
                    .font(.caption).foregroundStyle(.secondary)
            } header: {
                Text("App")
            }
        }
        .formStyle(.grouped)
        .frame(height: 430)
    }
}

private struct NotificationSettings: View {
    var body: some View {
        Form {
            Section {
                if AttentionNotifier.shared.isAvailable {
                    NotifyMeToggle(style: .full)
                    Button("Open Notification Settings…") {
                        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") { NSWorkspace.shared.open(url) }
                    }
                    .controlSize(.small)
                } else {
                    LabeledContent("Notifications", value: "Available when MAS Office runs as an app")
                    Text("This copy runs without its app bundle, so macOS cannot deliver its notifications. The inbox and the menu bar still show everything that needs you.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            } header: {
                Text("When something needs you")
            } footer: {
                Text("Approvals, questions, decisions, checker flags and stage gates all wait in the inbox; the Dock and the menu bar show how many.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(height: 260)
    }
}

private struct AdvancedSettings: View {
    @Environment(AppController.self) private var app
    @Environment(OfficeStore.self) private var store
    @ViewState private var nodePath = ""
    @ViewState private var edited = false
    @ViewState private var nodeResult: String?
    @ViewState private var nodeOK = false
    @ViewState private var checkingNode = false

    var body: some View {
        Form {
            Section {
                LabeledContent("In use") {
                    Text(nodeInUse).textSelection(.enabled).lineLimit(2).truncationMode(.middle)
                }
                LabeledContent("Path") {
                    TextField("Path", text: $nodePath, prompt: Text("Use the Node.js on my PATH"))
                        .labelsHidden()
                        .textFieldStyle(.roundedBorder)
                        .font(.body.monospaced())
                }
                    .onChange(of: nodePath) { _, _ in
                        edited = true
                        nodeResult = nil
                    }
                    .onSubmit(validate)
                    .disabled(app.isAttached)
                if let problem = problem {
                    Label(problem, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(Color(nsColor: B_ClaimStyle.ochre))
                } else if let nodeResult {
                    Label(nodeResult, systemImage: nodeOK ? "checkmark.circle" : "exclamationmark.triangle")
                        .font(.callout)
                        .foregroundStyle(nodeOK ? B_ClaimStyle.color(.supported) : Color(nsColor: B_ClaimStyle.ochre))
                }
                HStack {
                    Button("Choose…") { chooseNode() }
                    Button("Use Default") {
                        nodePath = ""
                        Task { await app.setNodePathOverride(nil) }
                        edited = false
                    }
                    .disabled(app.nodePathOverride == nil && nodePath.isEmpty)
                    Spacer()
                    if checkingNode { ProgressView().controlSize(.small) }
                    Button("Check") { validate() }.disabled(nodePath.isEmpty || problem != nil || checkingNode)
                    Button("Apply and Restart") {
                        Task { await app.setNodePathOverride(nodePath) }
                        edited = false
                    }
                    .disabled(!edited || nodePath.isEmpty || problem != nil || !nodeOK)
                    .help(nodeOK ? "Restart the engine with this Node.js" : "Check the path first")
                }
                .controlSize(.small)
                .disabled(app.isAttached)
            } header: {
                Text("Node.js")
            } footer: {
                Text("MAS Office runs its engine with Node.js \(NodeVersion.minimum.description) or newer. Leave the path empty to use the one your login shell finds.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                LabeledContent("Engine", value: app.daemonState.line)
                LabeledContent("Connection", value: store.connection.line)
                ForEach(backends, id: \.0) { name, status in
                    LabeledContent(BackendStatus.label(name)) {
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(status.summary + (status.version.map { " · \($0)" } ?? ""))
                            if status.available, !status.loggedIn, let cmd = BackendStatus.signInCommand(name) {
                                Text("Sign in yourself in Terminal: \(cmd)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                            }
                        }
                    }
                }
                HStack {
                    Button("Restart Engine") { Task { await app.restartDaemon() } }
                        .disabled(app.isAttached || app.workspace == nil)
                        .help(app.isAttached ? "This app is attached to an engine someone else runs" : "Stop and start the engine")
                    Button("Reveal Engine Log") { revealLog() }
                        .disabled(!FileManager.default.fileExists(atPath: AppController.engineLogURL.path))
                        .help("The engine's messages, with its access token removed")
                }
                .controlSize(.small)
            } header: {
                Text("Engine")
            } footer: {
                Text("The log keeps the engine's messages for people. Its access token is never written there.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(height: 520)
        .onAppear {
            nodePath = app.nodePathOverride ?? ""
            edited = false
        }
    }

    private var problem: String? {
        nodePath.isEmpty ? nil : SettingsValidation.nodePathProblem(nodePath)?.message
    }

    private var nodeInUse: String {
        if app.isAttached { return "The attached engine's own" }
        switch app.nodeCheck {
        case .found(let url, let v)?: return "Node.js \(v) · \((url.path as NSString).abbreviatingWithTildeInPath)"
        case .tooOld(let url, let v)?: return "Node.js \(v) at \(url.path) is too old"
        case .broken(let url, _)?: return "\(url.path) did not start"
        case .missing?: return "Not found"
        case nil: return "Not checked yet"
        }
    }

    private var backends: [(String, BackendStatus)] {
        (store.session?.backends ?? app.daemonState.info?.backends ?? [:]).sorted { $0.key < $1.key }
    }

    private func validate() {
        guard problem == nil, !nodePath.isEmpty else { return }
        checkingNode = true
        let url = URL(fileURLWithPath: (nodePath as NSString).expandingTildeInPath)
        Task {
            let r = await SettingsValidation.checkNode(at: url)
            checkingNode = false
            switch r {
            case .found(_, let v): nodeOK = true; nodeResult = "Node.js \(v): usable"
            case .tooOld(_, let v): nodeOK = false; nodeResult = "Node.js \(v) is older than \(NodeVersion.minimum)"
            case .broken(_, let why): nodeOK = false; nodeResult = "It did not start: \(why)"
            case .missing: nodeOK = false; nodeResult = "Not found"
            }
        }
    }

    private func chooseNode() {
        let panel = NSOpenPanel()
        panel.title = "Choose the node program"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.treatsFilePackagesAsDirectories = true
        panel.showsHiddenFiles = true
        panel.directoryURL = URL(fileURLWithPath: "/opt/homebrew/bin")
        if panel.runModal() == .OK, let url = panel.url {
            nodePath = url.path
            validate()
        }
    }

    private func revealLog() {
        NSWorkspace.shared.activateFileViewerSelecting([AppController.engineLogURL])
    }
}

private struct AboutSettings: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 72, height: 72).accessibilityHidden(true)
            Text("MAS Office").font(.title.weight(.semibold))
            Text(version).foregroundStyle(.secondary).textSelection(.enabled)
            Text("An AI company you design, can watch, can steer, and that checks its own work.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 380)
            Text("Runs the official Claude Code and Codex programs installed on this Mac with your own sign-in. MAS Office is not made by, or affiliated with, Anthropic or OpenAI.")
                .font(.caption)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 420)
            HStack(spacing: 16) {
                Link("MIT Licence", destination: URL(string: "https://github.com/weixijia/mas-office/blob/main/LICENSE")!)
                Link("Third-Party Notices", destination: URL(string: "https://github.com/weixijia/mas-office/blob/main/THIRD_PARTY_NOTICES.md")!)
                Link("Website", destination: URL(string: "https://github.com/weixijia/mas-office#readme")!)
            }
            .font(.callout)
            Text(Bundle.main.object(forInfoDictionaryKey: "NSHumanReadableCopyright") as? String ?? "MIT License")
                .font(.caption).foregroundStyle(.tertiary)
        }
        .padding(28)
        .frame(maxWidth: .infinity)
        .frame(height: 340)
    }

    private var version: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        return v.map { "Version \($0)" } ?? "Development build"
    }
}
