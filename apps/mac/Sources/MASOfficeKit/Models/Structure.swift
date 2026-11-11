import Foundation

/// One tool a role may use: written as a string (effect `allow`) or `{"name", "effect"}` (runtime.md §5).
public struct ToolGrant: JSONModel, Encodable, Sendable, Hashable {
    public enum Effect: String, Sendable, Codable, Hashable { case allow, ask, deny }
    public var name: String
    public var effect: Effect

    public init(name: String, effect: Effect = .allow) {
        self.name = name
        self.effect = effect
    }

    /// Empty name when the entry is neither a string nor an object with a string `name`.
    public init(json: JSONValue) {
        if let s = json.string {
            self.init(name: s)
        } else {
            self.init(name: json.string("name") ?? "", effect: Effect(rawValue: json.string("effect") ?? "") ?? .allow)
        }
    }

    /// "browse the web (asks first)", "run commands (not allowed)", "web search".
    public var text: String {
        switch effect {
        case .allow: return name
        case .ask: return name + " (asks first)"
        case .deny: return name + " (not allowed)"
        }
    }
}

/// A stage: roles in one group run at the same time; `after` names the group it waits for.
public struct TeamGroup: JSONModel, Encodable, Sendable, Hashable, Identifiable {
    public var id: String
    public var label: String?
    public var after: String?

    public init(json: JSONValue) {
        id = json.string("id") ?? ""
        label = json.string("label")
        after = json.nonEmpty("after")
    }
}

public struct TeamLead: JSONModel, Encodable, Sendable, Hashable {
    public var id: String
    public var name: String
    public var emoji: String?
    public var job: String?
    public var backend: String?
    public var model: String?
    public var serves: [String]

    public init(json: JSONValue) {
        id = "lead"
        name = json.nonEmpty("name") ?? "Lead"
        emoji = json.nonEmpty("emoji")
        job = json.string("job")
        backend = json.nonEmpty("backend")
        model = json.nonEmpty("model")
        serves = json.strings("serves")
    }
}

public struct TeamRole: JSONModel, Encodable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var emoji: String?
    public var job: String?
    public var group: String?
    /// Where the role's output goes: a role id or `lead` (the default).
    public var handsTo: String
    public var backend: String?
    public var model: String?
    public var tools: [ToolGrant]
    public var output: String?
    public var reviewerOf: [String]
    public var cleanContext: Bool
    public var serves: [String]
    /// Appeared at runtime (not designed), spawned by `parent`.
    public var dynamic: Bool
    public var parent: String?
    public var why: String?

    public init(json: JSONValue) {
        id = json.string("id") ?? ""
        name = json.nonEmpty("name") ?? id
        emoji = json.nonEmpty("emoji")
        job = json.string("job")
        group = json.nonEmpty("group")
        handsTo = json.nonEmpty("handsTo") ?? "lead"
        backend = json.nonEmpty("backend")
        model = json.nonEmpty("model")
        tools = json.list("tools").map(ToolGrant.init(json:)).filter { !$0.name.isEmpty }
        output = json.string("output")
        reviewerOf = json.strings("reviewerOf")
        cleanContext = json.bool("cleanContext") ?? false
        serves = json.strings("serves")
        dynamic = json.bool("dynamic") ?? false
        parent = json.nonEmpty("parent")
        why = json.string("why")
    }

    /// Tools the role really has (a denied tool is not one it has).
    public var usableTools: [ToolGrant] { tools.filter { $0.effect != .deny } }
}

public struct TeamGate: JSONModel, Encodable, Sendable, Hashable, Identifiable {
    public var id: String
    /// The group it follows; nil for a final gate.
    public var after: String?
    public var kind: String
    public var title: String
    public var blocking: Bool

    public init(json: JSONValue) {
        id = json.string("id") ?? ""
        after = json.nonEmpty("after")
        kind = json.nonEmpty("kind") ?? "stage"
        title = json.string("title") ?? ""
        blocking = json.bool("blocking") ?? true
    }
}

public struct TeamBudget: JSONModel, Encodable, Sendable, Hashable {
    public var maxParallel: Int?
    public var maxTurnMinutes: Int?
    public var maxRunMinutes: Int?
    public var maxQuestionsPerRole: Int?

    public init(json: JSONValue) {
        maxParallel = json.int("maxParallel")
        maxTurnMinutes = json.int("maxTurnMinutes")
        maxRunMinutes = json.int("maxRunMinutes")
        maxQuestionsPerRole = json.int("maxQuestionsPerRole")
    }
}

/// `mas/structure`: the team (spec §2.1, team design v2 in runtime.md §5).
public struct Structure: JSONModel, Encodable, Sendable, Hashable {
    public var title: String?
    public var version: Int?
    public var locked: Bool
    public var topology: String
    public var signature: String?
    public var lead: TeamLead
    public var groups: [TeamGroup]
    public var roles: [TeamRole]
    public var gates: [TeamGate]
    public var budget: TeamBudget?
    public var rationale: String?
    /// Free-form parts kept as given: `verify`, `lead.delegate`.
    public var verify: JSONValue?
    public var delegate: [JSONValue]

    public init(json: JSONValue) {
        title = json.nonEmpty("title")
        version = json.int("version")
        locked = json.bool("locked") ?? false
        topology = json.nonEmpty("topology") ?? "staged"
        signature = json.nonEmpty("signature")
        lead = TeamLead(json: json.objectValue("lead") ?? .object([:]))
        groups = json.list("groups").filter(\.isObject).map(TeamGroup.init(json:)).filter { !$0.id.isEmpty }
        var seen = Set<String>()
        roles = json.list("roles").filter(\.isObject).map(TeamRole.init(json:))
            .filter { !$0.id.isEmpty && $0.id != "lead" && seen.insert($0.id).inserted }
        gates = json.list("gates").filter(\.isObject).map(TeamGate.init(json:)).filter { !$0.id.isEmpty }
        budget = json.objectValue("budget").map(TeamBudget.init(json:))
        rationale = json.string("rationale")
        verify = json["verify"]
        delegate = json.objectValue("lead")?.list("delegate") ?? []
    }

    /// The lead first, then the roles in design order.
    public var memberIds: [String] { ["lead"] + roles.map(\.id) }

    public func role(_ id: String) -> TeamRole? { roles.first { $0.id == id } }

    /// The display name of an agent: its designed name, "Lead", or the id itself.
    public func name(of id: String) -> String {
        if id == "lead" { return lead.name }
        return role(id)?.name ?? id
    }

    public func emoji(of id: String) -> String? {
        id == "lead" ? lead.emoji : role(id)?.emoji
    }

    /// Groups in run order: each after the group it names, unknown or cyclic ones last in file order.
    public var orderedGroups: [TeamGroup] {
        var out: [TeamGroup] = []
        var placed = Set<String>()
        var frontier: [String?] = [nil]
        while !frontier.isEmpty {
            let next = groups.filter { g in !placed.contains(g.id) && frontier.contains(where: { $0 == g.after }) }
            for g in next { placed.insert(g.id); out.append(g) }
            frontier = next.map { Optional($0.id) }
        }
        out += groups.filter { !placed.contains($0.id) }
        return out
    }

    /// The roles of one group, in design order.
    public func members(ofGroup id: String) -> [TeamRole] { roles.filter { $0.group == id } }
}
