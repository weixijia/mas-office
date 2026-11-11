import Foundation

/// Sentences for the read-only team inspector, in the words `mas-office team show` uses.
public enum TeamDesignText {
    /// "a", "a and b", "a, b and c".
    public static func join(_ items: [String]) -> String {
        guard items.count > 1 else { return items.first ?? "" }
        return items.dropLast().joined(separator: ", ") + " and " + items.last!
    }

    /// A delegation rule as one sentence (`summarizeRule` in packages/node/src/policy/delegate.js).
    public static func delegationSentence(_ rule: JSONValue, structure: Structure?) -> String {
        let nameOf = { (id: String) in structure?.role(id)?.name ?? id }
        let tools = rule.strings("tools")
        let kind = rule.nonEmpty("kind")
        let kindWords = ["approval": "approval requests", "question": "questions", "decision": "decisions"]
        let kindText = kind.map { kindWords[$0] ?? "\($0) requests" }
        let types = rule.strings("subjectTypes")
        let typesText = types.isEmpty ? "" : " about " + join(types.map { $0.replacingOccurrences(of: "_", with: " ") })
        let what: String
        if !tools.isEmpty { what = join(tools) } else if let kindText { what = kindText + typesText } else { what = "every request" + typesText }
        let verb = kind == nil || kind == "approval" ? "approve" : "answer"
        var s: String
        switch rule.string("effect") {
        case "allow": s = tools.isEmpty ? "Answer \(what) automatically" : "Approve \(what) automatically"
        case "lead": s = "The Lead may \(verb) \(what)"
        default: s = "Always ask me about \(what)"
        }
        let roles = rule.strings("roles")
        if !roles.isEmpty { s += " for " + join(roles.map(nameOf)) }
        if let max = rule.int("max") { s += ", up to \(max) time" + (max == 1 ? "" : "s") }
        if let e = rule.nonEmpty("expires") { s += ", until \(e)" }
        return s + "."
    }

    /// Tools in words: "Uses web search.", "Asks you first: browse the web.", "Not allowed: run commands."
    public static func toolSentences(_ tools: [ToolGrant]) -> [(effect: ToolGrant.Effect, text: String)] {
        let allow = tools.filter { $0.effect == .allow }.map(\.name)
        let ask = tools.filter { $0.effect == .ask }.map(\.name)
        let deny = tools.filter { $0.effect == .deny }.map(\.name)
        var out: [(ToolGrant.Effect, String)] = []
        if !allow.isEmpty { out.append((.allow, "Uses " + join(allow) + ".")) }
        if !ask.isEmpty { out.append((.ask, "Asks you first: " + join(ask) + ".")) }
        if !deny.isEmpty { out.append((.deny, "Not allowed: " + join(deny) + ".")) }
        if out.isEmpty { out.append((.deny, "No tools.")) }
        return out.map { (effect: $0.0, text: $0.1) }
    }

    /// The budget as sentences.
    public static func budgetSentences(_ b: TeamBudget?) -> [String] {
        guard let b else { return [] }
        var out: [String] = []
        if let n = b.maxParallel { out.append("At most \(n) " + (n == 1 ? "role works" : "roles work") + " at once.") }
        if let n = b.maxTurnMinutes { out.append("A turn stops after \(n) min.") }
        if let n = b.maxRunMinutes { out.append("A run stops after \(n) min.") }
        if let n = b.maxQuestionsPerRole { out.append("Each role asks you at most \(n) " + (n == 1 ? "question." : "questions.")) }
        return out
    }

    /// "Claims are checked one by one against their sources. Links are checked."
    public static func verifySentences(_ v: JSONValue?) -> [String] {
        guard let v, v.isObject else { return [] }
        var out: [String] = []
        if v.bool("claims") == true { out.append("Claims in the answer are checked one by one against their sources.") }
        if v.bool("urlHealth") == true { out.append("Every cited link is opened to see whether it is live.") }
        return out
    }

    /// A gate in words: "After Search in parallel: Look at the offers before they are checked. Waits for you."
    public static func gateSentence(_ g: TeamGate, structure: Structure) -> String {
        let after: String = {
            guard let a = g.after else { return "Before the answer" }
            let groups = structure.orderedGroups
            guard let k = groups.firstIndex(where: { $0.id == a }) else { return "After stage \(a)" }
            let label = groups[k].label?.isEmpty == false ? groups[k].label! : "stage \(k + 1)"
            return "After \(label)"
        }()
        let title = g.title.isEmpty ? "A \(g.kind) gate" : g.title
        return "\(after): \(title)." + (g.blocking ? " The team waits for you." : " The team does not wait.")
    }

    /// Who receives this role's work and whose work it checks.
    public static func relationSentences(_ r: TeamRole, structure: Structure) -> [String] {
        var out: [String] = []
        out.append("Hands its work to \(structure.name(of: r.handsTo)).")
        if !r.reviewerOf.isEmpty {
            out.append("Checks the work of " + join(r.reviewerOf.map { structure.name(of: $0) })
                       + (r.cleanContext ? " in a clean context (it does not see how the work was made)." : "."))
        }
        let reviewers = structure.roles.filter { $0.reviewerOf.contains(r.id) }.map(\.name)
        if !reviewers.isEmpty { out.append("Checked by " + join(reviewers) + ".") }
        return out
    }

    /// "sha256:f4a5b427…" (the first 12 hex digits).
    public static func signaturePrefix(_ sig: String?) -> String? {
        guard let sig, !sig.isEmpty else { return nil }
        let parts = sig.split(separator: ":", maxSplits: 1)
        if parts.count == 2 { return "\(parts[0]):\(parts[1].prefix(12))…" }
        return String(sig.prefix(16)) + "…"
    }
}

/// One problem `mas-office team check` reported.
public struct TeamProblem: Sendable, Hashable, Identifiable {
    public enum Level: String, Sendable, Hashable { case error, warning }
    public var level: Level
    /// JSON pointer into the design ("/roles/2/backend"), or "(root)".
    public var path: String
    public var message: String
    public var id: String { "\(level.rawValue)|\(path)|\(message)" }

    /// Parse the CLI's lines: `✗ /path: message` (error) and `! /path: message` (warning). Other lines are not
    /// problems.
    public static func parse(_ output: String) -> [TeamProblem] {
        output.split(whereSeparator: \.isNewline).compactMap { raw in
            let line = raw.trimmingCharacters(in: .whitespaces)
            let level: Level
            if line.hasPrefix("✗ ") { level = .error } else if line.hasPrefix("! ") { level = .warning } else { return nil }
            let body = line.dropFirst(2)
            // The summary lines ("✗ … the team cannot be locked yet") have no "path: " part.
            guard let colon = body.range(of: ": ") else { return TeamProblem(level: level, path: "(root)", message: String(body)) }
            let path = String(body[..<colon.lowerBound])
            guard path.hasPrefix("/") || path == "(root)" else { return TeamProblem(level: level, path: "(root)", message: String(body)) }
            return TeamProblem(level: level, path: path, message: String(body[colon.upperBound...]))
        }
    }

    /// The part of the design a path points at, in words: "/roles/2/backend" → "Budget checker · backend".
    public func place(in s: Structure?) -> String {
        let parts = path.split(separator: "/").map(String.init)
        guard let head = parts.first else { return "Team" }
        switch head {
        case "roles":
            if parts.count > 1, let k = Int(parts[1]), let s, k < s.roles.count {
                return ([s.roles[k].name] + parts.dropFirst(2)).joined(separator: " · ")
            }
            return "Roles"
        case "lead": return (["Lead"] + parts.dropFirst()).joined(separator: " · ")
        case "groups": return "Stages"
        case "gates": return "Gates"
        case "budget": return "Budget"
        case "signature": return "Lock"
        default: return parts.joined(separator: " · ")
        }
    }
}
