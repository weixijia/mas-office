import Foundation

// Pure supervision logic ported from `panel/inbox.js` so the native views follow the same rules as the web
// panel: wait clocks, what a request holds up, sorting, who waits on you, answers and command receipts.
// No clock and no I/O: callers pass `now`. Parity with the JS functions is checked by MASOfficeChecks.

/// A pending request as the inbox shows it: when it started waiting and whom it holds up.
public struct PendingItem: Sendable, Hashable, Identifiable {
    public var request: InboxRequest
    /// When it started waiting (see `Supervision.since`); nil when unknown.
    public var since: Date?
    /// Agent ids it holds up besides the asker, the Lead last.
    public var holds: [String]
    public var id: String { request.requestId }

    public init(request: InboxRequest, since: Date?, holds: [String]) {
        self.request = request
        self.since = since
        self.holds = holds
    }
}

/// The inbox as the views show it.
public struct ArrangedInbox: Sendable, Hashable {
    /// Needs you, sorted: urgency, blocking, how many it holds up, oldest first.
    public var human: [PendingItem]
    /// Routed to the Lead or another agent first: shown dimmed until escalated or resolved.
    public var withLead: [PendingItem]
    /// Newest first.
    public var recent: [InboxRequest]

    public static let empty = ArrangedInbox(human: [], withLead: [], recent: [])
}

/// An agent with a blocking request that needs you.
public struct WaitingAgent: Sendable, Hashable, Identifiable {
    public var id: String
    public var since: Date?
    public var urgency: Int
    public var count: Int
    public var requestIds: [String]
}

/// One button for a request.
public struct AnswerOption: Sendable, Hashable, Identifiable {
    public enum Tone: String, Sendable { case allow, reject, choice }
    public var option: RequestOption
    /// A gate's "revise" needs text to go with it.
    public var needsText: Bool
    public var tone: Tone
    /// A standing rule ("allow always").
    public var always: Bool
    public var id: String { option.optionId }
}

/// What a request is about, ready to show (folded when long).
public struct SubjectView: Sendable, Hashable {
    public var type: String
    public var label: String
    public var text: String
    public var lines: Int
    public var long: Bool
}

/// Command receipt states: what this app knows locally (`sending`, `sent`, `conflict`, `failed`) and what
/// the server recorded (`accepted`, `applied`, `rejected`, `unsupported`, `expired`).
public enum ReceiptState: String, Sendable, Codable, Hashable, CaseIterable {
    case sending, sent, accepted, applied, rejected, unsupported, expired, conflict, failed

    var rank: Int {
        switch self {
        case .sending: return 0
        case .sent: return 1
        case .accepted: return 2
        default: return 3
        }
    }

    /// A final state never changes again.
    public var isFinal: Bool { rank == 3 }
}

/// A receipt as shown next to a message or an answer.
public struct Receipt: Sendable, Hashable {
    public var state: ReceiptState
    public var reason: String?
    public var isFinal: Bool
    /// Applied or accepted.
    public var ok: Bool
    /// "Sending…", "Applied · delivered at the next break", "Already answered", …
    public var text: String
}

/// What this app knows about a command it sent, before or besides the server's record.
public struct LocalCommand: Sendable, Hashable {
    public var state: ReceiptState
    public var error: String?
    public var type: String
    public var agentId: String
    public var text: String?
    public var delivery: Delivery?
    public var requestId: String?
    public var at: Date

    public init(state: ReceiptState, error: String? = nil, type: String, agentId: String, text: String? = nil,
                delivery: Delivery? = nil, requestId: String? = nil, at: Date) {
        self.state = state
        self.error = error
        self.type = type
        self.agentId = agentId
        self.text = text
        self.delivery = delivery
        self.requestId = requestId
        self.at = at
    }
}

/// How a message reaches an agent (RFC 0001 §2.2).
public enum Delivery: String, Sendable, Codable, Hashable, CaseIterable, Identifiable {
    case steer, queue, interrupt
    public var id: String { rawValue }
    public var label: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }
    /// One plain sentence, as the panel says it.
    public var explanation: String {
        switch self {
        case .steer: return "At its next break, without stopping it."
        case .queue: return "After its current turn ends."
        case .interrupt: return "Stops the current turn, then delivers it."
        }
    }
}

public enum Supervision {
    // MARK: Wait clocks

    // Adapted from AgentSystemLabs/agent-office@852e2ab28c4f3f31bffdf4b20353bd119c9d3270 src/client/features/needsyou/logic.ts (MIT)
    // Copyright (c) 2026 AgentSystemLabs
    /// How long it has waited: "" for the first minute, then "4 min", "1 h 05 min".
    public static func waited(since: Date?, now: Date) -> String {
        let minutes: Int
        if let since {
            let m = (now.timeIntervalSince(since) / 60).rounded(.down)
            minutes = m.isFinite ? Int(max(min(m, 1e9), -1e9)) : 0
        } else {
            minutes = 0
        }
        if minutes < 1 { return "" }
        if minutes < 60 { return "\(minutes) min" }
        return "\(minutes / 60) h " + String(format: "%02d", minutes % 60) + " min"
    }

    /// One wait of an agent's: asking again later is another episode.
    public static func waitKey(_ id: String, since: Date?) -> String {
        "\(id)@\(since.map { String(Int64(($0.timeIntervalSince1970 * 1000).rounded())) } ?? "null")"
    }

    /// When a request started waiting: its own `openedAt`, unless missing or more than a minute in the future
    /// (a skewed clock), then the moment this app first saw it.
    public static func since(of request: InboxRequest?, firstSeen: Date?, now: Date?) -> Date? {
        if let opened = request?.openedAt, let t = parseISODate(opened) {
            if let now, t.timeIntervalSince(now) > 60 {
                // in the future: fall through
            } else {
                return t
            }
        }
        return firstSeen ?? now
    }

    /// A duration for people: "<1 s", "12 s", "1 min 40 s", "1 h 05 min".
    public static func durationText(_ seconds: TimeInterval?) -> String {
        guard let seconds, seconds.isFinite, seconds >= 0 else { return "" }
        let s = Int(seconds.rounded(.down))
        if s < 1 { return "<1 s" }
        if s < 60 { return "\(s) s" }
        if s < 3600 { return "\(s / 60) min" + (s % 60 != 0 ? " \(s % 60) s" : "") }
        return "\(s / 3600) h " + String(format: "%02d", (s / 60) % 60) + " min"
    }

    // MARK: What a request holds up

    /// Groups that run after `gid`, directly or through others (the `after` chain).
    static func laterGroups(_ groups: [TeamGroup], after gid: String) -> Set<String> {
        var out = Set<String>()
        var frontier: [String] = [gid]
        var i = 0
        while i < 50 && !frontier.isEmpty {
            let next = groups.filter { g in g.after.map(frontier.contains) == true && !out.contains(g.id) && g.id != gid }.map(\.id)
            next.forEach { out.insert($0) }
            frontier = next
            i += 1
        }
        return out
    }

    /// The agents a blocking request holds up besides the asker: everyone down its `handsTo` chain, everyone in a
    /// later stage (for a gate on a stage, the stages after it), the Lead last. Agents done or failed are not held.
    public static func holdsUp(_ request: InboxRequest?, structure: Structure?, statuses: [String: AgentStatus]) -> [String] {
        guard let request, let s = structure else { return [] }
        let roles = s.roles
        let id = request.agentId
        var seen = Set<String>()
        if let id { seen.insert(id) }
        var out: [String] = []
        func add(_ x: String) {
            if !seen.contains(x) { seen.insert(x); out.append(x) }
        }
        var cur = id
        var i = 0
        while i < 50, let c = cur, c != "lead" {
            guard let r = roles.first(where: { $0.id == c }) else { break }
            let next = r.handsTo.isEmpty ? "lead" : r.handsTo
            if seen.contains(next) { break }
            add(next)
            cur = next
            i += 1
        }
        let subject = request.subject
        let me = id.flatMap { s.role($0) }
        let gateStage = subject?.nonEmpty("after") ?? subject?.string("stage")
        let gid: String? = request.kind == "gate" && gateStage != nil ? gateStage : me?.group
        if let gid, !gid.isEmpty {
            let later = laterGroups(s.groups, after: gid)
            for r in roles where r.group.map(later.contains) == true { add(r.id) }
        }
        if request.kind == "gate", let gid, !gid.isEmpty, id != "lead" { add("lead") }
        var live = out.filter { x in !(statuses[x].map { $0.state.isFinished } ?? false) }
        if let li = live.firstIndex(of: "lead"), li != live.count - 1 {
            live.remove(at: li)
            live.append("lead")
        }
        return live
    }

    /// "Catch checker and Lead", "A, B and C", "A, B and 3 others".
    public static func namesText(_ names: [String]) -> String {
        switch names.count {
        case 0: return ""
        case 1: return names[0]
        case 2, 3: return names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
        default: return names.prefix(2).joined(separator: ", ") + " and \(names.count - 2) others"
        }
    }

    /// "Holds up Catch checker and Lead", or "" when it holds up nobody.
    public static func holdsUpText(_ names: [String]) -> String {
        names.isEmpty ? "" : "Holds up " + namesText(names)
    }

    // MARK: Sorting

    // Adapted from paperclipai/paperclip@b8e02fc2b418a9104612fa731f7afde7afcce6b5 ui/src/lib/blockedInbox.ts compareBlockedAttention (MIT)
    // Copyright (c) 2025 Paperclip AI
    /// Urgency first, then requests that block more (blocking first, then more agents held up), then oldest,
    /// then `seq`, then `requestId`. Negative when `a` comes first.
    public static func compare(_ a: PendingItem, _ b: PendingItem) -> Int {
        let u = a.request.urgency.rank - b.request.urgency.rank
        if u != 0 { return u }
        let bl = (b.request.blocking ? 1 : 0) - (a.request.blocking ? 1 : 0)
        if bl != 0 { return bl }
        let h = b.holds.count - a.holds.count
        if h != 0 { return h }
        // Like the JS: an unknown wait start orders nothing (Infinity - x is not finite there).
        if let x = a.since, let y = b.since, x != y { return x < y ? -1 : 1 }
        let s = (a.request.seq ?? 0) - (b.request.seq ?? 0)
        if s != 0 { return s }
        return a.request.requestId < b.request.requestId ? -1 : a.request.requestId > b.request.requestId ? 1 : 0
    }

    /// The inbox as the views show it. `firstSeen`: when this app first saw each request id.
    public static func arrange(_ inbox: Inbox?, structure: Structure?, statuses: [String: AgentStatus],
                               firstSeen: [String: Date], now: Date) -> ArrangedInbox {
        guard let inbox else { return .empty }
        let items = inbox.pending.map { r in
            PendingItem(request: r, since: since(of: r, firstSeen: firstSeen[r.requestId], now: now),
                        holds: r.blocking ? holdsUp(r, structure: structure, statuses: statuses) : [])
        }
        let order: (PendingItem, PendingItem) -> Bool = { compare($0, $1) < 0 }
        return ArrangedInbox(human: items.filter { $0.request.routeTo == "human" }.sorted(by: order),
                             withLead: items.filter { $0.request.routeTo != "human" }.sorted(by: order),
                             recent: inbox.recent)
    }

    // MARK: Who waits on you, in order

    /// Agents with a blocking request that needs you: most urgent first, then whoever has waited longest.
    public static func waitingAgents(_ human: [PendingItem]) -> [WaitingAgent] {
        var byId: [String: WaitingAgent] = [:]
        var order: [String] = []
        for x in human {
            guard x.request.blocking, let id = x.request.agentId, !id.isEmpty else { continue }
            var w = byId[id] ?? WaitingAgent(id: id, since: nil, urgency: 2, count: 0, requestIds: [])
            if byId[id] == nil { order.append(id) }
            if let s = x.since { w.since = w.since.map { min($0, s) } ?? s }
            w.urgency = min(w.urgency, x.request.urgency.rank)
            w.count += 1
            w.requestIds.append(x.request.requestId)
            byId[id] = w
        }
        return order.compactMap { byId[$0] }.sorted { a, b in
            if a.urgency != b.urgency { return a.urgency < b.urgency }
            let sa = a.since ?? .distantFuture, sb = b.since ?? .distantFuture
            if sa != sb { return sa < sb }
            return a.id < b.id
        }
    }

    /// Agents free for more work (idle, done, or without a status), in team order. `since` is their status so a
    /// change makes them new to `NextUp`.
    public static func idleAgents(structure: Structure?, statuses: [String: AgentStatus]) -> [(id: String, key: String)] {
        guard let s = structure else { return [] }
        return s.memberIds.compactMap { id in
            guard let st = statuses[id] else { return (id, "none") }
            guard st.state == .idle || st.state == .done else { return nil }
            return (id, st.state.rawValue + "|" + (st.say ?? ""))
        }
    }

    // MARK: Answering

    /// The A / D keys: only when the request offers exactly one `allow_once` and one `reject_once` option.
    public static func quickPair(_ request: InboxRequest?) -> (allow: RequestOption, reject: RequestOption)? {
        guard let r = request else { return nil }
        let allow = r.options.filter(\.isAllow), reject = r.options.filter(\.isReject)
        guard allow.count == 1, reject.count == 1, allow[0].kind == "allow_once", reject[0].kind == "reject_once" else { return nil }
        return (allow[0], reject[0])
    }

    /// Buttons for a request. A gate without options gets Accept / Revise (with text) / Stop.
    public static func answerOptions(_ request: InboxRequest?) -> [AnswerOption] {
        guard let r = request else { return [] }
        var opts = r.options
        if opts.isEmpty && r.kind == "gate" {
            opts = [RequestOption(optionId: "accept", name: "Accept", kind: "allow_once"),
                    RequestOption(optionId: "revise", name: "Revise", kind: "choice"),
                    RequestOption(optionId: "stop", name: "Stop", kind: "reject_once")]
        }
        return opts.map { o in
            let revise = (o.optionId + " " + o.name).range(of: "revis", options: .caseInsensitive) != nil
            return AnswerOption(option: o, needsText: r.kind == "gate" && revise,
                                tone: o.isAllow ? .allow : o.isReject ? .reject : .choice, always: o.isAlways)
        }
    }

    // MARK: What a request is about

    public static func subjectView(_ subject: JSONValue?) -> SubjectView? {
        guard let subject, case .object(var rest) = subject else { return nil }
        let type = subject.nonEmpty("type") ?? "other"
        rest.removeValue(forKey: "type")
        let restText = JSONValue.object(rest).prettyText
        var label = "", text = ""
        switch type {
        case "tool_call":
            label = "Tool" + (subject.nonEmpty("tool").map { ": " + $0 } ?? "")
            text = subject["input"].map(\.prettyText) ?? subject.nonEmpty("command") ?? restText
        case "command":
            label = "Command"
            text = subject.nonEmpty("command") ?? restText
        case "file_change":
            label = "File" + (subject.nonEmpty("path").map { ": " + $0 } ?? "")
            let paths = subject["paths"]?.array.map { $0.compactMap(\.string).joined(separator: "\n") }
            text = [subject.string("diff"), subject.string("patch"), subject.string("content"), paths]
                .compactMap { $0 }.first { !$0.isEmpty } ?? (subject.nonEmpty("path") != nil ? "" : restText)
        case "plan":
            label = "Plan"
            let steps = subject.list("steps").isEmpty ? subject.list("plan") : subject.list("steps")
            text = steps.isEmpty ? restText : steps.enumerated().map { "\($0.offset + 1). " + $0.element.prettyText }.joined(separator: "\n")
        case "claim":
            label = "Claim" + (subject.nonEmpty("claimId").map { " " + $0 } ?? "")
            text = subject.nonEmpty("text") ?? restText
        case "stage":
            label = "Stage" + (subject.nonEmpty("label").map { ": " + $0 } ?? subject.nonEmpty("after").map { " after " + $0 } ?? "")
            text = subject.nonEmpty("summary") ?? subject.list("files").compactMap(\.string).joined(separator: "\n")
        default:
            label = type
            text = restText
        }
        let lines = text.isEmpty ? 0 : text.split(separator: "\n", omittingEmptySubsequences: false).count
        return SubjectView(type: type, label: label, text: text, lines: lines, long: lines > 8 || text.utf16.count > 600)
    }

    // MARK: Who decided, and what

    /// "by you", "by Lead", "by policy rule "web search"", "in the terminal", "by the system".
    public static func byText(_ by: DecidedBy?, nameOf: (String) -> String = { $0 }) -> String {
        let b = by ?? DecidedBy(kind: "system")
        switch b.kind {
        case "human": return "by you"
        case "agent": return "by " + (b.id.flatMap { $0.isEmpty ? nil : nameOf($0) } ?? "an agent")
        case "policy": return "by policy rule" + (b.rule.flatMap { $0.isEmpty ? nil : " \"\($0)\"" } ?? "")
        case "terminal": return "in the terminal"
        default: return "by the system"
        }
    }

    /// "Allow once", "Replied: "…"", "Declined", "Answered elsewhere", …
    public static func outcomeText(_ request: InboxRequest?) -> String {
        guard let r = request else { return "" }
        let option = r.options.first { $0.optionId == r.optionId }
        let text = r.payloadText ?? ""
        switch r.outcome {
        case "selected": return (option?.name ?? r.optionId.flatMap { $0.isEmpty ? nil : $0 } ?? "Answered") + (text.isEmpty ? "" : ": \"\(text)\"")
        case "submitted": return text.isEmpty ? "Replied" : "Replied: \"\(text)\""
        case "declined": return "Declined"
        case "cancelled": return "Cancelled"
        case "expired": return "Expired"
        case "superseded": return "Answered elsewhere"
        case "stale": return "No longer relevant"
        default: return "Resolved"
        }
    }

    // MARK: Command receipts

    /// Merge what this app knows with the server's record. A receipt never moves backwards (an older snapshot
    /// does not undo an ack), and a final state stays.
    public static func receipt(local: LocalCommand?, command: CommandRecord?) -> Receipt {
        var state = local?.state ?? .sent
        var reason = local?.error
        if let command, !state.isFinal, let server = ReceiptState(rawValue: command.status), server.rank >= state.rank {
            state = server
            reason = command.reason
        }
        return Receipt(state: state, reason: reason, isFinal: state.isFinal, ok: state == .applied || state == .accepted,
                       text: receiptText(state, reason: reason))
    }

    public static func receiptText(_ state: ReceiptState, reason: String?) -> String {
        let plain = reason.flatMap { $0.isEmpty ? nil : $0.replacingOccurrences(of: "_", with: " ") }
        let why = plain.map { ": " + $0 } ?? ""
        switch state {
        case .sending: return "Sending…"
        case .sent: return "Sent…"
        case .accepted: return "Accepted" + (plain.map { " · " + $0 } ?? "")
        case .applied: return "Applied" + (plain.map { " · " + $0 } ?? "")
        case .rejected: return "Rejected" + why
        case .unsupported: return "This agent cannot take that" + why
        case .expired: return "Expired before it was delivered"
        case .conflict: return "Already answered"
        case .failed: return "Not sent" + why
        }
    }

    // MARK: Notifications

    // Adapted from KbWen/agent-virtual-office@48e0e23da55cdf7b083afdee468d21f16cdd02b9 src/inference/desktopNotifier.js (MIT)
    // Copyright (c) 2026 KbWen
    /// A system notification only for a blocking request that needs you and has waited at least 30 s, while the
    /// app is in the background, with notifications on and allowed, once per wait episode.
    public static let notifyAfter: TimeInterval = 30
    public static func shouldNotify(enabled: Bool, permitted: Bool, hidden: Bool, blocking: Bool, routeTo: String,
                                    waited: TimeInterval?, alreadyNotified: Bool) -> Bool {
        enabled && permitted && hidden && blocking && routeTo == "human" && (waited ?? -1) >= notifyAfter && !alreadyNotified
    }

    // MARK: Dates

    /// ISO 8601 with or without fractional seconds.
    public static func parseISODate(_ s: String) -> Date? {
        let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        if let d = try? withFraction.parse(s) { return d }
        return try? Date.ISO8601FormatStyle().parse(s)
    }
}

/// Cycles through agents one press at a time: the first in line not visited this round; once all are visited,
/// the first again. An agent that starts a new wait after its visit is new to this round. `here` comes up only
/// when it is the only one.
// Adapted from AgentSystemLabs/agent-office@852e2ab28c4f3f31bffdf4b20353bd119c9d3270 src/client/nextup.ts NextUp (MIT)
// Copyright (c) 2026 AgentSystemLabs
public struct NextUp: Sendable {
    private var visited: [String: String] = [:]
    public init() {}

    /// `line`: candidates in order, each with a key that changes when its wait (or status) changes.
    public mutating func next(_ line: [(id: String, key: String)], here: String?) -> String? {
        visited = visited.filter { id, key in line.contains { $0.id == id && $0.key == key } }
        let others = line.filter { $0.id != here }
        var pick = others.first { visited[$0.id] == nil }
        if pick == nil {
            visited.removeAll()
            pick = others.first ?? line.first
        }
        if let pick { visited[pick.id] = pick.key }
        return pick?.id
    }

    /// The `line` for agents that wait on you.
    public static func line(_ waiting: [WaitingAgent]) -> [(id: String, key: String)] {
        waiting.map { ($0.id, Supervision.waitKey($0.id, since: $0.since)) }
    }
}

extension DecidedBy {
    public init(kind: String) {
        self.init(kind: kind, id: nil, rule: nil)
    }
}
