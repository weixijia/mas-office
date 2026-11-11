import Foundation

/// Runs `mas-office team check|lock|show <project>` with the same Node and engine script the daemon uses, so the
/// app never reimplements the team compiler. Nothing here is a login or touches credentials.
public enum TeamCLI {
    public enum Action: String, Sendable { case check, lock, show }

    public struct Outcome: Sendable, Hashable {
        public var action: String
        public var status: Int32?
        /// Everything the command printed (stdout and stderr, in order).
        public var output: String
        public var problems: [TeamProblem]
        public var timedOut: Bool
        public var launchError: String?

        /// Exit status 0.
        public var ok: Bool { status == 0 }
        public var errors: [TeamProblem] { problems.filter { $0.level == .error } }
        public var warnings: [TeamProblem] { problems.filter { $0.level == .warning } }

        /// The command's own last line ("✓ The team design is valid (2 warnings).", "✓ Locked …: sha256:…"), or
        /// what went wrong running it.
        public var summary: String {
            if let launchError { return "Could not run the check: \(launchError)" }
            if timedOut { return "The check did not finish within 30 seconds." }
            let lines = output.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            if let last = lines.last(where: { $0.hasPrefix("✓") || $0.contains("error") || $0.hasPrefix("✗") }) {
                return last.hasPrefix("✓ ") || last.hasPrefix("✗ ") ? String(last.dropFirst(2)) : last
            }
            return ok ? "Done." : "The command stopped with exit code \(status.map(String.init) ?? "?")."
        }
    }

    /// The arguments after the script: `team <action> <project> [--workspace <ws>]`.
    public static func arguments(_ action: Action, project: URL, workspace: URL?) -> [String] {
        var a = ["team", action.rawValue, project.path]
        if let workspace { a += ["--workspace", workspace.path] }
        return a
    }

    /// Run it. The output is read through `/bin/sh -c 'exec "$0" "$@" 2>&1'` so the CLI's error lines (stderr) are
    /// kept in order with its report (stdout); every value is passed as an argument, never interpolated.
    public static func run(_ action: Action, project: URL, workspace: URL?, node: URL, script: URL,
                           environment: [String: String]?, timeout: Duration = .seconds(30)) async -> Outcome {
        let argv = [node.path, script.path] + arguments(action, project: project, workspace: workspace)
        let out = await ProcessRunner.run(URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", "exec \"$0\" \"$@\" 2>&1"] + argv,
                                          environment: environment, currentDirectory: workspace ?? project.deletingLastPathComponent(),
                                          timeout: timeout)
        let text = String(decoding: out.stdout, as: UTF8.self)
        return Outcome(action: action.rawValue, status: out.status, output: text, problems: TeamProblem.parse(text),
                       timedOut: out.timedOut, launchError: out.launchError)
    }
}

/// Creates a project from the bundled example team design (`examples/price-compare/mas/structure.js`), unlocked so
/// the person reads and locks it themselves, and lists it in `home/projects` as the current project.
public enum ExampleTeam {
    public static let resourcePath = "examples/price-compare/structure.js"

    /// The bundled example: inside the app (`Resources/examples/…`), else the repository this binary was built in.
    public static func locate(bundle: Bundle = .main) -> URL? {
        let fm = FileManager.default
        if let r = bundle.resourceURL?.appendingPathComponent(resourcePath), fm.fileExists(atPath: r.path) { return r }
        var dir = URL(fileURLWithPath: CommandLine.arguments.first ?? "").resolvingSymlinksInPath().deletingLastPathComponent()
        for _ in 0..<8 {
            let candidate = dir.appendingPathComponent("examples/price-compare/mas/structure.js")
            if fm.fileExists(atPath: candidate.path) { return candidate }
            dir.deleteLastPathComponent()
        }
        return nil
    }

    public enum Failure: Error, Sendable, Equatable, LocalizedError {
        case unreadable(String)
        case noFolderName

        public var errorDescription: String? {
            switch self {
            case .unreadable(let why): return "The example team design could not be read (\(why))."
            case .noFolderName: return "No free project folder name was found in the workspace."
            }
        }
    }

    /// The design with `locked` false and no `signature` (pure).
    public static func unlockedDesign(from twinText: String) throws -> JSONValue {
        guard case .object(var o)? = JSTwin.parse(twinText).globals[ProjectSnapshot.Document.structure.global] else {
            throw Failure.unreadable("no MAS_STRUCTURE in the file")
        }
        o["locked"] = .bool(false)
        o.removeValue(forKey: "signature")
        return .object(o)
    }

    /// `base`, `base-2`, `base-3`… the first that does not exist in `workspace`.
    public static func freeFolder(_ base: String, in workspace: URL, fileManager: FileManager = .default) -> String? {
        for n in 1...99 {
            let name = n == 1 ? base : "\(base)-\(n)"
            if !fileManager.fileExists(atPath: workspace.appendingPathComponent(name).path) { return name }
        }
        return nil
    }

    /// Write `<workspace>/<folder>/mas/structure.{json,js}` and add the project to `home/projects`. Returns the
    /// project folder.
    @discardableResult
    public static func create(in workspace: URL, from example: URL, folder: String = "price-compare") throws -> URL {
        let text: String
        do { text = try String(contentsOf: example, encoding: .utf8) } catch { throw Failure.unreadable(error.localizedDescription) }
        let design = try unlockedDesign(from: text)
        guard let name = freeFolder(folder, in: workspace) else { throw Failure.noFolderName }
        let project = workspace.appendingPathComponent(name, isDirectory: true)
        try writeDocument(project.appendingPathComponent("mas/structure"), global: "MAS_STRUCTURE", value: design)
        let title = design.nonEmpty("title") ?? name
        try addToProjects(workspace: workspace, entry: ["folder": .string(name), "title": .string(title), "step": 3, "phase": "design"])
        return project
    }

    /// Insert or update one entry of `home/projects` and make it current (`updateProjectsIndex` in the SDK).
    static func addToProjects(workspace: URL, entry: [String: JSONValue]) throws {
        let base = workspace.appendingPathComponent("home/projects")
        var home: [String: JSONValue] = [:]
        if let data = try? Data(contentsOf: base.appendingPathExtension("json")), case .object(let o)? = try? JSONValue.parse(data) {
            home = o
        } else if let t = try? String(contentsOf: base.appendingPathExtension("js"), encoding: .utf8), case .object(let o)? = JSTwin.parse(t).globals["MAS_HOME"] {
            home = o
        }
        var list = (home["projects"]?.array ?? []).filter(\.isObject)
        let folder = entry["folder"]?.string
        if let k = list.firstIndex(where: { $0.string("folder") == folder }), case .object(var old) = list[k] {
            old.merge(entry) { _, new in new }
            list[k] = .object(old)
        } else {
            list.append(.object(entry))
        }
        home["projects"] = .array(list)
        home["current"] = folder.map(JSONValue.string) ?? .null
        try writeDocument(base, global: "MAS_HOME", value: .object(home))
    }

    /// The JSON file and its `.js` twin, each written atomically.
    static func writeDocument(_ base: URL, global: String, value: JSONValue) throws {
        try FileManager.default.createDirectory(at: base.deletingLastPathComponent(), withIntermediateDirectories: true)
        let json = value.jsonText(pretty: true)
        try Data((json + "\n").utf8).write(to: base.appendingPathExtension("json"), options: .atomic)
        try Data("window.\(global) = \(json);\n".utf8).write(to: base.appendingPathExtension("js"), options: .atomic)
    }
}
