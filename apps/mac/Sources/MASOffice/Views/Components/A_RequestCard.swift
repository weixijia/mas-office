import AppKit
import MASOfficeKit
import SwiftUI

/// One pending request, answerable in place: kind, who, how long it has waited, the full subject, what happens
/// if nobody answers, the answer buttons, a reply (or send-back) field, and the receipt of the answer sent from
/// here. Used by the inbox and by the agent page.
struct RequestCard: View {
    @Environment(OfficeStore.self) private var store
    var item: PendingItem
    /// Routed to the Lead (or another agent) first: drawn quieter, still answerable.
    var dimmed = false
    /// Show who asked (the inbox does; the agent page is already about that agent).
    var showsAgent = true
    var isFocused = false
    var onShowAgent: ((String) -> Void)?
    @ViewState private var text = ""

    var body: some View {
        let r = item.request
        let actions = RequestActions(r)
        let receipt = store.answerReceipt(for: r.requestId)
        let locked = Supervision.isAnswerLocked(receipt)
        VStack(alignment: .leading, spacing: 9) {
            header(r)
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: r.title)
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                if let d = r.description, !d.isEmpty {
                    Text(verbatim: d)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
            if dimmed {
                Label(r.routeTo == "lead" ? "With the Lead" : "With " + store.displayName(r.routeTo), systemImage: "arrow.turn.down.right")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let subject = Supervision.subjectView(r.subject), !subject.text.isEmpty || !subject.label.isEmpty {
                SubjectBlock(subject: subject)
            }
            ifUnanswered(r)
            if actions.terminalOnly {
                Label("Answer it in the terminal where that session runs.", systemImage: "terminal")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if store.canAct {
                controls(r, actions, locked: locked)
            }
            if let receipt {
                ReceiptLine(receipt: receipt, label: store.answers[r.requestId].flatMap { store.localCommands[$0]?.text })
            }
            if isFocused, store.canAct, !locked, !actions.terminalOnly, let hint = keyHint(actions) {
                Text(verbatim: hint)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, 11)
        .padding(.leading, 14)
        .padding(.trailing, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(dimmed && !isFocused ? 0.72 : 1)
        .cardStyle(focused: isFocused, accent: dimmed || !r.blocking ? nil : Tone.color(r.kindInfo))
        .contextMenu {
            if let id = r.agentId, let onShowAgent {
                Button("Show Agent") { onShowAgent(id) }
            }
            if let s = Supervision.subjectView(r.subject), !s.text.isEmpty {
                Button("Copy Subject") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(s.text, forType: .string)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(r.kindInfo.label) from \(store.displayName(r.agentId ?? "lead")): \(r.title)")
    }

    // MARK: Parts

    private func header(_ r: InboxRequest) -> some View {
        HStack(alignment: .center, spacing: 6) {
            KindBadge(kind: r.kindInfo, dimmed: dimmed)
            if r.urgency == .high {
                TagBadge(text: "URGENT", color: Tone.needsYou, filled: true)
            }
            if showsAgent, let id = r.agentId {
                Button {
                    onShowAgent?(id)
                } label: {
                    AgentChip(agentId: id)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(.primary)
                }
                .buttonStyle(.plain)
                .layoutPriority(1)
                .help("Show \(store.displayName(id))")
                .accessibilityHint("Shows this agent")
            }
            Spacer(minLength: 4)
            WaitClock(since: item.since)
        }
    }

    /// "If you don't answer" with what happens, what it holds up, and when it times out.
    @ViewBuilder
    private func ifUnanswered(_ r: InboxRequest) -> some View {
        let holds = store.holdsUpText(item)
        let timeout = r.expiresAt.flatMap(Supervision.parseISODate).map { "Times out at " + Clock.short($0) }
        let parts = [r.onExpire, holds.isEmpty ? nil : holds, timeout].compactMap { $0?.isEmpty == false ? $0 : nil }
        if !parts.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text("If you don’t answer")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(verbatim: parts.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder
    private func controls(_ r: InboxRequest, _ actions: RequestActions, locked: Bool) -> some View {
        if !actions.buttons.isEmpty {
            FlowLayout(spacing: 6, lineSpacing: 6) {
                ForEach(actions.buttons) { o in
                    AnswerButton(option: o, primary: o.option.optionId == actions.primary?.optionId) {
                        Task { await store.answer(r, option: o.option) }
                    }
                    .disabled(locked)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Answers")
        }
        HStack(spacing: 6) {
            ReplyField(text: $text, placeholder: actions.replyPlaceholder, isEnabled: !locked,
                       accessibilityLabel: (actions.replyButton == "Send back" ? "What should change: " : "Reply to: ") + r.title,
                       onSubmit: submit)
                .frame(minWidth: 80)
            Button(actions.replyButton, action: submit)
                .disabled(locked || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .help(actions.replyButton == "Send back" ? "Send it back with this note (⌘↩)" : "Send this reply (⌘↩)")
        }
    }

    private func submit() {
        let t = text
        let request = item.request
        guard !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        Task {
            if await store.submitText(request, text: t) != nil { text = "" }
        }
    }

    private func keyHint(_ a: RequestActions) -> String? {
        var parts: [String] = []
        if let p = a.primary { parts.append("Return: \(p.name)") }
        if let allow = a.quickAllow, let reject = a.quickReject { parts.append("A: \(allow.name) · D: \(reject.name)") }
        parts.append("↑↓: next card")
        return parts.joined(separator: " · ")
    }
}

/// One answer button: the allow-once kind is the prominent one; reject kinds are destructive; a standing rule
/// says so.
private struct AnswerButton: View {
    var option: AnswerOption
    var primary: Bool
    var action: () -> Void

    var body: some View {
        let button = Button(role: option.tone == .reject ? .destructive : nil, action: action) {
            HStack(spacing: 4) {
                Text(verbatim: option.option.name)
                if option.always {
                    Image(systemName: "repeat")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("standing rule")
                }
            }
        }
        .help(option.always ? "A standing rule: applies to later requests like this one too" : option.option.name)
        if primary {
            button.buttonStyle(.borderedProminent)
        } else {
            button.buttonStyle(.bordered)
        }
    }
}

/// Keyboard on a focused card: Return answers with the allow-once / accept option only, A / D the simple
/// allow / deny pair, ↑ / ↓ move between cards.
struct CardKeys: ViewModifier {
    @Environment(OfficeStore.self) private var store
    var request: InboxRequest
    var move: (Int) -> Void

    func body(content: Content) -> some View {
        content
            .onKeyPress(.return) {
                guard RequestActions(request).primary != nil, store.canAct, !store.isAnswerLocked(request.requestId) else { return .ignored }
                Task { await store.answerWithReturnKey(request) }
                return .handled
            }
            .onKeyPress(characters: CharacterSet(charactersIn: "aAdD"), phases: .down) { press in
                guard press.modifiers.subtracting(.shift).isEmpty, RequestActions(request).hasQuickPair else { return .ignored }
                let allow = press.characters.lowercased() == "a"
                Task { await store.quickAnswer(request, allow: allow) }
                return .handled
            }
            .onKeyPress(.downArrow) {
                move(1)
                return .handled
            }
            .onKeyPress(.upArrow) {
                move(-1)
                return .handled
            }
    }
}
