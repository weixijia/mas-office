// Adapted from deepseek-ai/deepseek-harness@fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159 apps/desktop/src/login-shell-environment.ts (MIT)
// The NUL-delimited `env -0` dump read from an interactive login shell, completed at the closing delimiter,
// with the probe-only variables that keep rc files from blocking.
import Foundation

/// The user's login-shell environment. A GUI app launched from Finder or the Dock does not inherit the PATH
/// the user's shell sets up (Homebrew, nvm, fnm, Volta…), so it is read once at launch from `$SHELL -ilc`.
///
/// The variables may hold secrets: they are never printed or logged (`description` shows only a count), and
/// the daemon gets only `daemonEnvironment()`, a minimal allow-list.
public struct ShellEnvironment: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public enum Source: Sendable, Equatable {
        /// Read from this login shell.
        case loginShell(String)
        /// The shell could not be read; common install locations are used instead.
        case fallback(String)
    }

    public let variables: [String: String]
    public let source: Source

    public init(variables: [String: String], source: Source) {
        self.variables = variables
        self.source = source
    }

    public var description: String { "ShellEnvironment(\(variables.count) variables, \(source))" }
    public var debugDescription: String { description }

    static let delimiter = "_MAS_OFFICE_SHELL_ENV_DELIMITER_"
    /// Printed by the probe shell: delimiter, `env -0`, delimiter, all NUL-separated.
    static let dumpCommand = "printf '\\0%s\\0' '\(delimiter)'; command env -0 || exit; printf '\\0%s\\0' '\(delimiter)'; exit"
    /// Keep oh-my-zsh update prompts and tmux autostart plugins from blocking a non-terminal read.
    static let probeVariables = ["DISABLE_AUTO_UPDATE": "true", "ZSH_TMUX_AUTOSTARTED": "true", "ZSH_TMUX_AUTOSTART": "false"]
    /// Variables that describe the probe shell process, not the user's configuration.
    static let sessionKeys: Set<String> = Set(["PWD", "OLDPWD", "SHLVL", "_"]).union(probeVariables.keys)

    /// The variables between the two delimiters of the dump, or nil when both are not there. Pure.
    public static func parseDump(_ data: Data) -> [String: String]? {
        let parts = data.split(separator: 0, omittingEmptySubsequences: false)
        let marker = Data(delimiter.utf8)
        guard let first = parts.firstIndex(where: { Data($0) == marker }),
              let last = parts.lastIndex(where: { Data($0) == marker }), first < last else { return nil }
        var out: [String: String] = [:]
        for entry in parts[(first + 1)..<last] {
            guard let eq = entry.firstIndex(of: 0x3D), eq > entry.startIndex else { continue }
            let key = String(decoding: entry[entry.startIndex..<eq], as: UTF8.self)
            if sessionKeys.contains(key) { continue }
            out[key] = String(decoding: entry[(eq + 1)...], as: UTF8.self)
        }
        return out
    }

    /// Whether `data` already holds both delimiters (the read can stop: rc files may leave children holding
    /// stdout open long after the shell exits).
    static func dumpComplete(_ data: Data) -> Bool {
        let marker = Data(("\u{0}" + delimiter + "\u{0}").utf8)
        guard let a = data.range(of: marker) else { return false }
        return data.range(of: marker, in: a.upperBound..<data.endIndex) != nil
    }

    /// Candidate shells: the account's login shell, `$SHELL`, then the system shells.
    static func candidateShells(environment: [String: String]) -> [String] {
        var out: [String] = []
        if let pw = getpwuid(getuid()), let shell = pw.pointee.pw_shell {
            out.append(String(cString: shell))
        }
        if let s = environment["SHELL"] { out.append(s) }
        out += ["/bin/zsh", "/bin/bash", "/bin/sh"]
        var seen = Set<String>()
        return out.filter { !$0.isEmpty && $0.hasPrefix("/") && seen.insert($0).inserted }
    }

    /// Read the login-shell environment once. Never fails: falls back to the inherited environment with the
    /// common install locations added to PATH.
    public static func capture(timeout: Duration = .seconds(10), inherited: [String: String] = ProcessInfo.processInfo.environment) async -> ShellEnvironment {
        let home = inherited["HOME"] ?? NSHomeDirectory()
        var failures: [String] = []
        for shell in candidateShells(environment: inherited) {
            guard FileManager.default.isExecutableFile(atPath: shell) else { continue }
            var env = inherited
            env.merge(probeVariables) { _, new in new }
            let out = await ProcessRunner.run(URL(fileURLWithPath: shell), arguments: ["-ilc", dumpCommand], environment: env,
                                              currentDirectory: URL(fileURLWithPath: home), timeout: timeout,
                                              done: { dumpComplete($0) })
            if let vars = parseDump(out.stdout) {
                var merged = inherited
                merged.merge(vars) { _, shellValue in shellValue }
                return ShellEnvironment(variables: merged, source: .loginShell(shell))
            }
            failures.append("\((shell as NSString).lastPathComponent): \(out.timedOut ? "timeout" : out.launchError ?? "unparsed")")
        }
        return ShellEnvironment(variables: inherited, source: .fallback(failures.joined(separator: "; ")))
    }

    /// Directories where Node is commonly installed, for when PATH does not have it. Pure apart from listing
    /// the nvm and fnm version folders.
    public static func fallbackPath(home: String, fileManager: FileManager = .default) -> [String] {
        var dirs = ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin", "\(home)/.volta/bin"]
        // nvm: the newest installed version.
        let nvm = "\(home)/.nvm/versions/node"
        if let versions = try? fileManager.contentsOfDirectory(atPath: nvm) {
            let sorted = versions.compactMap { v in NodeVersion.parse(v).map { (v, $0) } }.sorted { $0.1 > $1.1 }
            dirs += sorted.map { "\(nvm)/\($0.0)/bin" }
        }
        // fnm: its default alias.
        dirs += ["\(home)/Library/Application Support/fnm/aliases/default/bin", "\(home)/.fnm/aliases/default/bin",
                 "\(home)/.local/share/fnm/aliases/default/bin", "/usr/bin", "/bin"]
        return dirs
    }

    /// PATH entries, then the fallback locations, without duplicates.
    public var searchPath: [String] {
        let home = variables["HOME"] ?? NSHomeDirectory()
        var seen = Set<String>()
        let own = (variables["PATH"] ?? "").split(separator: ":").map(String.init)
        return (own + Self.fallbackPath(home: home)).filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    /// The first executable named `program` on `searchPath`.
    public func locate(_ program: String, fileManager: FileManager = .default) -> URL? {
        for dir in searchPath {
            let path = (dir as NSString).appendingPathComponent(program)
            var isDir: ObjCBool = false
            if fileManager.fileExists(atPath: path, isDirectory: &isDir), !isDir.boolValue, fileManager.isExecutableFile(atPath: path) {
                return URL(fileURLWithPath: path)
            }
        }
        return nil
    }

    /// The minimal environment for the daemon. Pure: an allow-list, never the whole environment.
    public static func minimal(from env: [String: String]) -> [String: String] {
        let exact: Set<String> = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TERM",
                                  "http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY",
                                  "no_proxy", "NO_PROXY", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]
        return env.filter { key, _ in exact.contains(key) || key.hasPrefix("LC_") || key.hasPrefix("XDG_") }
    }

    /// What the daemon gets: the allow-list, with PATH extended by the fallback locations so sessions find
    /// `claude`, `codex` and `node` as the user's terminal would.
    public func daemonEnvironment() -> [String: String] {
        var env = Self.minimal(from: variables)
        env["PATH"] = searchPath.joined(separator: ":")
        if env["HOME"] == nil { env["HOME"] = NSHomeDirectory() }
        return env
    }
}

/// A Node.js version (`v20.11.1`).
public struct NodeVersion: Sendable, Hashable, Comparable, CustomStringConvertible {
    public var major: Int
    public var minor: Int
    public var patch: Int

    public init(_ major: Int, _ minor: Int, _ patch: Int) {
        self.major = major
        self.minor = minor
        self.patch = patch
    }

    /// The runtime's floor (`engines` in packages/runtime/package.json).
    public static let minimum = NodeVersion(18, 14, 0)

    /// "v20.11.1", "20.11.1\n", "v22.0.0-nightly…" → the version; anything else → nil.
    public static func parse(_ text: String) -> NodeVersion? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("v") { s.removeFirst() }
        let core = s.split(whereSeparator: { $0 == "-" || $0 == "+" }).first.map(String.init) ?? ""
        let parts = core.split(separator: ".").map { Int($0) }
        guard parts.count == 3, let a = parts[0], let b = parts[1], let c = parts[2] else { return nil }
        return NodeVersion(a, b, c)
    }

    public static func < (l: NodeVersion, r: NodeVersion) -> Bool {
        (l.major, l.minor, l.patch) < (r.major, r.minor, r.patch)
    }

    public var description: String { "\(major).\(minor).\(patch)" }
}

/// Whether a usable Node is installed.
public enum NodeCheck: Sendable, Equatable {
    case found(URL, NodeVersion)
    case tooOld(URL, NodeVersion)
    case missing
    /// Found but `node --version` did not answer sensibly.
    case broken(URL, String)

    public var node: URL? {
        if case .found(let url, _) = self { return url }
        return nil
    }

    /// Find `node` on the login-shell PATH (and the common install locations) and check its version.
    public static func run(in env: ShellEnvironment) async -> NodeCheck {
        guard let node = env.locate("node") else { return .missing }
        let out = await ProcessRunner.run(node, arguments: ["--version"], environment: env.daemonEnvironment(), timeout: .seconds(10))
        guard out.status == 0, let v = NodeVersion.parse(String(decoding: out.stdout, as: UTF8.self)) else {
            return .broken(node, out.timedOut ? "it did not answer within 10 s" : "it did not report a version")
        }
        return v >= NodeVersion.minimum ? .found(node, v) : .tooOld(node, v)
    }
}
