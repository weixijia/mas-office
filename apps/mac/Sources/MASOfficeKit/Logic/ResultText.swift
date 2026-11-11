import Foundation

/// What a claim popover shows: the claim's status, its verdicts, and the cited sources with their evidence grade
/// and link health (the panel's `claimCardHtml`). Grade and verdict are different things.
public struct ClaimDetail: Sendable, Hashable, Identifiable {
    public struct CitedSource: Sendable, Hashable, Identifiable {
        public var sourceId: String
        public var title: String
        /// http(s) only.
        public var url: URL?
        public var grade: EvidenceGrade?
        public var health: URLHealth?
        public var httpStatus: Int?
        public var id: String { sourceId }
    }
    public var claimId: String
    public var text: String
    public var status: ClaimStatus
    /// Display name of the agent that made the claim.
    public var author: String?
    public var verdicts: [Verification.Verdict]
    public var sources: [CitedSource]
    public var id: String { claimId }

    /// The detail for a claim id, or nil when the verification does not list it. Cited sources come from the
    /// claim's own list, else from the tag's `src`.
    public init?(claimId: String, tagSources: [String] = [], verification: Verification?, result: ResultDoc?) {
        guard let c = verification?.claim(claimId) else { return nil }
        self.claimId = claimId
        text = c.text
        status = c.status
        author = c.author
        verdicts = c.verdicts
        let ids = c.sources.isEmpty ? tagSources : c.sources
        sources = ids.map { sid in
            let ev = verification?.evidence(for: sid)
            let rs = result?.sources.first { $0.id == sid }
            let raw = ev?.url ?? rs?.url
            return CitedSource(sourceId: sid, title: rs?.title ?? raw ?? sid, url: raw.flatMap(Markdown.safeURL),
                               grade: ev?.grade ?? rs?.evidence, health: ev?.urlHealth, httpStatus: ev?.httpStatus)
        }
    }
}

/// "What the checkers caught": contradicted and unknown claims, and reviews that sent work back or up.
public struct CheckersCaught: Sendable, Hashable {
    public struct Item: Sendable, Hashable, Identifiable {
        public enum Kind: String, Sendable, Hashable { case contradicted, unknown, sentBack, escalated }
        public var id: String
        public var kind: Kind
        /// "contradicted", "unknown", "sent back", "escalated".
        public var word: String
        public var text: String
        /// "Catch checker: The listing shows £249 + £15 postage." (names resolved by the caller).
        public var notes: [String]
        public var claimId: String?
    }
    public var items: [Item]

    public init(verification: Verification?, board: Board?, nameOf: (String) -> String) {
        var out: [Item] = []
        for c in verification?.caughtClaims ?? [] {
            let notes = c.verdicts.compactMap { v in v.note.map { "\(nameOf(v.by ?? "")): \($0)" } }
            out.append(Item(id: "claim:" + c.claimId, kind: c.status == .contradicted ? .contradicted : .unknown, word: c.status.word,
                            text: c.text, notes: notes, claimId: c.claimId))
        }
        for (k, r) in (board?.reviews ?? []).enumerated() where r.verdict == "revise" || r.verdict == "escalate" {
            let escalate = r.verdict == "escalate"
            let who = "\(nameOf(r.reviewer ?? "")) on \(nameOf(r.target))" + (r.round > 1 ? " (round \(r.round))" : "")
            out.append(Item(id: "review:\(k)", kind: escalate ? .escalated : .sentBack, word: escalate ? "escalated" : "sent back",
                            text: who, notes: r.note.map { [$0] } ?? [], claimId: nil))
        }
        items = out
    }
}

/// A source as the Sources list shows it.
public struct SourceRow: Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var url: URL?
    public var grade: EvidenceGrade
    public var foundBy: String?
    public var health: URLHealth?
    public var httpStatus: Int?

    public static func rows(result: ResultDoc?, verification: Verification?, nameOf: (String) -> String) -> [SourceRow] {
        var seen = Set<String>()
        return (result?.sources ?? []).compactMap { s in
            let key = s.id.isEmpty ? (s.url ?? s.title ?? "") : s.id
            guard seen.insert(key).inserted else { return nil }
            let ev = verification?.evidence(for: s.id)
            return SourceRow(id: key, title: s.title ?? s.url ?? s.id, url: (s.url ?? ev?.url).flatMap(Markdown.safeURL),
                             grade: s.evidence, foundBy: s.foundBy.map(nameOf), health: ev?.urlHealth, httpStatus: ev?.httpStatus)
        }
    }
}

/// The result as a Markdown file: title, rounds (claim tags stripped), checked-claims line, flags, sources.
public enum ResultExport {
    public static func markdown(_ r: ResultDoc, verification: Verification?, nameOf: (String) -> String) -> String {
        var out: [String] = []
        let rounds = r.rounds
        out.append("# " + oneLine(r.title ?? "Result"))
        if let v = verification, v.summary.claims > 0 {
            out.append("")
            out.append("_Checked claims: \(Credibility(v.summary).text)_")
        }
        for x in rounds {
            out.append("")
            if rounds.count > 1 {
                out.append("## Round \(x.round)" + (x.round == 1 && x.question.isEmpty ? "" : " · Follow-up"))
                if !x.question.isEmpty { out.append("> You asked: " + oneLine(x.question)) }
                if !x.title.isEmpty, x.title != r.title { out.append("**" + oneLine(x.title) + "**") }
                out.append("")
            }
            out.append(ClaimTags.stripped(x.markdown).trimmingCharacters(in: .whitespacesAndNewlines))
        }
        if !r.flags.isEmpty {
            out += ["", "## Flags"]
            out += r.flags.map { "- " + oneLine($0.text) + ($0.by.map { " (\(nameOf($0)))" } ?? "") }
        }
        let rows = SourceRow.rows(result: r, verification: verification, nameOf: nameOf)
        if !rows.isEmpty {
            out += ["", "## Sources"]
            out += rows.map { s in
                var line = "- [\(s.grade.rawValue)] "
                line += s.url.map { "[\(oneLine(s.title))](\($0.absoluteString))" } ?? oneLine(s.title)
                var extra: [String] = []
                if let f = s.foundBy { extra.append("found by \(f)") }
                if let h = s.health { extra.append("link \(h.word)") }
                return line + (extra.isEmpty ? "" : " — " + extra.joined(separator: ", "))
            }
            out.append("")
            out.append("Evidence grades: " + EvidenceGrade.allCases.map { "\($0.rawValue) \($0.meaning.lowercased())" }.joined(separator: " · ") + ".")
        }
        return out.joined(separator: "\n") + "\n"
    }

    /// A file name for the export: the title without path or control characters, at most 80 characters.
    public static func fileName(_ title: String?) -> String {
        let bad = CharacterSet(charactersIn: "/\\:?%*|\"<>").union(.controlCharacters).union(.newlines)
        var s = String((title ?? "Result").unicodeScalars.map { bad.contains($0) ? "-" : Character($0) })
        s = s.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ".-")))
        if s.isEmpty { s = "Result" }
        return String(s.prefix(80)) + ".md"
    }

    static func oneLine(_ s: String) -> String {
        s.split(whereSeparator: \.isNewline).joined(separator: " ")
    }
}

/// Run status lines (the panel's `ledgerLine`, `usageTotal`) and stage progress.
public enum RunInfo {
    /// "Progressing · next: Catch checker · 1 stall", or "".
    public static func ledgerLine(_ ledger: Board.Ledger?, nameOf: (String) -> String) -> String {
        guard let l = ledger else { return "" }
        let next = l.next.map { "next: " + nameOf($0) } ?? ""
        let stalls = (l.stalls ?? 0) > 0 ? "\(l.stalls!) " + (l.stalls == 1 ? "stall" : "stalls") : ""
        return [l.word, next, stalls].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// 1234 → "1.2k", 12345 → "12k", 1_234_567 → "1.2M".
    public static func compact(_ n: Double) -> String {
        if n >= 1e6 { return String(format: n >= 1e7 ? "%.0fM" : "%.1fM", n / 1e6) }
        if n >= 1e3 { return String(format: n >= 1e4 ? "%.0fk" : "%.1fk", n / 1e3) }
        return String(Int(n.rounded()))
    }

    public struct UsageTotal: Sendable, Hashable {
        /// "54k tokens · $1.12 across 4 agents"
        public var text: String
        public var tokens: Double
        public var cost: Double
        /// Agents whose backend reported a usage limit state other than `allowed`, with the warning.
        public var warnings: [Warning]
        public struct Warning: Sendable, Hashable { public var agentId: String; public var text: String }
    }

    /// "Usage limit: allowed warning · resets …" for one agent, or nil when the limit is fine or unknown.
    public static func limitWarning(_ u: Board.Usage) -> String? {
        guard let lim = u.limit, let status = lim.string("status"), status != "allowed" else { return nil }
        return "Usage limit: " + status.replacingOccurrences(of: "_", with: " ") + (lim.string("resetsAt").map { " · resets \($0)" } ?? "")
    }

    public static func usageTotal(_ usage: [String: Board.Usage]) -> UsageTotal? {
        guard !usage.isEmpty else { return nil }
        var tokens = 0.0, cost = 0.0
        var warnings: [UsageTotal.Warning] = []
        for id in usage.keys.sorted() {
            let u = usage[id]!
            tokens += max(0, u.inputTokens) + max(0, u.outputTokens)
            cost += max(0, u.costUsd)
            if let w = limitWarning(u) { warnings.append(.init(agentId: id, text: w)) }
        }
        let n = usage.count
        let text = compact(tokens) + " tokens" + (cost > 0 ? String(format: " · $%.2f", cost) : "") + " across \(n) " + (n == 1 ? "agent" : "agents")
        return UsageTotal(text: text, tokens: tokens, cost: cost, warnings: warnings)
    }

    public struct Stage: Sendable, Hashable, Identifiable {
        public var id: String
        /// 1-based position in run order.
        public var number: Int
        public var label: String
        public var memberIds: [String]
        public var done: Int
        public var busy: Int
        public var needsYou: Int
        public var isComplete: Bool { !memberIds.isEmpty && done == memberIds.count }
    }

    /// The stages in run order with how many of their roles are done, busy, or waiting on you.
    public static func stages(_ s: Structure?, statuses: [String: AgentStatus]) -> [Stage] {
        guard let s else { return [] }
        return s.orderedGroups.enumerated().map { k, g in
            let ids = s.members(ofGroup: g.id).map(\.id)
            let sts = ids.map { statuses[$0] }
            return Stage(id: g.id, number: k + 1, label: g.label?.isEmpty == false ? g.label! : "Stage \(k + 1)", memberIds: ids,
                         done: sts.filter { $0?.state == .done }.count, busy: sts.filter { $0?.state.isBusy == true }.count,
                         needsYou: sts.filter { $0?.needsYou == true }.count)
        }
    }

    /// When the current run started: the earliest task assignment on the board.
    public static func startedAt(_ board: Board?) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let g = ISO8601DateFormatter()
        return (board?.tasks ?? []).compactMap { $0.assignedAt }.compactMap { f.date(from: $0) ?? g.date(from: $0) }.min()
    }

    /// "45 s", "12 min", "1 h 05 min".
    public static func elapsedText(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        if s < 60 { return "\(s) s" }
        if s < 3600 { return "\(s / 60) min" }
        return String(format: "%d h %02d min", s / 3600, (s % 3600) / 60)
    }

    /// The backends the team runs on (each member's, `claude-code` by default), in a stable order.
    public static func backendsUsed(_ s: Structure?) -> [String] {
        guard let s else { return [] }
        var seen = Set<String>()
        return ([s.lead.backend ?? "claude-code"] + s.roles.map { $0.backend ?? "claude-code" }).filter { seen.insert($0).inserted }
    }

    /// "5 sessions: 4 on Claude Code, 1 on Codex, each on your own sign-in."
    public static func sessionsText(_ s: Structure?) -> String {
        guard let s else { return "" }
        let all = [s.lead.backend ?? "claude-code"] + s.roles.map { $0.backend ?? "claude-code" }
        let parts = backendsUsed(s).map { b in "\(all.filter { $0 == b }.count) on \(BackendStatus.label(b))" }
        let n = all.count
        return "\(n) " + (n == 1 ? "session" : "sessions") + ": " + parts.joined(separator: ", ") + ", each on your own sign-in."
    }

    /// Why a new run cannot start, or nil when it can. `session` is what the engine reported.
    public static func startBlocker(session: SessionInfo?, actReason: String?, structure: Structure?, runActive: Bool) -> String? {
        if let actReason { return actReason }
        guard let session else { return "Connecting to the MAS Office engine…" }
        if !session.runtime { return "This engine only shows the office; it cannot run the team." }
        guard let s = structure else { return "This project has no team design yet." }
        if !s.locked { return "Lock the team design before running it." }
        if runActive { return "A run is in progress." }
        let missing = backendsUsed(s).filter { b in session.backends[b].map { !$0.ready } ?? false }
        if let b = missing.first, let st = session.backends[b] {
            let cmd = BackendStatus.signInCommand(b).map { ": run \($0) in Terminal" } ?? ""
            return "\(BackendStatus.label(b)) is \(st.summary)" + (st.available ? cmd : "") + "."
        }
        return nil
    }
}
