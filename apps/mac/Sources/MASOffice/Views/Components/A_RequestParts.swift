import AppKit
import MASOfficeKit
import SwiftUI

/// Lays out its children left to right and wraps to a new line when they do not fit (answer buttons in a
/// narrow inspector).
struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0 && x + s.width > width {
                y += line + lineSpacing
                x = 0
                line = 0
            }
            x += s.width + spacing
            widest = max(widest, x - spacing)
            line = max(line, s.height)
        }
        return CGSize(width: proposal.width ?? widest, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX && x + s.width > bounds.maxX {
                y += line + lineSpacing
                x = bounds.minX
                line = 0
            }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            line = max(line, s.height)
        }
    }
}

/// How long a request has waited: nothing in the first minute, then "4 min", "1 h 05 min". The only part of a
/// card that reads the store's 1 s clock, so the tick re-renders just this text.
struct WaitClock: View {
    @Environment(OfficeStore.self) private var store
    var since: Date?

    var body: some View {
        let text = Supervision.waited(since: since, now: store.now)
        if !text.isEmpty {
            Text(verbatim: text)
            .font(.caption.monospacedDigit())
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(.secondary)
            .help(since.map { "Waiting since " + Clock.short($0) } ?? "")
            .accessibilityLabel("Waiting \(text)")
        }
    }
}

/// What a request is about, in full: a complete command, path or tool input in a monospaced, selectable block.
/// Long subjects fold to their first lines with an explicit "Show all 29 lines"; nothing is cut silently.
struct SubjectBlock: View {
    var subject: SubjectView
    @ViewState private var expanded = false

    private static let foldLines = 8
    private static let foldCharacters = 600

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: subject.label)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.04))
            if !subject.text.isEmpty {
                Divider()
                Text(verbatim: expanded || !subject.long ? subject.text : folded)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                if subject.long {
                    Divider()
                    Button {
                        expanded.toggle()
                    } label: {
                        Label(expanded ? "Show less" : "Show all " + moreText,
                              systemImage: expanded ? "chevron.up" : "chevron.down")
                            .font(.caption)
                    }
                    .buttonStyle(.borderless)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .accessibilityHint(expanded ? "Folds the subject" : "Shows the whole subject")
                }
            }
        }
        .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color(nsColor: .textBackgroundColor)))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5))
    }

    /// "29 lines" or "1,240 characters" (the panel's wording).
    private var moreText: String {
        subject.lines > Self.foldLines ? "\(subject.lines) lines" : "\(subject.text.count.formatted()) characters"
    }

    /// The first lines (and at most `foldCharacters`), ending in "…" so it never reads as complete.
    private var folded: String {
        let lines = subject.text.split(separator: "\n", omittingEmptySubsequences: false).prefix(Self.foldLines).joined(separator: "\n")
        let cut = lines.count > Self.foldCharacters ? String(lines.prefix(Self.foldCharacters)) : lines
        return cut + "\n…"
    }
}

/// A command receipt: "Sending…" → "Applied · delivered at the next break" / "Already answered" / "Not sent: …".
struct ReceiptLine: View {
    var receipt: Receipt
    /// What was sent ("Allow once", a reply): shown before the receipt.
    var label: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            icon
            Text(verbatim: (label.map { $0 + " · " } ?? "") + receipt.text)
                .font(.caption)
                .foregroundStyle(receipt.ok ? Tone.good : receipt.isFinal && receipt.state != .conflict ? Tone.bad : .secondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }

    @ViewBuilder
    private var icon: some View {
        if !receipt.isFinal {
            ProgressView().controlSize(.mini).frame(width: 12, height: 10)
        } else if receipt.ok {
            Image(systemName: "checkmark.circle.fill").font(.caption).foregroundStyle(Tone.good)
        } else if receipt.state == .conflict {
            Image(systemName: "info.circle").font(.caption).foregroundStyle(.secondary)
        } else {
            Image(systemName: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(Tone.bad)
        }
    }
}

/// The emoji and name of an agent, plain text.
struct AgentChip: View {
    @Environment(OfficeStore.self) private var store
    var agentId: String

    var body: some View {
        HStack(spacing: 4) {
            if let e = store.structure?.emoji(of: agentId) {
                Text(verbatim: String(e.prefix(2))).accessibilityHidden(true)
            }
            Text(verbatim: store.displayName(agentId)).lineLimit(1)
        }
    }
}

/// The read-only reason, once (no token, no project, connecting).
struct ReadOnlyNote: View {
    var reason: String

    var body: some View {
        Label {
            Text(verbatim: reason).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "lock")
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.primary.opacity(0.05)))
    }
}
