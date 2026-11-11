import AppKit
import MASOfficeKit
import SwiftUI

/// What the menu bar menu lists, shared by the menu and its render.
@MainActor
struct MenuBarModel {
    struct Entry: Identifiable {
        var item: PendingItem
        /// "🛒 Retail finder (4 min): Open currys.co.uk in the browser?" — the wait comes before the title so a
        /// long title never hides it.
        var title: String
        /// "5 min", or "" in the first minute.
        var waited: String
        /// Allow / deny answerable from the menu.
        var quick: (allow: RequestOption, reject: RequestOption)?
        var id: String { item.id }
    }

    static let maxShown = 5

    var header: String
    var entries: [Entry]
    var more: Int
    var runLine: String
    var engineLine: String?
    var canGoToNext: Bool

    init(app: AppController, store: OfficeStore) {
        let human = store.arrangedInbox.human
        header = human.isEmpty ? "Nothing needs you" : human.count == 1 ? "1 thing needs you" : "\(human.count) things need you"
        entries = human.prefix(Self.maxShown).map { item in
            let r = item.request
            let who = r.agentId.map { id in (store.structure?.emoji(of: id).map { $0 + " " } ?? "") + store.displayName(id) } ?? "Lead"
            let a = RequestActions(r)
            let quick = store.canAct && !store.isAnswerLocked(r.requestId) && a.hasQuickPair
            let waited = store.waited(item)
            return Entry(item: item, title: who + (waited.isEmpty ? "" : " (\(waited))") + ": " + PlainText.clip(r.title, 64), waited: waited,
                         quick: quick ? a.quickAllow.flatMap { allow in a.quickReject.map { (allow, $0) } } : nil)
        }
        more = max(0, human.count - Self.maxShown)
        runLine = store.runLine
        if case .running = app.daemonState { engineLine = nil } else { engineLine = app.daemonState.line }
        canGoToNext = !store.waitingAgents.isEmpty
    }
}

/// The menu bar icon (a template symbol): the needs-you count beside it when something waits.
struct MenuBarLabel: View {
    var store: OfficeStore
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let n = store.needsYouCount
        Group {
            if n > 0 {
                Label("\(n)", systemImage: "building.2.fill")
                    .labelStyle(.titleAndIcon)
            } else {
                Image(systemName: "building.2")
            }
        }
        .accessibilityLabel(n == 0 ? "MAS Office" : n == 1 ? "MAS Office, 1 thing needs you" : "MAS Office, \(n) things need you")
        .onAppear {
            let open = openWindow
            AttentionNotifier.shared.openMainWindow = { open(id: "main") }
        }
    }
}

/// The menu bar menu: up to five requests (a simple allow / deny approval can be answered from its submenu),
/// the next agent that needs you, where the run stands, open, quit.
struct MenuBarContent: View {
    @Environment(AppController.self) private var app
    @Environment(OfficeStore.self) private var store
    @Environment(WindowState.self) private var ui
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let m = MenuBarModel(app: app, store: store)
        Text(m.header)
        ForEach(m.entries) { e in
            let label = e.title
            if let q = e.quick {
                Menu(label) {
                    Button(q.allow.name) { Task { await store.quickAnswer(e.item.request, allow: true) } }
                    Button(q.reject.name) { Task { await store.quickAnswer(e.item.request, allow: false) } }
                    Divider()
                    Button("Show in Inbox") { reveal(e.item.request.requestId) }
                }
            } else {
                Button(label) { reveal(e.item.request.requestId) }
            }
        }
        if m.more > 0 {
            Button("\(m.more) more in the inbox…") {
                open()
                ui.show(.inbox)
            }
        }
        Divider()
        Button("Next Agent That Needs You") {
            open()
            if let id = store.selectNextNeedingYou() { SupervisionUI.shared.showAgent(id, store: store, ui: ui) }
        }
        .disabled(!m.canGoToNext)
        Divider()
        Text(m.runLine)
        if let line = m.engineLine { Text(line) }
        Divider()
        Button("Open MAS Office") { open() }
        Divider()
        Button("Quit MAS Office") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }

    private func open() {
        openWindow(id: "main")
        NSApp.activate(ignoringOtherApps: true)
    }

    private func reveal(_ requestId: String) {
        open()
        SupervisionUI.shared.reveal(requestId, store: store, ui: ui)
    }
}

/// A picture of the menu bar menu's content, for `--render` (an `NSMenu` cannot be drawn off screen). Same
/// model, menu-like layout.
struct MenuBarMenuPreview: View {
    @Environment(AppController.self) private var app
    @Environment(OfficeStore.self) private var store

    var body: some View {
        let m = MenuBarModel(app: app, store: store)
        VStack(alignment: .leading, spacing: 0) {
            row(m.header, disabled: true)
            ForEach(m.entries) { e in
                row(e.title, submenu: e.quick != nil)
            }
            if m.more > 0 { row("\(m.more) more in the inbox…") }
            separator
            row("Next Agent That Needs You", disabled: !m.canGoToNext)
            separator
            row(m.runLine, disabled: true)
            if let line = m.engineLine { row(line, disabled: true) }
            separator
            row("Open MAS Office")
            separator
            row("Quit MAS Office", shortcut: "⌘Q")
        }
        .padding(5)
        .frame(width: 420, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.regularMaterial))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5))
    }

    private var separator: some View {
        Divider().padding(.horizontal, 9).padding(.vertical, 5)
    }

    private func row(_ title: String, disabled: Bool = false, submenu: Bool = false, shortcut: String? = nil) -> some View {
        HStack {
            Text(verbatim: title).lineLimit(1)
            Spacer(minLength: 12)
            if submenu { Image(systemName: "chevron.right").font(.caption.weight(.semibold)) }
            if let shortcut { Text(verbatim: shortcut).foregroundStyle(.secondary) }
        }
        .font(.body)
        .foregroundStyle(disabled ? .secondary : .primary)
        .padding(.horizontal, 9)
        .padding(.vertical, 3)
    }
}
