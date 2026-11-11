import MASOfficeKit
import SwiftUI

/// Grouped transcript rows, computed once per transcript change (not per render or per clock tick).
@MainActor
final class TranscriptRowsCache {
    private var key: String?
    private(set) var rows: [TranscriptRow] = []

    static let shownKinds: Set<String> = ["user", "assistant", "thinking", "request", "resolved", "command", "system", "result"]

    func rows(agentId: String, state: TranscriptState?) -> [TranscriptRow] {
        guard let state else { return [] }
        let k = "\(agentId)|\(state.entries.count)|\(state.cursor.consumed)|\(state.loadedAt?.timeIntervalSince1970 ?? 0)"
        if k != key {
            key = k
            rows = TranscriptRow.group(state.entries).filter { row in
                if case .entry(let e) = row { return Self.shownKinds.contains(e.kind) }
                return true
            }
        }
        return rows
    }
}

/// The transcript segment's rows, laid out by the agent page's lazy stack: "Show earlier", then the newest
/// `limit` rows. Long text is selectable and folds with an explicit "Show all".
struct TranscriptRows: View {
    @Environment(OfficeStore.self) private var store
    var agentId: String
    var rows: [TranscriptRow]
    @Binding var limit: Int
    @Binding var expanded: Set<String>

    var body: some View {
        switch store.transcripts[agentId]?.status {
        case nil, .loading?:
            quiet("Loading the transcript…", progress: true)
        case .missing?:
            quiet("No transcript yet. It appears when this agent’s session starts.")
        case .failed(let why)?:
            quiet("The transcript could not be read: \(why)")
        case .ok?:
            if rows.isEmpty {
                quiet("The transcript is empty so far.")
            } else {
                let hidden = max(0, rows.count - limit)
                if hidden > 0 {
                    Button {
                        limit += 200
                    } label: {
                        Label("Show earlier · \(hidden) more", systemImage: "arrow.up")
                    }
                    .buttonStyle(.borderless)
                    .font(.callout)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                }
                ForEach(hidden..<rows.count, id: \.self) { i in
                    TranscriptRowView(agentId: agentId, row: rows[i], index: i, expanded: $expanded)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 5)
                }
            }
        }
    }

    private func quiet(_ text: String, progress: Bool = false) -> some View {
        HStack(spacing: 8) {
            if progress { ProgressView().controlSize(.small) }
            Text(verbatim: text).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .font(.callout)
        .padding(12)
    }
}

/// One transcript row: a time and what happened.
private struct TranscriptRowView: View {
    @Environment(OfficeStore.self) private var store
    var agentId: String
    var row: TranscriptRow
    var index: Int
    @Binding var expanded: Set<String>

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: Clock.time(ts))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
                .frame(width: 50, alignment: .leading)
                .accessibilityHidden(true)
            content
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var ts: String? {
        switch row {
        case .entry(let e): return e.ts
        case .tools(let t): return t.ts
        }
    }

    @ViewBuilder
    private var content: some View {
        switch row {
        case .tools(let t): ToolsRow(tools: t, key: "t\(index)", expanded: $expanded)
        case .entry(let e): entry(e)
        }
    }

    @ViewBuilder
    private func entry(_ e: TranscriptEntry) -> some View {
        let text = e.text ?? ""
        switch e.kind {
        case "user":
            VStack(alignment: .leading, spacing: 4) {
                Text(e.origin == "human" ? "From you" : e.origin == "system" ? "From the system" : "From the Lead")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                LongText(text: text, key: "u\(index)", expanded: $expanded, boxed: true)
            }
        case "assistant":
            MarkdownText(markdown: text)
        case "thinking":
            let key = "h\(index)"
            let open = expanded.contains(key)
            VStack(alignment: .leading, spacing: 4) {
                DisclosureButton(isOpen: open, toggle: { toggle(key) }) {
                    HStack(spacing: 6) {
                        Text("Thinking").font(.callout.weight(.medium)).foregroundStyle(.secondary)
                        if !open {
                            Text(verbatim: PlainText.clip(text, 120)).font(.callout).foregroundStyle(.tertiary).lineLimit(1)
                        }
                    }
                }
                if open { LongText(text: text, key: key + "t", expanded: $expanded, boxed: false).foregroundStyle(.secondary) }
            }
        case "request":
            requestRow(e)
        case "resolved":
            Text(verbatim: "Answered" + (e.outcome.map { ": " + $0 } ?? "") + (e.by.map { " · by " + ($0 == "human" ? "you" : store.displayName($0)) } ?? ""))
                .font(.callout)
                .foregroundStyle(.secondary)
        case "command":
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: e.delivery.map { "Message · " + $0 } ?? "Command")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                if !text.isEmpty {
                    Text(verbatim: PlainText.clip(text, 400)).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
                if let cmdId = e.cmdId {
                    ReceiptLine(receipt: commandReceipt(cmdId, status: e.status))
                }
            }
        case "system":
            Text(verbatim: PlainText.clip(text, 300)).font(.callout).foregroundStyle(.tertiary)
        case "result":
            VStack(alignment: .leading, spacing: 3) {
                let usage = e.usage.map(UsageSummary.init(json:))?.text ?? ""
                Text(verbatim: (e.ok == false ? "Turn ended with an error" : "Turn finished") + (usage.isEmpty ? "" : " · " + usage))
                    .font(.callout)
                    .foregroundStyle(e.ok == false ? Tone.bad : .secondary)
                if e.ok == false, !text.isEmpty { LongText(text: text, key: "r\(index)", expanded: $expanded, boxed: true) }
            }
        default:
            EmptyView()
        }
    }

    private func requestRow(_ e: TranscriptEntry) -> some View {
        let rid = e.requestId ?? ""
        let pending = store.pendingItem(rid)
        let done = store.arrangedInbox.recent.first { $0.requestId == rid }
        let req = pending?.request ?? done
        let state = pending.map { $0.request.routeTo == "human" ? "Waiting on you · answer it in the inbox" : "With the Lead" }
            ?? done.map { Supervision.outcomeText($0) + " · " + Supervision.byText($0.by, nameOf: store.displayName) } ?? ""
        return VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                KindBadge(kind: req?.kindInfo ?? .question, dimmed: pending == nil)
                Text(verbatim: e.title ?? req?.title ?? "").font(.callout.weight(.medium)).fixedSize(horizontal: false, vertical: true)
            }
            if !state.isEmpty {
                Text(verbatim: state).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Color.primary.opacity(0.04)))
    }

    private func commandReceipt(_ cmdId: String, status: String?) -> Receipt {
        let server = store.snapshot.inbox?.command(cmdId)
            ?? status.flatMap { CommandRecord(json: .object(["cmdId": .string(cmdId), "status": .string($0)])) }
        return Supervision.receipt(local: store.localCommands[cmdId], command: server)
    }

    private func toggle(_ key: String) {
        if expanded.contains(key) { expanded.remove(key) } else { expanded.insert(key) }
    }
}

/// A run of calls of one tool: "WebSearch ×4 · summary · 1 failed", expanding to each call and result.
private struct ToolsRow: View {
    var tools: TranscriptRow.Tools
    var key: String
    @Binding var expanded: Set<String>

    var body: some View {
        let open = expanded.contains(key)
        let last = tools.steps.last
        let summary = last?.call?.summary ?? last?.result?.summary ?? ""
        VStack(alignment: .leading, spacing: 6) {
            DisclosureButton(isOpen: open, toggle: { if open { expanded.remove(key) } else { expanded.insert(key) } }) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(verbatim: tools.tool).font(.system(.callout, design: .monospaced).weight(.medium))
                    if tools.count > 1 {
                        Text(verbatim: "×\(tools.count)").font(.callout.monospacedDigit()).foregroundStyle(.secondary)
                    }
                    if !summary.isEmpty {
                        Text(verbatim: PlainText.clip(summary, 140)).font(.callout).foregroundStyle(.secondary).lineLimit(1)
                    }
                    if tools.failed > 0 {
                        Text(verbatim: "\(tools.failed) failed").font(.caption.weight(.semibold)).foregroundStyle(Tone.bad)
                    }
                    if tools.running > 0 {
                        ProgressView().controlSize(.mini)
                        Text("running").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .accessibilityLabel("\(tools.tool), \(tools.count) \(tools.count == 1 ? "call" : "calls")\(tools.failed > 0 ? ", \(tools.failed) failed" : "")")
            if open {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(tools.steps.enumerated()), id: \.offset) { j, step in
                        stepView(step, j)
                    }
                }
                .padding(.leading, 14)
            }
        }
    }

    private func stepView(_ s: TranscriptRow.Step, _ j: Int) -> some View {
        let failed = s.result?.ok == false
        return VStack(alignment: .leading, spacing: 4) {
            if let call = s.call {
                labelled("Call", PlainText.clip(call.summary, 200))
                if let input = call.input, !input.isNull {
                    LongText(text: input.string ?? input.prettyText, key: "\(key):in:\(j)", expanded: $expanded, boxed: true)
                }
            }
            if let result = s.result {
                labelled(failed ? "Failed" : "Result", PlainText.clip(result.summary, 200), bad: failed)
                if let t = result.text, !t.isEmpty {
                    LongText(text: t, key: "\(key):out:\(j)", expanded: $expanded, boxed: true)
                }
            } else {
                Text("No result yet.").font(.caption).foregroundStyle(.tertiary)
            }
        }
        .padding(.leading, 8)
        .overlay(alignment: .leading) {
            Rectangle().fill(failed ? Tone.bad.opacity(0.6) : Color(nsColor: .separatorColor)).frame(width: 2)
        }
    }

    private func labelled(_ k: String, _ v: String, bad: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(verbatim: k).font(.caption.weight(.semibold)).foregroundStyle(bad ? Tone.bad : .secondary)
            Text(verbatim: v).font(.callout).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        }
    }
}

/// A chevron button that opens and closes a row.
private struct DisclosureButton<Label: View>: View {
    var isOpen: Bool
    var toggle: () -> Void
    @ViewBuilder var label: () -> Label

    var body: some View {
        Button(action: toggle) {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(isOpen ? 90 : 0))
                label()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(isOpen ? "expanded" : "collapsed")
    }
}

/// Monospaced, selectable text that folds after 10 lines or 700 characters with an explicit "Show all".
struct LongText: View {
    var text: String
    var key: String
    @Binding var expanded: Set<String>
    var boxed: Bool

    var body: some View {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let long = text.count > 700 || lines.count > 10
        let open = expanded.contains(key)
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: long && !open ? String(lines.prefix(10).joined(separator: "\n").prefix(700)) + "\n…" : text)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if long {
                Button(open ? "Show less" : "Show all \(lines.count > 10 ? "\(lines.count) lines" : "\(text.count.formatted()) characters")") {
                    if open { expanded.remove(key) } else { expanded.insert(key) }
                }
                .buttonStyle(.borderless)
                .font(.caption)
            }
        }
        .padding(boxed ? 8 : 0)
        .background {
            if boxed {
                RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color(nsColor: .textBackgroundColor))
                    .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5))
            }
        }
    }
}
