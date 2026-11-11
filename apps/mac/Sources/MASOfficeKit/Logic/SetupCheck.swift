import Foundation

/// The setup checklist (onboarding and Help ▸ Setup Check): what is ready, what is not, and the exact next step.
/// MAS Office never signs anyone in: a backend that is not signed in shows the vendor's own command, which the
/// person runs in their own Terminal.
public enum SetupCheck {
    public enum State: String, Sendable, Hashable { case ready, attention, missing, pending }

    /// What a row offers to do. Every action is local and visible; none signs anyone in.
    public enum Action: Sendable, Hashable {
        case none
        /// Show this command with Copy and Open Terminal (Terminal only opens; the person types or pastes it).
        case command(String)
        case chooseWorkspace
        case createExample
        case lockTeam
        case retryEngine
        case openURL(String)
    }

    public struct Item: Sendable, Hashable, Identifiable {
        public var id: String
        public var title: String
        public var state: State
        public var detail: String
        public var action: Action
        /// Needed to run the team (an unused backend is not).
        public var required: Bool
    }

    /// Everything the checklist is computed from. Pure input: the views fill it from `AppController` and the store.
    public struct Input: Sendable {
        public var attached: Bool
        public var nodeCheck: NodeCheck?
        public var daemon: DaemonState
        /// From the engine (`/v0/session` or the handshake); nil until known.
        public var runtime: Bool?
        public var backends: [String: BackendStatus]?
        public var workspace: URL?
        public var hasProject: Bool
        public var structure: Structure?

        public init(attached: Bool = false, nodeCheck: NodeCheck? = nil, daemon: DaemonState = .notStarted, runtime: Bool? = nil,
                    backends: [String: BackendStatus]? = nil, workspace: URL? = nil, hasProject: Bool = false, structure: Structure? = nil) {
            self.attached = attached
            self.nodeCheck = nodeCheck
            self.daemon = daemon
            self.runtime = runtime
            self.backends = backends
            self.workspace = workspace
            self.hasProject = hasProject
            self.structure = structure
        }
    }

    public static let nodeInstallURL = "https://nodejs.org/en/download"

    static func installCommand(_ backend: String) -> String? {
        switch backend {
        case "claude-code": return "npm install -g @anthropic-ai/claude-code"
        case "codex": return "npm install -g @openai/codex"
        default: return nil
        }
    }

    public static func items(_ x: Input) -> [Item] {
        var out: [Item] = []
        // Workspace
        if x.attached {
            out.append(Item(id: "workspace", title: "Workspace folder", state: .ready, detail: "Chosen by the engine this app is attached to.",
                            action: .none, required: true))
        } else if let w = x.workspace {
            out.append(Item(id: "workspace", title: "Workspace folder", state: .ready, detail: w.path, action: .chooseWorkspace, required: true))
        } else {
            out.append(Item(id: "workspace", title: "Workspace folder", state: .missing,
                            detail: "Choose where your projects, their files and the team's work are kept.", action: .chooseWorkspace, required: true))
        }
        // Node
        if x.attached {
            out.append(Item(id: "node", title: "Node.js", state: .ready, detail: "Not needed here: the attached engine runs on its own.", action: .none, required: true))
        } else {
            switch x.nodeCheck {
            case .found(let url, let v)?:
                out.append(Item(id: "node", title: "Node.js", state: .ready, detail: "Node.js \(v) at \(url.path)", action: .none, required: true))
            case .tooOld(let url, let v)?:
                out.append(Item(id: "node", title: "Node.js", state: .missing,
                                detail: "Node.js \(v) at \(url.path) is older than \(NodeVersion.minimum). Update it, then check again.",
                                action: .command("brew upgrade node"), required: true))
            case .broken(let url, let why)?:
                out.append(Item(id: "node", title: "Node.js", state: .missing, detail: "Node.js at \(url.path) did not start: \(why).",
                                action: .openURL(nodeInstallURL), required: true))
            case .missing?:
                out.append(Item(id: "node", title: "Node.js", state: .missing,
                                detail: "Not found. Install Node.js \(NodeVersion.minimum) or newer from nodejs.org, or with Homebrew:",
                                action: .command("brew install node"), required: true))
            case nil:
                out.append(Item(id: "node", title: "Node.js", state: .pending,
                                detail: x.workspace == nil ? "Checked once a workspace folder is chosen." : "Looking for Node.js…", action: .none, required: true))
            }
        }
        // Engine (the bundled runtime loads and the daemon answers)
        switch x.daemon {
        case .running:
            if x.runtime == false {
                out.append(Item(id: "engine", title: "MAS Office engine", state: .attention,
                                detail: "Running, but it only shows the office: the runtime did not load, so the team cannot run.",
                                action: x.attached ? .none : .retryEngine, required: true))
            } else {
                out.append(Item(id: "engine", title: "MAS Office engine", state: x.runtime == nil ? .pending : .ready,
                                detail: x.runtime == nil ? "Running; reading what it can do…" : "Running, with the runtime that drives your sessions.",
                                action: .none, required: true))
            }
        case .starting(let attempt):
            out.append(Item(id: "engine", title: "MAS Office engine", state: .pending,
                            detail: attempt > 0 ? "Restarting (attempt \(attempt))…" : "Starting…", action: .none, required: true))
        case .failed(let f):
            out.append(Item(id: "engine", title: "MAS Office engine", state: .missing, detail: [f.reason, f.hint].compactMap { $0 }.joined(separator: " "),
                            action: .retryEngine, required: true))
        case .notStarted:
            out.append(Item(id: "engine", title: "MAS Office engine", state: .pending,
                            detail: x.workspace == nil && !x.attached ? "Starts once a workspace folder is chosen." : "Not started.",
                            action: x.workspace == nil ? .none : .retryEngine, required: true))
        }
        // Backends
        let used = Set(RunInfo.backendsUsed(x.structure).isEmpty ? ["claude-code"] : RunInfo.backendsUsed(x.structure))
        for b in ["claude-code", "codex"] {
            let label = BackendStatus.label(b)
            let required = used.contains(b)
            let note = required ? "" : " Your team does not use it."
            guard let all = x.backends else {
                out.append(Item(id: b, title: label, state: .pending, detail: "Checked once the engine runs.", action: .none, required: required))
                continue
            }
            guard let st = all[b] else {
                out.append(Item(id: b, title: label, state: required ? .attention : .pending, detail: "The engine did not report it." + note,
                                action: .none, required: required))
                continue
            }
            if !st.available {
                out.append(Item(id: b, title: label, state: required ? .missing : .attention,
                                detail: "Not installed." + note + " Install it in Terminal, then sign in with its own command.",
                                action: installCommand(b).map(Action.command) ?? .none, required: required))
            } else if !st.loggedIn {
                let cmd = BackendStatus.signInCommand(b)
                out.append(Item(id: b, title: label, state: required ? .missing : .attention,
                                detail: "Installed\(st.version.map { " (\($0))" } ?? ""), not signed in." + note
                                    + " Sign in yourself in Terminal; MAS Office never sees your sign-in.",
                                action: cmd.map(Action.command) ?? .none, required: required))
            } else {
                out.append(Item(id: b, title: label, state: .ready,
                                detail: "Ready" + (st.version.map { " · \($0)" } ?? "") + " · your own sign-in" + (required ? "" : " (not used by this team)"),
                                action: .none, required: required))
            }
        }
        // Team
        if let s = x.structure {
            if s.locked {
                let sig = TeamDesignText.signaturePrefix(s.signature).map { " · \($0)" } ?? ""
                out.append(Item(id: "team", title: "Team design", state: .ready,
                                detail: "\(s.title ?? "The team") is locked\(sig).", action: .none, required: true))
            } else {
                out.append(Item(id: "team", title: "Team design", state: .attention,
                                detail: "\(s.title ?? "The team") is a draft. Read it, then lock it so the roles get exactly these tools.",
                                action: .lockTeam, required: true))
            }
        } else {
            out.append(Item(id: "team", title: "Team design", state: x.workspace == nil && !x.attached ? .pending : .missing,
                            detail: x.hasProject ? "This project has no team design yet." : "No team yet. Start from the example team (a price comparison) and change it later.",
                            action: x.attached ? .none : .createExample, required: true))
        }
        return out
    }

    /// Every required row is ready.
    public static func allReady(_ items: [Item]) -> Bool { items.allSatisfy { !$0.required || $0.state == .ready } }

    /// "2 things to do", or "Ready".
    public static func summary(_ items: [Item]) -> String {
        let todo = items.filter { $0.required && $0.state != .ready && $0.state != .pending }.count
        let waiting = items.filter { $0.required && $0.state == .pending }.count
        if todo == 0 && waiting == 0 { return "Everything is ready." }
        if todo == 0 { return "Checking…" }
        return todo == 1 ? "1 thing to do" : "\(todo) things to do"
    }
}

/// Settings validation (pure where it can be).
public enum SettingsValidation {
    /// Sessions at once: 1–12.
    public static func clampSessions(_ n: Int) -> Int { max(1, min(12, n)) }

    public enum NodePathProblem: Sendable, Equatable {
        case notAbsolute, missing, isDirectory, notExecutable

        public var message: String {
            switch self {
            case .notAbsolute: return "Enter a full path, such as /opt/homebrew/bin/node."
            case .missing: return "No file at that path."
            case .isDirectory: return "That is a folder; choose the node program inside its bin folder."
            case .notExecutable: return "That file cannot be run."
            }
        }
    }

    /// Checks the shape and the file; nil when it looks usable (the version is checked by running it).
    public static func nodePathProblem(_ raw: String, fileManager: FileManager = .default) -> NodePathProblem? {
        let path = (raw.trimmingCharacters(in: .whitespacesAndNewlines) as NSString).expandingTildeInPath
        guard path.hasPrefix("/") else { return .notAbsolute }
        var isDir: ObjCBool = false
        guard fileManager.fileExists(atPath: path, isDirectory: &isDir) else { return .missing }
        if isDir.boolValue { return .isDirectory }
        return fileManager.isExecutableFile(atPath: path) ? nil : .notExecutable
    }

    /// Run `node --version` on a chosen path: `.found` when it is new enough.
    public static func checkNode(at url: URL, environment: [String: String]? = nil) async -> NodeCheck {
        let out = await ProcessRunner.run(url, arguments: ["--version"], environment: environment, timeout: .seconds(10))
        guard out.status == 0, let v = NodeVersion.parse(String(decoding: out.stdout, as: UTF8.self)) else {
            return .broken(url, out.timedOut ? "it did not answer within 10 s" : "it did not report a version")
        }
        return v >= NodeVersion.minimum ? .found(url, v) : .tooOld(url, v)
    }
}
