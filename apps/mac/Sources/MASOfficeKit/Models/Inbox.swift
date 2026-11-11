import Foundation

/// One choice on a request: `allow_once`, `allow_always`, `reject_once`, `reject_always` or `choice`.
public struct RequestOption: Sendable, Hashable, Encodable, Identifiable {
    public var optionId: String
    public var name: String
    public var kind: String
    public var id: String { optionId }

    public init(optionId: String, name: String, kind: String) {
        self.optionId = optionId
        self.name = name
        self.kind = kind
    }

    /// Nil unless an object with a non-empty string `optionId`.
    public init?(json: JSONValue) {
        guard let id = json.nonEmpty("optionId") else { return nil }
        self.init(optionId: id, name: json.nonEmpty("name") ?? id, kind: json.nonEmpty("kind") ?? "choice")
    }

    public var isAllow: Bool { kind.hasPrefix("allow") }
    public var isReject: Bool { kind.hasPrefix("reject") }
    /// A standing rule ("allow always"): never picked by a key press.
    public var isAlways: Bool { kind.hasSuffix("_always") }
}

/// Who decided a request: `{"kind": "human" | "agent" | "policy" | "terminal" | "system", "id"?, "rule"?}`.
public struct DecidedBy: Sendable, Hashable, Encodable {
    public var kind: String
    public var id: String?
    public var rule: String?
}

/// Request urgency; anything else reads as `normal`.
public enum Urgency: String, Sendable, Codable, Hashable, CaseIterable {
    case high, normal, low
    /// Sort rank: high first.
    public var rank: Int {
        switch self {
        case .high: return 0
        case .normal: return 1
        case .low: return 2
        }
    }
}

/// One request that waits (or waited) on a person (RFC 0001 §2.1, §3). Normalised like `panel/inbox.js`.
public struct InboxRequest: Sendable, Hashable, Encodable, Identifiable {
    public var requestId: String
    public var agentId: String?
    /// `approval`, `question`, `decision`, `flag`, `gate`; other values are kept and read like `question`.
    public var kind: String
    public var title: String
    public var description: String?
    public var subject: JSONValue?
    public var toolCallId: String?
    public var options: [RequestOption]
    public var responseSchema: JSONValue?
    public var blocking: Bool
    /// `human`, `lead` or an agent id: who sees it first.
    public var routeTo: String
    /// `anyone`, `human_only` or `not_creator`.
    public var resolver: String
    public var urgency: Urgency
    public var expiresAt: String?
    /// What happens if nobody answers.
    public var onExpire: String?
    public var source: JSONValue?
    public var openedAt: String?
    public var seq: Int?
    public var run: Int?
    // Closed requests (`recent`):
    public var outcome: String?
    public var optionId: String?
    public var payload: JSONValue?
    public var note: String?
    public var by: DecidedBy?
    public var cmdId: String?
    public var resolvedAt: String?

    public var id: String { requestId }

    static let outcomes: Set<String> = ["selected", "submitted", "declined", "cancelled", "expired", "superseded", "stale"]

    /// Nil unless an object with a non-empty string `requestId`.
    public init?(json: JSONValue) {
        guard json.isObject, let rid = json.nonEmpty("requestId") else { return nil }
        requestId = rid
        agentId = json.string("agentId")
        kind = json.nonEmpty("kind") ?? "question"
        title = json.nonEmpty("title") ?? "Untitled request"
        description = json.string("description")
        subject = json.objectValue("subject")
        toolCallId = json.string("toolCallId")
        options = json.list("options").compactMap(RequestOption.init(json:))
        responseSchema = json.objectValue("responseSchema")
        blocking = json.bool("blocking") != false
        routeTo = json.nonEmpty("routeTo") ?? "human"
        resolver = json.nonEmpty("resolver") ?? "anyone"
        urgency = Urgency(rawValue: json.string("urgency") ?? "") ?? .normal
        expiresAt = json.string("expiresAt")
        onExpire = json.string("onExpire")
        source = json.objectValue("source")
        openedAt = json.string("openedAt")
        seq = json.double("seq").map { Int($0) }
        run = json.double("run").map { Int($0) }
        outcome = json.string("outcome").flatMap { InboxRequest.outcomes.contains($0) ? $0 : nil }
        optionId = json.string("optionId")
        payload = json["payload"].flatMap { $0.isNull ? nil : $0 }
        note = json.string("note")
        by = json.objectValue("by").map { DecidedBy(kind: $0.nonEmpty("kind") ?? "system", id: $0.string("id"), rule: $0.string("rule")) }
        cmdId = json.string("cmdId")
        resolvedAt = json.string("resolvedAt")
    }

    /// The request kind for wording and colour (unknown kinds read like `question`).
    public var kindInfo: RequestKind { RequestKind(rawValue: kind) ?? .question }

    /// The text of a typed answer (`payload.text`), if any.
    public var payloadText: String? { payload?.string("text") }
}

/// The five request kinds with their words; tones map onto the panel palette.
public enum RequestKind: String, Sendable, CaseIterable {
    case approval, question, decision, flag, gate
    public var word: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }
    /// `verm` (needs you), `cobalt` (a question), `ochre` (a warning).
    public var tone: String {
        switch self {
        case .question: return "cobalt"
        case .flag: return "ochre"
        default: return "verm"
        }
    }
}

/// What was asked of an agent, with its receipt (RFC 0001 §2.2, §3).
public struct CommandRecord: Sendable, Hashable, Encodable, Identifiable {
    public var cmdId: String
    public var type: String?
    public var agentId: String?
    public var origin: DecidedBy
    public var text: String?
    public var delivery: String?
    public var requestId: String?
    /// `sent`, `accepted`, `applied`, `rejected`, `unsupported`, `expired`.
    public var status: String
    public var reason: String?
    public var sentAt: String?
    public var ackAt: String?
    public var seq: Int?
    public var id: String { cmdId }

    public init?(json: JSONValue) {
        guard json.isObject, let id = json.nonEmpty("cmdId") else { return nil }
        cmdId = id
        type = json.string("type")
        agentId = json.string("agentId")
        origin = json.objectValue("origin").map { DecidedBy(kind: $0.nonEmpty("kind") ?? "agent", id: $0.string("id"), rule: nil) }
            ?? DecidedBy(kind: "agent", id: "lead", rule: nil)
        text = json.string("text")
        delivery = json.string("delivery")
        requestId = json.string("requestId")
        let st = json.string("status") ?? ""
        status = ReceiptState(rawValue: st) != nil ? st : "sent"
        reason = json.string("reason")
        sentAt = json.string("sentAt")
        ackAt = json.string("ackAt")
        seq = json.double("seq").map { Int($0) }
    }
}

/// `mas/inbox` (RFC 0001 §3): open and recent requests, and commands. Malformed entries are dropped.
public struct Inbox: JSONModel, Encodable, Sendable, Hashable {
    public var pending: [InboxRequest]
    public var recent: [InboxRequest]
    public var commands: [CommandRecord]

    public init(pending: [InboxRequest] = [], recent: [InboxRequest] = [], commands: [CommandRecord] = []) {
        self.pending = pending
        self.recent = recent
        self.commands = commands
    }

    public init(json: JSONValue) {
        pending = json.list("pending").compactMap(InboxRequest.init(json:))
        recent = json.list("recent").compactMap(InboxRequest.init(json:))
        commands = json.list("commands").compactMap(CommandRecord.init(json:))
    }

    public func command(_ cmdId: String) -> CommandRecord? { commands.last { $0.cmdId == cmdId } }
}
