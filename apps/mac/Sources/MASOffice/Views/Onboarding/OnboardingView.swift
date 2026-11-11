import AppKit
import MASOfficeKit
import SwiftUI

/// The setup checklist: first launch (in the main window until a workspace is chosen), Help ▸ Setup Check, and
/// whenever something the team needs is not ready. Each row says what is wrong and the exact next step.
///
/// MAS Office never signs anyone in: a backend that is not signed in shows the vendor's own command with Copy and
/// Open Terminal (which only opens Terminal). Nothing here blocks viewing an existing workspace.
struct OnboardingView: View {
    /// In the Setup Check window: "Open the office" closes it.
    var onClose: (() -> Void)?
    /// Fixed rows instead of the live ones (renders).
    var preview: [SetupCheck.Item]?

    @Environment(AppController.self) private var app
    @Environment(OfficeStore.self) private var store
    @Environment(\.openWindow) private var openWindow
    @ViewState private var error: String?
    @ViewState private var checking = false

    var body: some View {
        let items = preview ?? SetupCheck.items(Self.input(app: app, store: store))
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(alignment: .center, spacing: 14) {
                        Image(nsImage: NSApp.applicationIconImage)
                            .resizable()
                            .frame(width: 56, height: 56)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(app.needsWorkspace ? "Welcome to MAS Office" : "Setup Check").font(.largeTitle.weight(.semibold))
                            Text(SetupCheck.summary(items)).font(.title3).foregroundStyle(.secondary)
                        }
                    }
                    Text("MAS Office runs the Claude Code and Codex already on this Mac, each signed in with your own account. You sign in yourself in Terminal; the app never sees, stores or forwards your sign-in.")
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    VStack(spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { k, item in
                            SetupRow(item: item, perform: perform)
                            if k < items.count - 1 { Divider().padding(.leading, 44) }
                        }
                    }
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(nsColor: .separatorColor)))
                    if let error {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(Color(nsColor: B_ClaimStyle.ochre))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(28)
                .frame(maxWidth: 680)
                .frame(maxWidth: .infinity)
            }
            Divider()
            HStack {
                Button {
                    recheck()
                } label: {
                    Label("Check Again", systemImage: "arrow.clockwise")
                }
                .disabled(checking)
                .help("Look for Node.js again and re-read what the engine reports")
                if checking { ProgressView().controlSize(.small) }
                Spacer()
                if let onClose {
                    Button(SetupCheck.allReady(items) ? "Open the Office" : "Open the Office Anyway", action: onClose)
                        .keyboardShortcut(.defaultAction)
                        .help("Every existing project stays viewable, ready or not")
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
        }
    }

    /// The checklist input from the app and the store.
    static func input(app: AppController, store: OfficeStore) -> SetupCheck.Input {
        SetupCheck.Input(attached: app.isAttached, nodeCheck: app.nodeCheck, daemon: app.daemonState,
                         runtime: store.session?.runtime,
                         backends: store.session?.backends ?? app.daemonState.info.map(\.backends).flatMap { $0.isEmpty ? nil : $0 },
                         workspace: app.workspace, hasProject: store.currentProject != nil, structure: store.structure)
    }

    private func recheck() {
        checking = true
        error = nil
        Task {
            await app.recheck()
            checking = false
        }
    }

    private func perform(_ action: SetupCheck.Action) {
        error = nil
        switch action {
        case .none, .command:
            break
        case .chooseWorkspace:
            if let url = WorkspacePicker.choose(current: app.workspace) {
                Task {
                    do { try await app.chooseWorkspace(url) } catch { self.error = "The folder could not be used: \(error.localizedDescription)" }
                }
            }
        case .createExample:
            do {
                try app.createExampleProject()
                Task { await store.refresh() }
            } catch {
                self.error = error.localizedDescription
            }
        case .lockTeam:
            openWindow(id: "team")
        case .retryEngine:
            Task { await app.restartDaemon() }
        case .openURL(let s):
            if let url = URL(string: s) { NSWorkspace.shared.open(url) }
        }
    }
}

/// One checklist row: state symbol, title, detail and the step to take.
private struct SetupRow: View {
    var item: SetupCheck.Item
    var perform: (SetupCheck.Action) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            symbol.frame(width: 20).padding(.top, 1)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(item.title).font(.headline)
                    if !item.required { Text("optional").font(.caption).foregroundStyle(.secondary) }
                }
                Text(item.detail).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if case .command(let cmd) = item.action, item.state != .ready {
                    CommandBox(command: cmd)
                }
            }
            Spacer(minLength: 8)
            actionButton
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(item.title): \(stateWord)")
    }

    private var stateWord: String {
        switch item.state {
        case .ready: return "ready"
        case .attention: return "needs attention"
        case .missing: return "to do"
        case .pending: return "checking"
        }
    }

    @ViewBuilder
    private var symbol: some View {
        switch item.state {
        case .ready:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(B_ClaimStyle.color(.supported)).accessibilityLabel("Ready")
        case .attention:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Color(nsColor: B_ClaimStyle.ochre)).accessibilityLabel("Needs attention")
        case .missing:
            Image(systemName: "arrow.right.circle.fill").foregroundStyle(Color.accentColor).accessibilityLabel("To do")
        case .pending:
            ProgressView().controlSize(.small).accessibilityLabel("Checking")
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        switch item.action {
        case .chooseWorkspace:
            Button(item.state == .ready ? "Change…" : "Choose…") { perform(.chooseWorkspace) }
        case .createExample:
            Button("Create from Example") { perform(.createExample) }
                .help("Copies the example team (a price comparison) into your workspace, unlocked, so you can read and lock it")
        case .lockTeam:
            Button("Review and Lock…") { perform(.lockTeam) }
        case .retryEngine:
            Button("Try Again") { perform(.retryEngine) }
        case .openURL:
            Button("Download…") { perform(item.action) }
        case .none, .command:
            EmptyView()
        }
    }
}

/// A command to run in Terminal: monospaced, selectable, with Copy and Open Terminal. Opening Terminal does not
/// type or run anything.
struct CommandBox: View {
    var command: String
    @ViewState private var copied = false

    var body: some View {
        HStack(spacing: 8) {
            Text(command)
                .font(.callout.monospaced())
                .textSelection(.enabled)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 5).fill(Color(nsColor: .textBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Color(nsColor: .separatorColor)))
            Button(copied ? "Copied" : "Copy") {
                B_Pasteboard.copy(command)
                copied = true
            }
            .help("Copy the command")
            Button("Open Terminal") { Self.openTerminal() }
                .help("Opens Terminal. Paste the command there and run it yourself.")
        }
        .controlSize(.small)
    }

    static func openTerminal() {
        let terminal = URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
        NSWorkspace.shared.openApplication(at: terminal, configuration: NSWorkspace.OpenConfiguration())
    }
}

/// Help ▸ Setup Check.
struct SetupCheckWindow: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        OnboardingView(onClose: {
            openWindow(id: "main")
            dismiss()
        })
        .frame(minWidth: 560, minHeight: 520)
    }
}
