import Foundation

// Rules behind the native supervision views (inbox cards, agent page, Stop, notifications, the menu bar), kept
// here so they are checked by MASOfficeChecks and follow `panel/inbox.js` / `panel/app.js` where the panel has
// the same rule. No clock and no I/O: callers pass `now`.

// MARK: - Requests

extension InboxRequest {
    /// A prompt raised by a terminal hook with no options: only that terminal can answer it (the engine refuses
    /// an answer from here with 409 `answer_in_terminal`).
    public var answeredInTerminalOnly: Bool {
        options.isEmpty && kind != "gate" && (source?.string("raw")?.hasPrefix("hook:") ?? false)
    }
}

extension RequestKind {
    /// "Approval", "Question", "Decision", "Flag", "Checkpoint" (a gate reads as a checkpoint).
    public var label: String { self == .gate ? "Checkpoint" : word }
}

/// What a request card offers: its buttons, the one the Return key may press, the A / D pair, and the reply field.
public struct RequestActions: Sendable, Hashable {
    public enum Reply: Sendable, Hashable {
        /// Only the terminal can answer (no field, no buttons).
        case none
        /// A typed answer ("Or reply in a sentence" · Send).
        case reply
        /// A checkpoint: send it back with a note, through its revise option when it has one.
        case sendBack(RequestOption?)
    }

    /// Buttons in the request's order. A checkpoint's revise option is not a button: it is the "Send back" of
    /// the note field.
    public var buttons: [AnswerOption]
    /// The option Return may press: the first `allow_once` kind (a checkpoint's Accept). Never a standing rule,
    /// never a reject. Nil when the request has none.
    public var primary: RequestOption?
    /// The A / D keys: exactly one `allow_once` and one `reject_once` option.
    public var quickAllow: RequestOption?
    public var quickReject: RequestOption?
    public var reply: Reply
    public var terminalOnly: Bool

    public init(_ request: InboxRequest) {
        terminalOnly = request.answeredInTerminalOnly
        let all = Supervision.answerOptions(request)
        if terminalOnly {
            buttons = []
            reply = .none
        } else if request.kind == "gate" {
            let revise = all.first(where: \.needsText)
            buttons = all.filter { !$0.needsText }
            reply = .sendBack(revise?.option)
        } else {
            buttons = all
            reply = .reply
        }
        primary = buttons.first { $0.option.kind == "allow_once" }?.option
        let pair = terminalOnly ? nil : Supervision.quickPair(request)
        quickAllow = pair?.allow
        quickReject = pair?.reject
    }

    /// "Or reply in a sentence", "What should change?".
    public var replyPlaceholder: String {
        switch reply {
        case .sendBack: return "What should change?"
        default: return "Or reply in a sentence"
        }
    }

    /// "Send", "Send back".
    public var replyButton: String {
        switch reply {
        case .sendBack: return "Send back"
        default: return "Send"
        }
    }

    /// Simple enough to answer from a notification or the menu bar: the A / D pair.
    public var hasQuickPair: Bool { quickAllow != nil && quickReject != nil }
}

extension Supervision {
    /// While an answer from here is on its way or settled, the card takes no other answer (the panel's
    /// `locked`): not final yet, applied/accepted, or already answered elsewhere. A failed or refused answer
    /// unlocks it.
    public static func isAnswerLocked(_ receipt: Receipt?) -> Bool {
        guard let r = receipt else { return false }
        return !r.isFinal || r.ok || r.state == .conflict
    }

    // MARK: Stop

    /// The content of a status that a Stop must change (the panel's `statusKey` plus `stopReason`).
    public static func statusKey(_ s: AgentStatus?) -> String {
        guard let s else { return "" }
        let base = [s.state.rawValue, s.say ?? "", s.to ?? "", s.flag ?? ""].joined(separator: "|")
        return base + (s.flagKind.map { "|" + $0 } ?? "") + "|" + (s.stopReason ?? "")
    }

    /// A Stop is "requested" until the agent's status really changes (accepted is not stopped); "refused" when
    /// the command failed. The panel's `stopState`.
    public static func stopState(_ stop: StopRecord?, local: LocalCommand?, command: CommandRecord?, keyNow: String,
                                 stopReason: String?) -> StopState? {
        guard let stop else { return nil }
        let r = receipt(local: local, command: command)
        if r.isFinal && !r.ok { return StopState(phase: .refused, text: "Stop not done: " + r.text) }
        if stopReason == "cancelled" || keyNow != stop.key { return StopState(phase: .stopped, text: "Stopped") }
        return StopState(phase: .requested,
                         text: "Stop requested" + (r.state == .applied || r.state == .accepted ? " · waiting for the agent to stop" : ""))
    }
}

/// A Stop this app sent: its command and the agent's status key when it was pressed.
public struct StopRecord: Sendable, Hashable {
    public var cmdId: String
    public var key: String
    public var at: Date
    /// When the status was first seen changed (the "Stopped" line clears a while after).
    public var stoppedAt: Date?

    public init(cmdId: String, key: String, at: Date, stoppedAt: Date? = nil) {
        self.cmdId = cmdId
        self.key = key
        self.at = at
        self.stoppedAt = stoppedAt
    }
}

public struct StopState: Sendable, Hashable {
    public enum Phase: String, Sendable { case requested, stopped, refused }
    public var phase: Phase
    /// "Stop requested", "Stop requested · waiting for the agent to stop", "Stopped", "Stop not done: …".
    public var text: String
}

// MARK: - Text helpers (the panel's oneLine / clip)

public enum PlainText {
    /// Newlines and the spaces around them become one space; trimmed.
    public static func oneLine(_ s: String?) -> String {
        guard let s else { return "" }
        var out = ""
        var pendingBreak = false
        for line in s.split(separator: "\n", omittingEmptySubsequences: false) {
            let t = line.trimmingCharacters(in: .whitespaces)
            if pendingBreak, !out.isEmpty { out += " " }
            out += t
            pendingBreak = true
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// One line of at most `n` characters, with an ellipsis when cut.
    public static func clip(_ s: String?, _ n: Int) -> String {
        let x = oneLine(s)
        return x.count > n ? String(x.prefix(max(0, n - 1))) + "…" : x
    }
}

// MARK: - Agent page

/// Usage as the backend reported it, in a line, with a limit warning (the panel's `usageInfo`).
public struct UsageSummary: Sendable, Hashable {
    /// "12.4k in · 3.1k out · $0.42 · 6 turns" (parts that are zero are left out).
    public var text: String
    /// "Usage limit: allowed warning · resets …" when the backend reported a limit state other than `allowed`.
    public var warning: String?
    public var tokens: Double
    public var cost: Double

    /// JS `Number.prototype.toFixed` for non-negative numbers: rounds the exact binary value, and an exact
    /// half goes up (printf would round it to even: 1.125 → "1.12" where JS says "1.13").
    public static func toFixed(_ x: Double, _ digits: Int) -> String {
        let plain = String(format: "%.\(digits)f", x)
        guard x.isFinite, x >= 0 else { return plain }
        let exact = String(format: "%.120f", x)
        guard let dot = exact.firstIndex(of: ".") else { return plain }
        let frac = exact[exact.index(after: dot)...]
        let tail = frac.dropFirst(digits)
        guard tail.first == "5", tail.dropFirst().allSatisfy({ $0 == "0" }) else { return plain }
        // An exact tie: round the truncated value up by one unit in the last place.
        let truncated = String(exact[..<dot]) + frac.prefix(digits)
        guard let n = Int(truncated) else { return plain }
        let up = String(n + 1)
        let padded = String(repeating: "0", count: max(0, digits + 1 - up.count)) + up
        return digits == 0 ? padded : String(padded.dropLast(digits)) + "." + String(padded.suffix(digits))
    }

    /// "12.4k", "310", "1.2M".
    public static func compact(_ n: Double) -> String {
        let fixed = UsageSummary.toFixed
        if n >= 1e6 { return fixed(n / 1e6, n >= 1e7 ? 0 : 1) + "M" }
        if n >= 1e3 { return fixed(n / 1e3, n >= 1e4 ? 0 : 1) + "k" }
        return String(Int(n.rounded()))
    }

    /// From a usage object as written (a board entry or a transcript `result` entry's `usage`).
    public init(json u: JSONValue) {
        self.init(Board.Usage(inputTokens: u.double("inputTokens") ?? 0, outputTokens: u.double("outputTokens") ?? 0,
                              costUsd: u.double("costUsd") ?? 0, turns: u.double("turns") ?? 0, limit: u.objectValue("limit"),
                              updated: u.string("updated")))
    }

    public init(_ u: Board.Usage) {
        func ok(_ x: Double) -> Double { x.isFinite && x >= 0 ? x : 0 }
        let input = ok(u.inputTokens), output = ok(u.outputTokens), cost = ok(u.costUsd), turns = ok(u.turns)
        var parts: [String] = []
        if input != 0 || output != 0 { parts.append(Self.compact(input) + " in · " + Self.compact(output) + " out") }
        if cost != 0 { parts.append("$" + Self.toFixed(cost, 2)) }
        if turns != 0 {
            let t = turns == turns.rounded() ? String(Int(turns)) : String(turns)
            parts.append(t + (turns == 1 ? " turn" : " turns"))
        }
        text = parts.joined(separator: " · ")
        if let status = u.limit?.string("status"), status != "allowed" {
            warning = "Usage limit: " + status.replacingOccurrences(of: "_", with: " ")
                + (u.limit?.string("resetsAt").map { " · resets " + $0 } ?? "")
        } else {
            warning = nil
        }
        tokens = input + output
        self.cost = cost
    }
}

/// The three layers of the agent page: what it is doing, why, and what comes next with how sure we can be
/// (the panel's `stripHtml`).
public struct AgentStrip: Sendable, Hashable {
    public var doing: [String]
    public var why: [String]
    public var next: [String]

    /// The agent's latest task on the board.
    public static func lastTask(_ agentId: String, board: Board?) -> Board.TaskItem? {
        board?.tasks.last { $0.agentId == agentId }
    }

    /// "Satisfied · next: Catch checker · 2 stalls" (the panel's `ledgerLine`).
    public static func ledgerLine(_ l: Board.Ledger?, nameOf: (String) -> String) -> String {
        guard let l else { return "" }
        let next = l.next.map { "next: " + nameOf($0) } ?? ""
        let stalls = l.stalls.flatMap { $0 > 0 ? "\($0)" + ($0 == 1 ? " stall" : " stalls") : nil } ?? ""
        return [l.word, next, stalls].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    public init(agentId id: String, structure s: Structure?, status: AgentStatus?, board: Board?, result: ResultDoc?,
                verification: Verification?, entries: [TranscriptEntry], nameOf: (String) -> String) {
        let st = status ?? AgentStatus()
        let task = Self.lastTask(id, board: board)
        let tool = TranscriptRow.currentTool(entries)
        var doing: [String] = []
        if st.state == .flagged, let f = st.flag { doing.append(f) } else if let say = st.say { doing.append(say) } else {
            doing.append(st.state == .idle ? "Idle" : st.stateLabel)
        }
        if let tool { doing.append("Using " + tool.tool + (tool.summary.map { $0.isEmpty ? "" : ": " + $0 } ?? "")) }

        var why: [String] = []
        if let task {
            let title = task.title
            if let brief = task.brief, !brief.isEmpty {
                let head = PlainText.oneLine(title).replacingOccurrences(of: "…", with: "", options: [.anchored, .backwards])
                why.append(PlainText.oneLine(brief).hasPrefix(head) ? PlainText.clip(brief, 260) : title + " — " + PlainText.clip(brief, 220))
            } else {
                why.append(title)
            }
        }
        if id == "lead", let l = board?.ledger {
            if let i = l.instruction, !i.isEmpty { why.append(i) }
            let plan = l.plan.filter { !$0.isEmpty }.prefix(6)
            if !plan.isEmpty { why.append("Plan: " + plan.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "  ")) }
            if let r = l.reason, !r.isEmpty { why.append(r) }
        }
        if why.isEmpty {
            let job = id == "lead" ? s?.lead.job : s?.role(id)?.job
            if let job, !job.isEmpty { why.append(job) }
        }

        var next: [String] = []
        if id == "lead" {
            let l = Self.ledgerLine(board?.ledger, nameOf: nameOf)
            if !l.isEmpty { next.append(l) }
        } else if let role = s?.role(id) {
            next.append("Then hands to " + nameOf(role.handsTo))
        }
        var latest: [String: Board.Review] = [:]
        var order: [String] = []
        for r in board?.reviews ?? [] where r.target == id {
            guard let rv = r.reviewer else { continue }
            if latest[rv] == nil { order.append(rv) }
            latest[rv] = r
        }
        for rv in order {
            guard let r = latest[rv] else { continue }
            let verdict = r.verdict == "revise" ? "sent it back" : r.verdict == "escalate" ? "passed it up to you" : "accepted"
            next.append(nameOf(rv) + ": " + verdict + (r.round > 1 ? " (round \(r.round))" : "")
                        + (r.note.map { $0.isEmpty ? "" : " — " + PlainText.clip($0, 160) } ?? ""))
        }
        let sources = (result?.sources ?? []).filter { $0.foundBy == id }
        if !sources.isEmpty {
            let grades = sources.map(\.evidence.rawValue).sorted().joined(separator: " ")
            let dead = sources.filter { verification?.evidence(for: $0.id)?.urlHealth == .hallucinated }.count
            next.append("Evidence grades of its sources: " + grades + (dead > 0 ? " · \(dead) dead " + (dead == 1 ? "link" : "links") : ""))
        }
        self.doing = doing
        self.why = why
        self.next = next
    }
}

// MARK: - Notifications

/// One system notification to show for an agent that waits on you.
public struct AttentionNotice: Sendable, Hashable {
    public var agentId: String
    /// The request it is about (the agent's first, in inbox order).
    public var requestId: String
    /// The wait episode (`Supervision.waitKey`): one notification per episode.
    public var episode: String
    /// "Retail finder needs you".
    public var title: String
    /// "Approval · holds up Catch checker and Lead".
    public var subtitle: String
    /// The request's title, "+ 1 more" when the agent waits on several.
    public var body: String
    /// Only `urgency: high` may make a sound.
    public var sound: Bool
    /// Set when the request offers exactly one allow-once and one reject-once option: the notification gets
    /// "Allow once" and "Deny" buttons.
    public var allowOptionId: String?
    public var rejectOptionId: String?
}

/// What to show and what to take away, one tick at a time (the panel's `notifyTick`).
public struct AttentionPlan: Sendable, Hashable {
    public var post: [AttentionNotice]
    /// Agents whose delivered notification should go: they no longer wait, or the request it was about is
    /// resolved.
    public var remove: [String]

    /// - Parameters:
    ///   - delivered: agent id → the request id its delivered notification is about.
    ///   - notified: wait episodes already notified.
    public static func make(human: [PendingItem], now: Date, enabled: Bool, permitted: Bool, hidden: Bool,
                            notified: Set<String>, delivered: [String: String], nameOf: (String) -> String) -> AttentionPlan {
        let waiting = Supervision.waitingAgents(human)
        let waitingIds = Set(waiting.map(\.id))
        let pendingIds = Set(human.map(\.request.requestId))
        let remove = delivered.filter { !waitingIds.contains($0.key) || !pendingIds.contains($0.value) }.map(\.key).sorted()
        var post: [AttentionNotice] = []
        for w in waiting {
            let episode = Supervision.waitKey(w.id, since: w.since)
            let waited = w.since.map { now.timeIntervalSince($0) }
            guard Supervision.shouldNotify(enabled: enabled, permitted: permitted, hidden: hidden, blocking: true, routeTo: "human",
                                           waited: waited, alreadyNotified: notified.contains(episode)),
                  let first = w.requestIds.first, let item = human.first(where: { $0.request.requestId == first }) else { continue }
            let r = item.request
            let actions = RequestActions(r)
            let holds = Supervision.holdsUpText(item.holds.map(nameOf))
            let more = w.requestIds.count - 1
            post.append(AttentionNotice(
                agentId: w.id, requestId: r.requestId, episode: episode, title: nameOf(w.id) + " needs you",
                subtitle: [r.kindInfo.label, holds.isEmpty ? "" : holds.prefix(1).lowercased() + holds.dropFirst()]
                    .filter { !$0.isEmpty }.joined(separator: " · "),
                body: r.title + (more > 0 ? " (+ \(more) more)" : ""), sound: r.urgency == .high,
                allowOptionId: actions.hasQuickPair ? actions.quickAllow?.optionId : nil,
                rejectOptionId: actions.hasQuickPair ? actions.quickReject?.optionId : nil))
        }
        return AttentionPlan(post: post, remove: remove)
    }
}

// MARK: - Run line (menu bar)

public enum RunLine {
    /// "0:07", "12:03", "1:02:03" (the panel's `formatClock`).
    public static func clock(_ seconds: TimeInterval) -> String {
        let t = Int(max(0, seconds.isFinite ? seconds : 0).rounded(.down))
        let h = t / 3600, m = (t / 60) % 60, s = String(format: "%02d", t % 60)
        return h > 0 ? "\(h):" + String(format: "%02d", m) + ":" + s : "\(m):" + s
    }

    /// "3 of 4 working · 12:04" while a run goes (the clock counts from the run's first task), else where the
    /// project stands: "Run finished", "Run failed", "Team ready", "No team yet".
    public static func text(structure: Structure?, statuses: [String: AgentStatus], state: ProjectState?, board: Board?, now: Date) -> String {
        guard let s = structure else { return "No team yet" }
        let members = s.memberIds
        let busy = members.filter { statuses[$0]?.state.isBusy == true }.count
        if state?.isRunning == true || busy > 0 {
            let start = (board?.tasks ?? []).compactMap { $0.assignedAt.flatMap(Supervision.parseISODate) }.min()
            return "\(busy) of \(members.count) working" + (start.map { " · " + clock(now.timeIntervalSince($0)) } ?? "")
        }
        switch state?.phase {
        case "done": return "Run finished"
        case "failed": return "Run failed"
        default: return s.locked ? "Team ready" : "Team being designed"
        }
    }
}
