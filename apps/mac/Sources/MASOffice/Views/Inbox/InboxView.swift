import MASOfficeKit
import SwiftUI

/// The "needs you" inbox (inspector page): every request that waits on you, most urgent and longest waiting
/// first, answerable in place; requests with the Lead, dimmed; and what was decided recently, by whom.
///
/// Keyboard on a focused card: Return answers with its allow-once / accept option only, A / D the simple
/// allow / deny pair, ↑ / ↓ move between cards. Focusing a card selects its agent in the office without
/// leaving the inbox; double-click or the agent's name opens the agent page.
struct InboxView: View {
    @Environment(OfficeStore.self) private var store
    @Environment(WindowState.self) private var ui
    @FocusState private var focus: String?
    @ViewState private var showRecent = false
    private var sui: SupervisionUI { .shared }

    var body: some View {
        let inbox = store.arrangedInbox
        let order = inbox.human.map(\.id) + inbox.withLead.map(\.id)
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    header(count: inbox.human.count)
                    if let note = AttentionNotifier.shared.note {
                        Text(verbatim: note)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let why = store.actReason {
                        ReadOnlyNote(reason: why)
                    }
                    if inbox.human.isEmpty {
                        EmptyInbox(withLead: inbox.withLead.count)
                    }
                    ForEach(inbox.human) { item in
                        card(item, dimmed: false, order: order)
                    }
                    if !inbox.withLead.isEmpty {
                        InspectorHeading(title: "With the Lead", count: inbox.withLead.count)
                            .padding(.top, 8)
                        Text("The Lead answers these first. You can still answer one yourself.")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .fixedSize(horizontal: false, vertical: true)
                        ForEach(inbox.withLead) { item in
                            card(item, dimmed: true, order: order)
                        }
                    }
                    if !inbox.recent.isEmpty {
                        RecentSection(recent: inbox.recent, isExpanded: $showRecent)
                            .padding(.top, 8)
                    }
                }
                .padding(12)
            }
            .onChange(of: sui.revealCount) { reveal(proxy) }
            .onAppear { if sui.revealRequestId != nil { reveal(proxy) } }
            .onChange(of: focus) { _, id in
                guard let id, let agent = store.pendingItem(id)?.request.agentId else { return }
                store.selectAgent(agent, origin: .inbox)
            }
        }
    }

    private func header(count: Int) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("Needs you")
                .font(.title3.weight(.semibold))
            if count > 0 {
                Text("\(count)")
                    .font(.title3.monospacedDigit().weight(.semibold))
                    .foregroundStyle(Tone.needsYou)
            }
            Spacer(minLength: 8)
            NotifyMeToggle(style: .compact)
                .controlSize(.small)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(count == 0 ? "Nothing needs you" : count == 1 ? "1 thing needs you" : "\(count) things need you")
    }

    private func card(_ item: PendingItem, dimmed: Bool, order: [String]) -> some View {
        RequestCard(item: item, dimmed: dimmed, showsAgent: true, isFocused: focus == item.id, onShowAgent: showAgent)
            .id(item.id)
            .focusable()
            .focusEffectDisabled()
            .focused($focus, equals: item.id)
            .modifier(CardKeys(request: item.request) { step in move(from: item.id, by: step, order: order) })
            .onTapGesture(count: 2) {
                if let id = item.request.agentId { showAgent(id) }
            }
            .simultaneousGesture(TapGesture().onEnded { focus = item.id })
    }

    private func move(from id: String, by step: Int, order: [String]) {
        guard let i = order.firstIndex(of: id) else { return }
        let j = max(0, min(order.count - 1, i + step))
        focus = order[j]
    }

    private func showAgent(_ id: String) {
        sui.showAgent(id, store: store, ui: ui)
    }

    private func reveal(_ proxy: ScrollViewProxy) {
        guard let id = sui.revealRequestId else { return }
        sui.revealRequestId = nil
        guard store.pendingItem(id) != nil else { return }
        withAnimation(.snappy) { proxy.scrollTo(id, anchor: .top) }
        focus = id
    }
}

/// Quiet: nothing waits on you.
private struct EmptyInbox: View {
    var withLead: Int

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
            Text("Nothing needs you")
                .font(.headline)
                .foregroundStyle(.secondary)
            Text(withLead > 0 ? "The Lead is handling the rest." : "Approvals, questions and checkpoints from the team appear here.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .accessibilityElement(children: .combine)
    }
}

/// What was decided recently: the outcome, who decided (you, the Lead, a rule, the terminal), and how long
/// it waited.
private struct RecentSection: View {
    @Environment(OfficeStore.self) private var store
    var recent: [InboxRequest]
    @Binding var isExpanded: Bool

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(recent.prefix(20).enumerated()), id: \.element.requestId) { i, r in
                    if i > 0 { Divider() }
                    row(r)
                        .padding(.vertical, 7)
                }
            }
            .padding(.top, 4)
        } label: {
            InspectorHeading(title: "Recent", count: recent.count)
        }
    }

    private func row(_ r: InboxRequest) -> some View {
        let opened = r.openedAt.flatMap(Supervision.parseISODate)
        let resolved = r.resolvedAt.flatMap(Supervision.parseISODate)
        let waited = opened.flatMap { o in resolved.map { Supervision.durationText($0.timeIntervalSince(o)) } } ?? ""
        let who = Supervision.byText(r.by, nameOf: store.displayName)
        let decided = r.by?.kind == "human" ? "You" : r.by?.kind == "agent" ? store.displayName(r.by?.id ?? "lead")
            : r.by?.kind == "policy" ? (r.by?.rule.map { "Rule “\($0)”" } ?? "A rule") : r.by?.kind == "terminal" ? "Terminal" : "System"
        return VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                KindBadge(kind: r.kindInfo, dimmed: true)
                Text(verbatim: r.title)
                    .font(.callout)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(verbatim: Supervision.outcomeText(r) + " · " + who + (r.agentId.map { " · for " + store.displayName($0) } ?? ""))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if !waited.isEmpty {
                Text(verbatim: "Waited \(waited)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(r.title). \(Supervision.outcomeText(r)), decided by \(decided)\(waited.isEmpty ? "" : ", waited \(waited)")")
    }
}
