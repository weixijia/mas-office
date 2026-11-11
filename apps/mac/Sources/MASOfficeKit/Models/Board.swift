import Foundation

/// `mas/board` (RFC 0001 §3): tasks, the Lead's ledger, reviews, recoveries, usage and agent info.
public struct Board: JSONModel, Encodable, Sendable, Hashable {
    public struct TaskItem: Sendable, Hashable, Encodable, Identifiable {
        public var taskId: String
        public var agentId: String?
        public var title: String
        public var brief: String?
        public var from: String?
        public var round: Int
        public var attempt: Int
        /// `assigned`, `working`, `blocked`, `review`, `done`.
        public var state: String
        public var say: String?
        /// `success`, `failed`, `cancelled` once done.
        public var outcome: String?
        public var summary: String?
        public var assignedAt: String?
        public var finishedAt: String?
        public var id: String { taskId }
    }
    public struct Ledger: Sendable, Hashable, Encodable {
        public var satisfied: Bool?
        public var looping: Bool?
        public var progressing: Bool?
        public var next: String?
        public var instruction: String?
        public var reason: String?
        public var plan: [String]
        public var stalls: Int?
        public var updated: String?

        /// "Satisfied", "Looping", "Progressing", "Not progressing" or "".
        public var word: String {
            if satisfied == true { return "Satisfied" }
            if looping == true { return "Looping" }
            if progressing == true { return "Progressing" }
            if progressing == false { return "Not progressing" }
            return ""
        }
    }
    public struct Review: Sendable, Hashable, Encodable {
        public var reviewer: String?
        public var target: String
        /// `accept`, `revise`, `escalate`.
        public var verdict: String
        public var round: Int
        public var note: String?
        public var at: String?
    }
    public struct Recovery: Sendable, Hashable, Encodable {
        public var by: String?
        /// `retry`, `reassign`, `replan`, `split`, `ask-human`.
        public var strategy: String
        public var target: String?
        public var note: String?
        public var at: String?
    }
    /// Totals so far for one agent, as the backend reported them.
    public struct Usage: Sendable, Hashable, Encodable {
        public var inputTokens: Double
        public var outputTokens: Double
        public var costUsd: Double
        public var turns: Double
        /// What the backend said about usage limits, e.g. `{"status": "allowed_warning", "resetsAt", "kind"}`.
        public var limit: JSONValue?
        public var updated: String?
    }
    public struct AgentInfo: Sendable, Hashable, Encodable {
        public var backend: String?
        public var model: String?
        /// `{"backend", "id", "resumable"?}`: which official session runs the agent. Never a credential.
        public var session: JSONValue?
        /// Commands the agent takes: `message`, `respond`, `interrupt`, `assign`.
        public var accepts: [String]
        public var reviewerOf: [String]
    }

    public var tasks: [TaskItem]
    public var ledger: Ledger?
    public var reviews: [Review]
    public var recoveries: [Recovery]
    public var usage: [String: Usage]
    public var agents: [String: AgentInfo]

    public init(json: JSONValue) {
        tasks = json.list("tasks").compactMap { t in
            guard let id = t.nonEmpty("taskId") else { return nil }
            return TaskItem(taskId: id, agentId: t.string("agentId"), title: t.string("title") ?? id, brief: t.string("brief"),
                        from: t.string("from"), round: t.int("round") ?? 1, attempt: t.int("attempt") ?? 1,
                        state: t.nonEmpty("state") ?? "assigned", say: t.string("say"), outcome: t.string("outcome"),
                        summary: t.string("summary"), assignedAt: t.string("assignedAt"), finishedAt: t.string("finishedAt"))
        }
        ledger = json.objectValue("ledger").map { l in
            Ledger(satisfied: l.bool("satisfied"), looping: l.bool("looping"), progressing: l.bool("progressing"),
                   next: l.nonEmpty("next"), instruction: l.string("instruction"), reason: l.string("reason"),
                   plan: l.strings("plan"), stalls: l.int("stalls"), updated: l.string("updated"))
        }
        reviews = json.list("reviews").compactMap { r in
            guard let target = r.nonEmpty("target"), let verdict = r.nonEmpty("verdict") else { return nil }
            return Review(reviewer: r.string("reviewer"), target: target, verdict: verdict, round: r.int("round") ?? 1,
                          note: r.string("note"), at: r.string("at"))
        }
        recoveries = json.list("recoveries").compactMap { r in
            guard let strategy = r.nonEmpty("strategy") else { return nil }
            return Recovery(by: r.string("by"), strategy: strategy, target: r.string("target"), note: r.string("note"), at: r.string("at"))
        }
        usage = (json["usage"]?.object ?? [:]).compactMapValues { u in
            guard u.isObject else { return nil }
            return Usage(inputTokens: u.double("inputTokens") ?? 0, outputTokens: u.double("outputTokens") ?? 0,
                         costUsd: u.double("costUsd") ?? 0, turns: u.double("turns") ?? 0,
                         limit: u.objectValue("limit"), updated: u.string("updated"))
        }
        agents = (json["agents"]?.object ?? [:]).compactMapValues { a in
            guard a.isObject else { return nil }
            return AgentInfo(backend: a.nonEmpty("backend"), model: a.nonEmpty("model"), session: a.objectValue("session"),
                             accepts: a.strings("accepts"), reviewerOf: a.strings("reviewerOf"))
        }
    }

    /// Whether the agent takes a command (`message`, `respond`, `interrupt`, `assign`). A viewer shows
    /// controls only for these.
    public func accepts(_ agentId: String, _ command: String) -> Bool {
        agents[agentId]?.accepts.contains(command) ?? false
    }
}

/// Claim status (spec §2.8); anything else reads as `unchecked`.
public enum ClaimStatus: String, Sendable, Codable, Hashable, CaseIterable {
    case supported, partial, contradicted, unknown, unchecked
    case notCheckworthy = "not-checkworthy"

    /// The plain word: "supported", …, "not checked".
    public var word: String { self == .notCheckworthy ? "not checked" : rawValue }
}

/// `outputs/verification` (RFC 0001 §2.5, §3): claims, evidence and verdicts.
public struct Verification: JSONModel, Encodable, Sendable, Hashable {
    public struct Verdict: Sendable, Hashable, Encodable {
        public var by: String?
        public var status: ClaimStatus
        public var sourceId: String?
        /// `supports`, `refutes`, `irrelevant`.
        public var relationship: String?
        public var method: String?
        public var note: String?
        public var backend: String?
        public var at: String?
    }
    public struct Claim: Sendable, Hashable, Encodable, Identifiable {
        public var claimId: String
        public var text: String
        public var sources: [String]
        public var serves: String?
        public var checkworthy: Bool
        public var author: String?
        public var status: ClaimStatus
        public var verdicts: [Verdict]
        public var id: String { claimId }
    }
    public struct Evidence: Sendable, Hashable, Encodable, Identifiable {
        public var sourceId: String
        public var url: String?
        public var urlHealth: URLHealth?
        public var httpStatus: Int?
        public var archivedUrl: String?
        public var grade: EvidenceGrade?
        public var quote: String?
        public var note: String?
        public var checkedBy: String?
        public var at: String?
        public var id: String { sourceId }
    }
    public struct Summary: Sendable, Hashable, Encodable {
        public var claims = 0, checkworthy = 0, supported = 0, partial = 0, contradicted = 0, unknown = 0, unchecked = 0
        public var sources = 0, live = 0, stale = 0, hallucinated = 0, blocked = 0, uncited = 0
    }

    public var claims: [Claim]
    public var evidence: [Evidence]
    public var summary: Summary

    public init(json: JSONValue) {
        claims = json.list("claims").compactMap { c in
            guard let id = c.string("claimId") else { return nil }
            let verdicts: [Verdict] = c.list("verdicts").compactMap { v in
                guard v.isObject else { return nil }
                return Verdict(by: v.string("by"), status: ClaimStatus(rawValue: v.string("status") ?? "") ?? .unknown,
                               sourceId: v.string("sourceId"), relationship: v.string("relationship"), method: v.string("method"),
                               note: v.string("note"), backend: v.string("backend"), at: v.string("at"))
            }
            return Claim(claimId: id, text: c.string("text") ?? "", sources: c.strings("sources"), serves: c.string("serves"),
                         checkworthy: c.bool("checkworthy") ?? true, author: c.string("author"),
                         status: ClaimStatus(rawValue: c.string("status") ?? "") ?? .unchecked, verdicts: verdicts)
        }
        evidence = json.list("evidence").compactMap { e in
            guard let id = e.string("sourceId") else { return nil }
            let grade = e.string("grade").flatMap { EvidenceGrade(rawValue: $0) }
            return Evidence(sourceId: id, url: e.string("url"), urlHealth: e.string("urlHealth").flatMap(URLHealth.init(rawValue:)),
                            httpStatus: e.int("httpStatus"), archivedUrl: e.string("archivedUrl"), grade: grade,
                            quote: e.string("quote"), note: e.string("note"), checkedBy: e.string("checkedBy"), at: e.string("at"))
        }
        let s = json.objectValue("summary") ?? .object([:])
        func n(_ k: String) -> Int { s.double(k).map { $0 >= 0 ? Int($0) : 0 } ?? 0 }
        summary = Summary(claims: n("claims"), checkworthy: n("checkworthy"), supported: n("supported"), partial: n("partial"),
                          contradicted: n("contradicted"), unknown: n("unknown"), unchecked: n("unchecked"), sources: n("sources"),
                          live: n("live"), stale: n("stale"), hallucinated: n("hallucinated"), blocked: n("blocked"), uncited: n("uncited"))
    }

    public func claim(_ id: String) -> Claim? { claims.first { $0.claimId == id } }
    public func evidence(for sourceId: String) -> Evidence? { evidence.first { $0.sourceId == sourceId } }

    /// claimId → status, for highlighting claim spans.
    public var statusByClaim: [String: ClaimStatus] {
        Dictionary(claims.map { ($0.claimId, $0.status) }, uniquingKeysWith: { _, last in last })
    }

    /// What the checkers caught: contradicted and unknown claims.
    public var caughtClaims: [Claim] { claims.filter { $0.status == .contradicted || $0.status == .unknown } }
}
