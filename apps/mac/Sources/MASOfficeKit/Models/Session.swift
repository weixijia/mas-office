import Foundation

/// Evidence grade of a source (spec §2.4): what kind of source it is. Not a verdict.
public enum EvidenceGrade: String, Sendable, Codable, Hashable, CaseIterable {
    case A, B, C, D

    /// The panel's reading: the first letter, upper-cased; missing or unknown is `D`.
    public init(letter: String?) {
        let first = letter.flatMap { $0.first }.map { String($0).uppercased() } ?? "D"
        self = EvidenceGrade(rawValue: first) ?? .D
    }

    /// "Can be bought or run", "Study with data", "Demo or marketing", "Opinion".
    public var meaning: String {
        switch self {
        case .A: return "Can be bought or run"
        case .B: return "Study with data"
        case .C: return "Demo or marketing"
        case .D: return "Opinion"
        }
    }
}

/// Whether a source's link works (RFC 0001 §2.5). Different from the grade.
public enum URLHealth: String, Sendable, Codable, Hashable, CaseIterable {
    case live, stale, hallucinated, blocked, unknown

    /// The plain word: `hallucinated` reads "dead", `unknown` reads "unchecked".
    public var word: String {
        switch self {
        case .hallucinated: return "dead"
        case .unknown: return "unchecked"
        default: return rawValue
        }
    }
}

/// What one official program reported about itself. Never a credential.
public struct BackendStatus: Sendable, Hashable, Encodable {
    public var available: Bool
    public var loggedIn: Bool
    public var version: String?
    public var detail: String?

    public init(available: Bool, loggedIn: Bool, version: String? = nil, detail: String? = nil) {
        self.available = available
        self.loggedIn = loggedIn
        self.version = version
        self.detail = detail
    }

    public init(json: JSONValue) {
        available = json.bool("available") != false
        loggedIn = json.bool("loggedIn") != false
        version = json.nonEmpty("version")
        detail = json.nonEmpty("detail")
    }

    /// Installed and signed in: sessions may use it.
    public var ready: Bool { available && loggedIn }

    /// Plain text for people: "ready", "not signed in", "not installed".
    public var summary: String {
        if !available { return "not installed" }
        if !loggedIn { return "not signed in" }
        return "ready"
    }

    /// Display name of a backend id. Plain text only (no vendor branding).
    public static func label(_ backend: String) -> String {
        switch backend {
        case "claude-code": return "Claude Code"
        case "codex": return "Codex"
        default: return backend
        }
    }

    /// The vendor's own sign-in command the person runs themselves. MAS Office never signs anyone in.
    public static func signInCommand(_ backend: String) -> String? {
        switch backend {
        case "claude-code": return "claude auth login"
        case "codex": return "codex login"
        default: return nil
        }
    }
}

/// `GET /v0/session`: what this client may do.
public struct SessionInfo: JSONModel, Encodable, Sendable, Hashable {
    /// The token this client sent is valid (it may answer requests and message agents).
    public var tokenValid: Bool
    /// A runtime is attached (runs can be started; commands reach real sessions).
    public var runtime: Bool
    public var spec: String?
    public var terminal: Bool
    public var backends: [String: BackendStatus]
    public var maxParallel: Int?

    public init(json: JSONValue) {
        tokenValid = json.bool("token") == true
        runtime = json.bool("runtime") == true
        spec = json.string("spec")
        terminal = json.bool("terminal") == true
        backends = (json["backends"]?.object ?? [:]).compactMapValues { $0.isObject ? BackendStatus(json: $0) : nil }
        maxParallel = json.int("maxParallel")
    }
}

/// One line of `<project>/mas/transcript/<agentId>.jsonl` (runtime.md §6). Unknown fields stay in `raw`.
public struct TranscriptEntry: Sendable, Hashable, Encodable {
    /// `user`, `assistant`, `thinking`, `tool_call`, `tool_result`, `request`, `resolved`, `command`, `system`, `result`, …
    public var kind: String
    public var ts: String?
    public var text: String?
    public var origin: String?
    public var callId: String?
    public var tool: String?
    public var summary: String?
    public var input: JSONValue?
    public var ok: Bool?
    public var requestId: String?
    public var title: String?
    public var outcome: String?
    public var by: String?
    public var cmdId: String?
    public var delivery: String?
    public var status: String?
    public var usage: JSONValue?
    public var raw: JSONValue

    /// Nil unless an object with a string `kind` (the panel's `jsonlAppend` rule).
    public init?(json: JSONValue) {
        guard json.isObject, let kind = json.string("kind") else { return nil }
        self.kind = kind
        ts = json.string("ts")
        text = json.string("text")
        origin = json.string("origin")
        callId = json.string("callId")
        tool = json.string("tool")
        summary = json.string("summary")
        input = json["input"]
        ok = json.bool("ok")
        requestId = json.string("requestId")
        title = json.string("title")
        outcome = json.string("outcome")
        by = json.string("by") ?? json["by"]?.string("kind")
        cmdId = json.string("cmdId")
        delivery = json.string("delivery")
        status = json.string("status")
        usage = json.objectValue("usage")
        raw = json
    }
}

/// All documents of one project, as last read. Missing optional documents are nil.
public struct ProjectSnapshot: Sendable, Hashable {
    public var project: String?
    public var structure: Structure?
    public var statuses: [String: AgentStatus]
    public var state: ProjectState?
    public var task: TaskDoc?
    public var result: ResultDoc?
    public var inbox: Inbox?
    public var board: Board?
    public var verification: Verification?
    /// Documents that exist but could not be read (being written, or broken): keep the last good version.
    public var unreadable: Set<String>

    public init(project: String? = nil, structure: Structure? = nil, statuses: [String: AgentStatus] = [:], state: ProjectState? = nil,
                task: TaskDoc? = nil, result: ResultDoc? = nil, inbox: Inbox? = nil, board: Board? = nil,
                verification: Verification? = nil, unreadable: Set<String> = []) {
        self.project = project
        self.structure = structure
        self.statuses = statuses
        self.state = state
        self.task = task
        self.result = result
        self.inbox = inbox
        self.board = board
        self.verification = verification
        self.unreadable = unreadable
    }

    public static let empty = ProjectSnapshot()

    /// The documents a snapshot is made of, by their workspace path inside the project.
    public enum Document: String, Sendable, CaseIterable {
        case structure = "mas/structure"
        case state = "mas/state"
        case task = "me/task"
        case result = "outputs/result"
        case inbox = "mas/inbox"
        case board = "mas/board"
        case verification = "outputs/verification"

        /// The `.js` twin's global (spec §1.1).
        public var global: String {
            switch self {
            case .structure: return "MAS_STRUCTURE"
            case .state: return "MAS_STATE"
            case .task: return "MAS_TASK"
            case .result: return "MAS_RESULT"
            case .inbox: return "MAS_INBOX"
            case .board: return "MAS_BOARD"
            case .verification: return "MAS_VERIFICATION"
            }
        }
    }

    /// The same snapshot with a broken document replaced by its last good version from `previous`.
    public func keepingGoodParts(of previous: ProjectSnapshot) -> ProjectSnapshot {
        guard !unreadable.isEmpty, previous.project == project else { return self }
        var out = self
        for doc in unreadable {
            switch doc {
            case Document.structure.rawValue: out.structure = previous.structure
            case Document.state.rawValue: out.state = previous.state
            case Document.task.rawValue: out.task = previous.task
            case Document.result.rawValue: out.result = previous.result
            case Document.inbox.rawValue: out.inbox = previous.inbox
            case Document.board.rawValue: out.board = previous.board
            case Document.verification.rawValue: out.verification = previous.verification
            default:
                if doc.hasPrefix("mas/status/") {
                    let id = String(doc.dropFirst("mas/status/".count))
                    out.statuses[id] = previous.statuses[id]
                }
            }
        }
        return out
    }
}
