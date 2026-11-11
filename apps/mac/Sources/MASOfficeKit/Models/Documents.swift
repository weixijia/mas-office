import Foundation

/// The seven agent states of spec §2.2. Anything else reads as `idle` (a 0.1 reader drops unknown states).
public enum AgentState: String, Sendable, Codable, Hashable, CaseIterable {
    case idle, waiting, working, handoff, flagged, done, failed

    /// Busy: the run clock is running for this agent.
    public var isBusy: Bool { self == .working || self == .flagged || self == .handoff }
    /// Nothing more will happen at this desk this run.
    public var isFinished: Bool { self == .done || self == .failed }
}

/// How a status that carries a flag reads (the panel's `flagInfo`).
public struct FlagInfo: Sendable, Hashable {
    public enum Icon: String, Sendable { case warn, ask, fail }
    /// The badge word: "flagged", "needs you", "failed".
    public var word: String
    /// The flag box title: "Found a problem", "Needs your input", "Needs your approval", "Failed".
    public var title: String
    public var icon: Icon
    public var needsYou: Bool
}

/// `mas/status/<id>`: one agent's live status (spec §2.2, RFC 0001 §4.2).
public struct AgentStatus: JSONModel, Encodable, Sendable, Hashable {
    public var state: AgentState
    public var say: String?
    public var to: String?
    public var flag: String?
    /// `concern`, `needs_input`, `needs_approval` or `error`.
    public var flagKind: String?
    /// 0–100, when the agent gave one.
    public var progress: Int?
    public var t: String?
    public var waitingOn: [String]
    public var stopReason: String?

    public init(state: AgentState = .idle, say: String? = nil, flag: String? = nil, flagKind: String? = nil, progress: Int? = nil) {
        self.state = state
        self.say = say
        self.flag = flag
        self.flagKind = flagKind
        self.progress = progress
        waitingOn = []
    }

    public init(json: JSONValue) {
        state = AgentState(rawValue: json.string("state") ?? "") ?? .idle
        say = json.nonEmpty("say")
        to = json.nonEmpty("to")
        flag = json.nonEmpty("flag")
        flagKind = json.nonEmpty("flagKind")
        progress = json.double("progress").map { Int(max(0, min(100, $0.rounded()))) }
        t = json.nonEmpty("t")
        waitingOn = json.strings("waitingOn")
        stopReason = json.nonEmpty("stopReason")
    }

    /// The wording for this status, or nil when it carries no flag.
    public var flagInfo: FlagInfo? {
        if state == .failed { return FlagInfo(word: "failed", title: "Failed", icon: .fail, needsYou: false) }
        guard state == .flagged else { return nil }
        switch flagKind {
        case "needs_input": return FlagInfo(word: "needs you", title: "Needs your input", icon: .ask, needsYou: true)
        case "needs_approval": return FlagInfo(word: "needs you", title: "Needs your approval", icon: .ask, needsYou: true)
        default: return FlagInfo(word: "flagged", title: "Found a problem", icon: .warn, needsYou: false)
        }
    }

    /// The badge word: "needs you", "flagged", "failed" or the state itself.
    public var stateLabel: String { flagInfo?.word ?? state.rawValue }
    public var needsYou: Bool { flagInfo?.needsYou ?? false }
}

/// `mas/state`: where the project stands (spec §2.3).
public struct ProjectState: JSONModel, Encodable, Sendable, Hashable {
    /// `kit` or `sdk`.
    public var mode: String?
    public var step: Int?
    /// `setup | describe | design | refine | locked | running | done | failed`.
    public var phase: String?
    public var locked: Bool?
    public var version: Int?
    public var run: Int?
    public var runId: String?
    public var updated: String?
    /// One plain sentence: what happens or what to do next.
    public var next: String?

    public init(json: JSONValue) {
        mode = json.nonEmpty("mode")
        step = json.int("step")
        phase = json.nonEmpty("phase")
        locked = json.bool("locked")
        version = json.int("version")
        run = json.int("run")
        runId = json.nonEmpty("runId")
        updated = json.nonEmpty("updated")
        next = json.nonEmpty("next")
    }

    public var isRunning: Bool { phase == "running" }
}

/// `me/task`: what the person asked for.
public struct TaskDoc: JSONModel, Encodable, Sendable, Hashable {
    public struct Requirement: Sendable, Hashable, Encodable, Identifiable {
        public var id: String
        public var text: String
    }
    public var title: String?
    public var summary: String?
    public var requirements: [Requirement]

    public init(json: JSONValue) {
        title = json.nonEmpty("title")
        summary = json.nonEmpty("summary")
        requirements = json.list("requirements").compactMap { r in
            guard let id = r.nonEmpty("id") else { return nil }
            return Requirement(id: id, text: r.string("text") ?? "")
        }
    }
}

/// `outputs/result`: the answer (spec §2.4), with follow-up rounds (RFC 0001 §2.6).
public struct ResultDoc: JSONModel, Encodable, Sendable, Hashable {
    public struct Source: Sendable, Hashable, Encodable, Identifiable {
        public var id: String
        public var title: String?
        public var url: String?
        /// Evidence grade A–D (`D` when missing or unknown).
        public var evidence: EvidenceGrade
        public var foundBy: String?
    }
    public struct Flag: Sendable, Hashable, Encodable {
        public var by: String?
        /// `concern`, `needs_input`, `error`…
        public var kind: String?
        public var text: String
    }
    public struct Work: Sendable, Hashable, Encodable {
        public var by: String
        public var summary: String
    }
    /// One round of the answer: round 1 is the run's own result, later ones answer follow-ups.
    public struct Round: Sendable, Hashable, Encodable, Identifiable {
        public var round: Int
        public var question: String
        public var title: String
        public var markdown: String
        public var updated: String
        public var latest: Bool
        public var id: Int { round }
    }

    public var title: String?
    public var run: Int?
    public var updated: String?
    public var markdown: String
    public var sources: [Source]
    public var flags: [Flag]
    public var work: [Work]
    public var round: Int?
    public var question: String?
    /// Earlier rounds, oldest first (as written; see `rounds` for the cleaned thread).
    public var previous: [JSONValue]

    public init(json: JSONValue) {
        title = json.nonEmpty("title")
        run = json.int("run")
        updated = json.nonEmpty("updated")
        markdown = json.string("markdown") ?? ""
        sources = json.list("sources").compactMap { s in
            guard s.isObject else { return nil }
            let id = s.string("id") ?? ""
            return Source(id: id, title: s.nonEmpty("title"), url: s.nonEmpty("url"),
                          evidence: EvidenceGrade(letter: s.string("evidence")), foundBy: s.nonEmpty("foundBy"))
        }
        flags = json.list("flags").compactMap { f in
            guard f.isObject, let text = f.nonEmpty("text") else { return nil }
            return Flag(by: f.nonEmpty("by"), kind: f.nonEmpty("kind"), text: text)
        }
        work = json.list("work").compactMap { w in
            guard let by = w.nonEmpty("by"), let summary = w.string("summary") else { return nil }
            return Work(by: by, summary: summary)
        }
        round = json.int("round")
        question = json.nonEmpty("question")
        previous = json.list("previous")
    }

    /// The rounds as one thread, oldest first; round numbers always increase (the panel's `resultRounds`).
    public var rounds: [Round] {
        func positive(_ v: JSONValue?) -> Int? {
            guard let n = v?.int, n > 0 else { return nil }
            return n
        }
        var last = 0
        var out: [Round] = previous.compactMap { x in
            guard x.isObject, let md = x.string("markdown") else { return nil }
            last = max(positive(x["round"]) ?? 0, last + 1)
            return Round(round: last, question: x.string("question") ?? "", title: x.string("title") ?? "",
                         markdown: md, updated: x.string("updated") ?? "", latest: false)
        }
        out.append(Round(round: max(round ?? 0, last + 1), question: question ?? "", title: title ?? "",
                         markdown: markdown, updated: updated ?? "", latest: true))
        return out
    }
}

/// `home/projects`: which projects exist and which one is followed (spec §2.5).
public struct ProjectsIndex: JSONModel, Encodable, Sendable, Hashable {
    public struct Entry: Sendable, Hashable, Encodable, Identifiable {
        public var folder: String
        public var title: String
        public var step: Int?
        public var phase: String?
        public var agents: Int?
        public var runs: Int?
        public var id: String { folder }
    }
    public var current: String?
    public var projects: [Entry]

    public init(current: String?, projects: [Entry]) {
        self.current = current
        self.projects = projects
    }

    /// The panel's `normalizeHome`: valid, distinct folders only; `current` must be a valid folder name.
    public init(json: JSONValue) {
        var seen = Set<String>()
        projects = json.list("projects").compactMap { p in
            guard let folder = p.string("folder"), ProjectsIndex.isFolderName(folder), seen.insert(folder).inserted else { return nil }
            let title = (p.string("title") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let step = p.double("step").flatMap { $0 >= 1 && $0 <= 4 ? Int($0) : nil }
            let count = { (k: String) -> Int? in p.double(k).flatMap { $0 >= 0 ? Int($0) : nil } }
            return Entry(folder: folder, title: title.isEmpty ? folder : title, step: step, phase: p.nonEmpty("phase"),
                         agents: count("agents"), runs: count("runs"))
        }
        current = json.string("current").flatMap { ProjectsIndex.isFolderName($0) ? $0 : nil }
    }

    /// `^[a-z0-9][a-z0-9-]{0,63}$` (the panel's rule for listed folders).
    public static func isFolderName(_ s: String) -> Bool {
        let bytes = Array(s.utf8)
        guard (1...64).contains(bytes.count) else { return false }
        func ok(_ b: UInt8, first: Bool) -> Bool {
            (b >= 0x61 && b <= 0x7A) || (b >= 0x30 && b <= 0x39) || (!first && b == 0x2D)
        }
        return bytes.enumerated().allSatisfy { ok($0.element, first: $0.offset == 0) }
    }
}
