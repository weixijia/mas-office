import MASOfficeKit
import SwiftUI

/// The bottom of the agent page: what was sent to this agent with receipts, a multi-line message field
/// (⌘↩ sends), how to deliver it (Steer, Queue, Interrupt), and Stop. Stop reads "Stop requested" until the
/// agent's status really changes, then "Stopped". Hidden, with the reason, when the agent takes neither
/// messages nor stops from here or this app may not act.
struct AgentComposer: View {
    @Environment(OfficeStore.self) private var store
    var agentId: String
    @ViewState private var text = ""
    @ViewState private var delivery: Delivery = .steer
    @ViewState private var height: CGFloat = 44
    @ViewState private var focused = false

    var body: some View {
        let canMessage = store.canAct && store.accepts(agentId, "message")
        let canStop = store.canAct && store.accepts(agentId, "interrupt")
        let stop = store.stopState(for: agentId)
        let log = SentLog.lines(store: store, agentId: agentId)
        VStack(alignment: .leading, spacing: 8) {
            if !log.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(log.suffix(4)) { line in SentLine(line: line) }
                }
            }
            if canMessage {
                field
                HStack(spacing: 8) {
                    Picker("Delivery", selection: $delivery) {
                        ForEach(Delivery.allCases) { d in
                            Text(d.label).tag(d)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                    .help(Delivery.allCases.map { "\($0.label): \($0.explanation)" }.joined(separator: "\n"))
                    .accessibilityHint(delivery.explanation)
                    Spacer(minLength: 4)
                    if canStop { stopButton(stop) }
                    Button("Send", action: send)
                        .buttonStyle(.borderedProminent)
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .help("Send (⌘↩)")
                }
                Text(verbatim: delivery.explanation + "  ⌘↩ sends.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if canStop {
                HStack {
                    Text("This agent does not take messages from here.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    Spacer()
                    stopButton(stop)
                }
            } else {
                Label(store.actReason ?? "This agent does not take messages or stops from here.", systemImage: "lock")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let stop {
                Label(stop.text, systemImage: stop.phase == .stopped ? "stop.circle" : stop.phase == .refused ? "exclamationmark.triangle" : "hourglass")
                    .font(.caption)
                    .foregroundStyle(stop.phase == .refused ? Tone.bad : .secondary)
                    .accessibilityAddTraits(.updatesFrequently)
                    .task(id: stop.phase) {
                        guard stop.phase != .requested else { return }
                        try? await Task.sleep(for: .seconds(6))
                        if !Task.isCancelled { store.forgetStop(agentId) }
                    }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
    }

    private var field: some View {
        ComposerField(text: $text, height: $height, isFocused: $focused, placeholder: "Message \(store.displayName(agentId))",
                      accessibilityLabel: "Message \(store.displayName(agentId))", onSubmit: send)
            .frame(height: height)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color(nsColor: .textBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(focused ? Color(nsColor: .keyboardFocusIndicatorColor) : Color(nsColor: .separatorColor), lineWidth: focused ? 2.5 : 0.5))
    }

    private func stopButton(_ stop: StopState?) -> some View {
        Button(role: .destructive) {
            Task { await store.requestStop(agentId) }
        } label: {
            Label("Stop", systemImage: "stop.fill")
        }
        .disabled(stop?.phase == .requested)
        .help("Stop the current turn. It counts as stopped only when the agent reports it.")
    }

    private func send() {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, store.canAct, store.accepts(agentId, "message") else { return }
        text = ""
        let d = delivery
        Task { await store.sendMessage(to: agentId, text: t, delivery: d) }
    }
}

/// Commands to one agent, from the engine's record and this app's own sends not yet recorded (the panel's
/// `chatLogHtml`).
struct SentLog: Identifiable, Hashable {
    var id: String
    /// "You · steer", "Lead · Task", "You · Stop".
    var who: String
    var text: String
    var receipt: Receipt

    @MainActor
    static func lines(store: OfficeStore, agentId: String) -> [SentLog] {
        let kinds: Set<String> = ["command.message", "command.interrupt", "command.assign"]
        let server = (store.snapshot.inbox?.commands ?? []).filter { $0.agentId == agentId && kinds.contains($0.type ?? "") }
        var out: [SentLog] = server.map { c in
            let who = c.origin.kind == "human" ? "You" : c.origin.id.map(store.displayName) ?? "Lead"
            return SentLog(id: c.cmdId, who: who + " · " + what(c.type, c.delivery), text: c.text ?? "",
                           receipt: Supervision.receipt(local: store.localCommands[c.cmdId], command: c))
        }
        let seen = Set(server.map(\.cmdId))
        for (id, c) in store.localCommands.sorted(by: { $0.value.at < $1.value.at })
        where c.agentId == agentId && (c.type == "command.message" || c.type == "command.interrupt") && !seen.contains(id) {
            out.append(SentLog(id: id, who: "You · " + what(c.type, c.delivery?.rawValue), text: c.text ?? "",
                               receipt: Supervision.receipt(local: c, command: nil)))
        }
        return out
    }

    private static func what(_ type: String?, _ delivery: String?) -> String {
        switch type {
        case "command.interrupt": return "Stop"
        case "command.assign": return "Task"
        default: return delivery ?? "steer"
        }
    }
}

private struct SentLine: View {
    var line: SentLog

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(verbatim: line.who)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                if !line.text.isEmpty {
                    Text(verbatim: PlainText.clip(line.text, 200))
                        .font(.caption)
                        .lineLimit(2)
                        .textSelection(.enabled)
                }
            }
            ReceiptLine(receipt: line.receipt)
        }
        .accessibilityElement(children: .combine)
    }
}
