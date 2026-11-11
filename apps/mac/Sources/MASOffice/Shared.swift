import AppKit
import MASOfficeKit
import Observation
import SwiftUI

/// The inspector's pages.
enum InspectorTab: String, CaseIterable, Identifiable {
    case inbox = "Inbox"
    case agent = "Agent"
    case result = "Result"
    var id: String { rawValue }
}

/// Window-level UI state shared by the views, the menus and the menu bar extra. In the environment as
/// `WindowState`.
@MainActor
@Observable
final class WindowState {
    var showInspector = true
    var inspectorTab: InspectorTab = .inbox
    var showRunControls = false
    /// The run sheet (New Run… ⌘N / Ask Follow-up… ⇧⌘N) and what it opens with.
    var runSheet: RunSheetMode?
    /// Message… from the sidebar's context menu or the Team menu: the agent to message.
    var messageTarget: String?
    /// Stop Run (⌘.) asks first.
    var confirmStopRun = false
    /// Export Result… (the main window's file exporter).
    var exportResult = false
    /// The round the result shows (nil: the latest).
    var resultRound: Int?

    func show(_ tab: InspectorTab) {
        inspectorTab = tab
        showInspector = true
    }
}

/// What the run sheet is for.
enum RunSheetMode: String, Identifiable {
    case newRun, followUp
    var id: String { rawValue }
}

/// What the office web view reports (for the self-check and the status line).
@MainActor
@Observable
final class OfficeWebState {
    var loaded = false
    /// The panel posted `{type: 'ready'}`: `window.MASEmbed` is there.
    var ready = false
    var error: String?
    /// The page address, never with a token in it.
    var address: String?
}

/// The objects the app shares between scenes, the app delegate and launch modes.
@MainActor
enum Shared {
    static let options = LaunchOptions.parse(arguments: CommandLine.arguments, environment: ProcessInfo.processInfo.environment)
    static let app = AppController(options: options)
    static let ui = WindowState()
    static let web = OfficeWebState()
}

/// The panel's palette, so native views and the office drawing read as one product.
enum Palette {
    static let verm = Color(red: 0xE0 / 255, green: 0x4E / 255, blue: 0x2A / 255)
    static let vermInk = Color(red: 0xB5 / 255, green: 0x3A / 255, blue: 0x1C / 255)
    static let cobalt = Color(red: 0x2B / 255, green: 0x57 / 255, blue: 0xB5 / 255)
    static let ochre = Color(red: 0xD8 / 255, green: 0x9A / 255, blue: 0x12 / 255)
    static let sage = Color(red: 0x5E / 255, green: 0x8C / 255, blue: 0x57 / 255)
    static let hair = Color(red: 0xB9 / 255, green: 0xC0 / 255, blue: 0xC6 / 255)

    /// The dot colour for an agent status.
    static func color(_ status: AgentStatus?) -> Color {
        guard let s = status else { return hair }
        if s.needsYou { return verm }
        switch s.state {
        case .idle, .waiting: return hair
        case .working, .handoff: return cobalt
        case .flagged: return ochre
        case .done: return sage
        case .failed: return vermInk
        }
    }

    static func color(_ claim: ClaimStatus) -> Color {
        switch claim {
        case .supported: return sage
        case .partial: return ochre
        case .contradicted: return verm
        case .unknown: return cobalt
        case .unchecked, .notCheckworthy: return hair
        }
    }
}

/// A small round state dot.
struct StateDot: View {
    var status: AgentStatus?
    var size: CGFloat = 9

    var body: some View {
        Circle()
            .fill(Palette.color(status))
            .frame(width: size, height: size)
            .overlay(Circle().strokeBorder(.black.opacity(0.15), lineWidth: 0.5))
            .accessibilityLabel(status?.stateLabel ?? "idle")
    }
}

/// A count badge ("3").
struct CountBadge: View {
    var count: Int
    var color: Color = Palette.verm

    var body: some View {
        Text("\(count)")
            .font(.caption2.monospacedDigit().weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(color))
            .accessibilityLabel("\(count) need you")
    }
}

extension DaemonState {
    /// One line for the window subtitle and the menu bar.
    var line: String {
        switch self {
        case .notStarted: return "Engine not started"
        case .starting(let attempt): return attempt > 0 ? "Restarting the engine (attempt \(attempt))…" : "Starting the engine…"
        case .running: return "Engine running"
        case .failed(let f): return f.reason
        }
    }
}

extension OfficeStore.Connection {
    var line: String {
        switch self {
        case .disconnected: return "Not connected"
        case .connecting: return "Connecting…"
        case .live: return "Live"
        case .polling: return "Updating every 2 s (event stream down)"
        case .offline(let why): return "Offline: \(why)"
        }
    }

    var key: String {
        switch self {
        case .disconnected: return "disconnected"
        case .connecting: return "connecting"
        case .live: return "live"
        case .polling: return "polling"
        case .offline: return "offline"
        }
    }
}

/// The folder picker for the workspace.
@MainActor
enum WorkspacePicker {
    /// Ask for a workspace folder; suggests `~/MAS Office` (created when chosen and missing).
    static func choose(current: URL?) -> URL? {
        let panel = NSOpenPanel()
        panel.title = "Choose a workspace folder"
        panel.message = "MAS Office keeps your projects, their files and the team's work here."
        panel.prompt = "Use This Folder"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        let suggested = current ?? AppController.suggestedWorkspace
        if FileManager.default.fileExists(atPath: suggested.path) {
            panel.directoryURL = suggested
        } else {
            panel.directoryURL = suggested.deletingLastPathComponent()
            panel.nameFieldStringValue = suggested.lastPathComponent
        }
        return panel.runModal() == .OK ? panel.url : nil
    }
}

/// View-local state. Use it instead of `@State`: in this SDK `@State` is a macro whose plugin ships only with
/// Xcode, so Command Line Tools builds cannot expand it. This wraps the `State` property wrapper struct
/// (SwiftUI finds dynamic properties nested in dynamic properties), so it behaves the same:
/// `@ViewState private var text = ""`, `$text` is a `Binding`. Avoid the other SDK macros too
/// (`@Entry`, `@Animatable`, `#Preview`).
@propertyWrapper
struct ViewState<Value>: DynamicProperty {
    private let storage: State<Value>

    init(wrappedValue: Value) {
        storage = State(initialValue: wrappedValue)
    }

    var wrappedValue: Value {
        get { storage.wrappedValue }
        nonmutating set { storage.wrappedValue = newValue }
    }

    var projectedValue: Binding<Value> { storage.projectedValue }
}
