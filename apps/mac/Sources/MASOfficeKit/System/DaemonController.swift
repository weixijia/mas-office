import Foundation
import os

/// What `mas-office up --json` prints once it is ready. The token lives in memory only: `description` hides it,
/// it is never written to disk or put into a URL a person can see.
public struct DaemonInfo: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
    public var url: URL
    public var port: Int
    public var token: String
    public var backends: [String: BackendStatus]
    public var maxParallel: Int?

    public init(url: URL, port: Int, token: String, backends: [String: BackendStatus] = [:], maxParallel: Int? = nil) {
        self.url = url
        self.port = port
        self.token = token
        self.backends = backends
        self.maxParallel = maxParallel
    }

    public var description: String { "DaemonInfo(url: \(url.absoluteString), token: <redacted>, backends: \(backends.keys.sorted()))" }
    public var debugDescription: String { description }

    /// Parse the handshake line. Throws when it is not the expected JSON object, or the URL is not loopback.
    public static func parseHandshake(_ line: String) throws -> DaemonInfo {
        guard let v = try? JSONValue.parse(line), v.isObject else { throw DaemonFailure.badHandshake("not a JSON object") }
        guard let s = v.string("url"), let url = URL(string: s), let host = url.host, ["127.0.0.1", "localhost", "::1", "[::1]"].contains(host) else {
            throw DaemonFailure.badHandshake("no loopback url")
        }
        guard let token = v.nonEmpty("token") else { throw DaemonFailure.badHandshake("no token") }
        let port = v.int("port") ?? url.port ?? 0
        let backends = (v["backends"]?.object ?? [:]).compactMapValues { $0.isObject ? BackendStatus(json: $0) : nil }
        return DaemonInfo(url: url, port: port, token: token, backends: backends, maxParallel: v.int("maxParallel"))
    }
}

/// Why the engine is not running, with a hint a person can act on.
public enum DaemonFailure: Error, Sendable, Equatable {
    case nodeNotFound
    case nodeTooOld(found: String, path: String)
    case nodeBroken(path: String, detail: String)
    case portInUse
    case engineMissing(String)
    case workspaceMissing(String)
    case launchFailed(String)
    case badHandshake(String)
    case handshakeTimeout
    case crashLoop(count: Int, lastLine: String?)
    case exited(code: Int32, lastLine: String?)

    /// One line: what happened.
    public var reason: String {
        switch self {
        case .nodeNotFound: return "Node.js was not found."
        case .nodeTooOld(let v, _): return "Node.js \(v) is too old."
        case .nodeBroken(let path, _): return "Node.js at \(path) did not start."
        case .portInUse: return "The engine's port is already in use."
        case .engineMissing: return "The engine files are missing."
        case .workspaceMissing(let path): return "The workspace folder \(path) does not exist."
        case .launchFailed(let detail): return "The engine could not start (\(detail))."
        case .badHandshake(let detail): return "The engine answered something unexpected (\(detail))."
        case .handshakeTimeout: return "The engine did not get ready in time."
        case .crashLoop(let n, _): return "The engine stopped \(n) times within a minute."
        case .exited(let code, _): return "The engine stopped (exit code \(code))."
        }
    }

    /// What to do about it.
    public var hint: String? {
        switch self {
        case .nodeNotFound:
            return "MAS Office runs its engine with the Node.js you have installed (18.14 or newer). Install it from nodejs.org or with Homebrew (brew install node), then choose Try Again."
        case .nodeTooOld(_, let path):
            return "MAS Office needs Node.js 18.14 or newer; the one at \(path) is older. Update it (for example brew upgrade node, or nvm install --lts), then choose Try Again."
        case .nodeBroken(_, let detail):
            return "Running node --version failed: \(detail). Check that Node.js works in Terminal, then choose Try Again."
        case .portInUse:
            return "Another program is using the port. Quit it or choose Try Again (the engine picks a free port)."
        case .engineMissing:
            return "The app's engine files are damaged. Reinstall MAS Office."
        case .workspaceMissing:
            return "Choose a workspace folder in Settings."
        case .crashLoop(_, let line), .exited(_, let line):
            return line.map { "Last message: \($0)" }
        default:
            return nil
        }
    }
}

/// The engine's lifecycle as the app shows it.
public enum DaemonState: Sendable, Equatable {
    case notStarted
    /// Starting, or restarting after an unexpected exit (`attempt` > 0).
    case starting(attempt: Int)
    case running(DaemonInfo)
    case failed(DaemonFailure)

    public var info: DaemonInfo? {
        if case .running(let i) = self { return i }
        return nil
    }

    public var failure: DaemonFailure? {
        if case .failed(let f) = self { return f }
        return nil
    }
}

/// How to start the daemon.
public struct DaemonConfiguration: Sendable {
    public var node: URL
    /// `…/node_modules/mas-office/bin/mas-office.js`
    public var script: URL
    public var workspace: URL
    public var maxParallel: Int
    /// The child's whole environment (see `ShellEnvironment.daemonEnvironment()`).
    public var environment: [String: String]
    public var handshakeTimeout: Duration = .seconds(30)
    /// Unexpected exits allowed within `restartWindow` before giving up.
    public var maxRestarts = 3
    public var restartWindow: Duration = .seconds(60)
    /// After stdin closes, how long the daemon gets to shut down before SIGTERM, then SIGKILL.
    public var stopGrace: Duration = .seconds(3)
    /// The first restart waits this long; each next one twice as long.
    public var restartBaseDelay: Duration = .seconds(1)
    /// Where the daemon's messages for people (stderr) are appended, with the token redacted. Nil: memory only.
    public var logFile: URL?

    public init(node: URL, script: URL, workspace: URL, maxParallel: Int = 3, environment: [String: String]) {
        self.node = node
        self.script = script
        self.workspace = workspace
        self.maxParallel = maxParallel
        self.environment = environment
    }

    public var arguments: [String] {
        [script.path, "up", workspace.path, "--port", "0", "--max-parallel", String(maxParallel), "--json"]
    }

    /// Delay before restart number `n` (1-based): 1, 2, 4 s with the default base.
    public func restartDelay(_ n: Int) -> Duration { restartBaseDelay * (1 << max(0, min(n - 1, 5))) }
}

/// A synchronous way to stop the running child, for the one place that cannot wait for the actor: the app's
/// quit (AppKit's terminate loop does not run Swift tasks). Closing stdin is enough for a healthy daemon; the
/// signals are for one that hangs.
public final class DaemonLifeline: Sendable {
    private struct Child: Sendable {
        var pid: Int32
        var stdin: FileHandle
    }
    private let child = OSAllocatedUnfairLock<Child?>(initialState: nil)

    func set(pid: Int32, stdin: FileHandle) { child.withLock { $0 = Child(pid: pid, stdin: stdin) } }
    func clear() { child.withLock { $0 = nil } }

    /// Close the child's stdin and wait (blocking) up to `grace` seconds for it to exit, then SIGTERM, then
    /// SIGKILL. Returns true when it is gone. No child: true at once.
    @discardableResult
    public func stopBlocking(grace: TimeInterval = 3) -> Bool {
        guard let c = child.withLock({ current -> Child? in
            let c = current
            current = nil
            return c
        }) else { return true }
        try? c.stdin.close()
        func gone(within seconds: TimeInterval) -> Bool {
            let end = Date().addingTimeInterval(seconds)
            while Date() < end {
                if kill(c.pid, 0) != 0 { return true }
                usleep(50_000)
            }
            return kill(c.pid, 0) != 0
        }
        if gone(within: grace) { return true }
        kill(c.pid, SIGTERM)
        if gone(within: 2) { return true }
        kill(c.pid, SIGKILL)
        return gone(within: 1)
    }
}

/// Runs `mas-office up --json` as a child process and keeps it alive.
///
/// - Reads the first stdout line (the handshake) for url, port, token and backends.
/// - Restarts after an unexpected exit with backoff, at most `maxRestarts` times per `restartWindow`.
/// - Stops by closing the child's stdin (the daemon shuts down cleanly), then SIGTERM, then SIGKILL.
/// - No orphans: the child holds the read end of a pipe whose only writer is this process. If the app dies,
///   the kernel closes the writer, the daemon reads EOF and shuts down.
/// - Attach mode (`init(attachingTo:)`) uses a daemon someone else runs (UI work, checks): no child.
public actor DaemonController {
    public private(set) var state: DaemonState = .notStarted
    public private(set) var configuration: DaemonConfiguration?
    public let attached: Bool
    /// Stops the child synchronously (app quit).
    public nonisolated let lifeline = DaemonLifeline()

    private var process: Process?
    private var stdinWriter: FileHandle?
    private var generation = 0
    private var stopping = false
    private var exits: [ContinuousClock.Instant] = []
    /// The last lines the daemon wrote for people (stderr), in memory only, for hints. Never logged.
    private var stderrTail: [String] = []
    private var log: DaemonLog?
    private var stderrClosed = true
    private var exitWaiters: [Int: CheckedContinuation<Void, Never>] = [:]
    private var waiterId = 0
    private var subscribers: [Int: AsyncStream<DaemonState>.Continuation] = [:]
    private var subscriberId = 0

    public init(configuration: DaemonConfiguration?) {
        self.configuration = configuration
        attached = false
    }

    /// Use a daemon that is already running.
    public init(attachingTo info: DaemonInfo) {
        configuration = nil
        attached = true
        state = .running(info)
    }

    /// The child's process id while it runs.
    public var pid: Int32? { process?.processIdentifier }

    /// Every state change, starting with the current state.
    public func states() -> AsyncStream<DaemonState> {
        let (stream, continuation) = AsyncStream<DaemonState>.makeStream(bufferingPolicy: .bufferingNewest(16))
        subscriberId += 1
        let id = subscriberId
        subscribers[id] = continuation
        continuation.yield(state)
        continuation.onTermination = { [weak self] _ in
            Task { await self?.unsubscribe(id) }
        }
        return stream
    }

    private func unsubscribe(_ id: Int) { subscribers[id] = nil }

    private func set(_ s: DaemonState) {
        state = s
        for c in subscribers.values { c.yield(s) }
    }

    /// Report a failure found before starting (e.g. no Node).
    public func fail(_ failure: DaemonFailure) {
        set(.failed(failure))
    }

    /// Replace the configuration (another workspace, another limit). Takes effect on the next start.
    public func configure(_ configuration: DaemonConfiguration) {
        self.configuration = configuration
    }

    /// Start the child (no-op when attached or already running).
    public func start() {
        guard !attached, process == nil else { return }
        exits.removeAll()
        launch(attempt: 0)
    }

    /// Stop, then start again with the current configuration.
    public func restart() async {
        await stop()
        start()
    }

    private func launch(attempt: Int) {
        guard let cfg = configuration else {
            set(.failed(.launchFailed("no configuration")))
            return
        }
        guard FileManager.default.fileExists(atPath: cfg.script.path) else {
            set(.failed(.engineMissing(cfg.script.path)))
            return
        }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: cfg.workspace.path, isDirectory: &isDir), isDir.boolValue else {
            set(.failed(.workspaceMissing(cfg.workspace.path)))
            return
        }
        generation += 1
        let gen = generation
        stderrTail.removeAll()
        if let file = cfg.logFile {
            if log?.url != file { log = DaemonLog(url: file) }
            log?.write("— engine starting (attempt \(attempt)) for \(cfg.workspace.path) —")
        } else {
            log = nil
        }
        stderrClosed = false
        set(.starting(attempt: attempt))

        let p = Process()
        p.executableURL = cfg.node
        p.arguments = cfg.arguments
        p.environment = cfg.environment
        p.currentDirectoryURL = cfg.workspace
        let input = Pipe(), output = Pipe(), errors = Pipe()
        p.standardInput = input
        p.standardOutput = output
        p.standardError = errors
        p.terminationHandler = { [weak self] proc in
            let code = proc.terminationStatus
            Task { await self?.childExited(gen, code: code) }
        }
        do {
            try p.run()
        } catch {
            set(.failed(.launchFailed(error.localizedDescription)))
            return
        }
        process = p
        stdinWriter = input.fileHandleForWriting
        lifeline.set(pid: p.processIdentifier, stdin: input.fileHandleForWriting)
        // Our copy of the read end is not needed; the child has its own.
        try? input.fileHandleForReading.close()

        let out = output.fileHandleForReading, err = errors.fileHandleForReading
        Task.detached { [weak self] in
            // The first line is the handshake; anything after it is drained and ignored.
            do {
                for try await line in out.bytes.lines {
                    await self?.stdoutLine(gen, line)
                }
            } catch {}
        }
        Task.detached { [weak self] in
            do {
                for try await line in err.bytes.lines {
                    await self?.stderrLine(gen, line)
                }
            } catch {}
            await self?.stderrEnded(gen)
        }
        Task { [weak self] in
            try? await Task.sleep(for: cfg.handshakeTimeout)
            await self?.handshakeDeadline(gen)
        }
    }

    private func stdoutLine(_ gen: Int, _ line: String) {
        guard gen == generation, case .starting = state else { return }
        do {
            let info = try DaemonInfo.parseHandshake(line)
            log?.setSecret(info.token)
            log?.write("— engine ready at \(info.url.absoluteString) —")
            set(.running(info))
        } catch let f as DaemonFailure {
            set(.failed(f))
            terminateChild()
        } catch {
            set(.failed(.badHandshake("unreadable")))
            terminateChild()
        }
    }

    private func stderrLine(_ gen: Int, _ line: String) {
        guard gen == generation else { return }
        log?.write(line)
        stderrTail.append(String(line.prefix(300)))
        if stderrTail.count > 20 { stderrTail.removeFirst(stderrTail.count - 20) }
    }

    private func stderrEnded(_ gen: Int) {
        if gen == generation { stderrClosed = true }
    }

    private func handshakeDeadline(_ gen: Int) {
        guard gen == generation, case .starting = state, process != nil else { return }
        set(.failed(.handshakeTimeout))
        terminateChild()
    }

    /// The last line worth showing from what the daemon told people.
    private var lastLine: String? {
        stderrTail.last { $0.contains("✗") } ?? stderrTail.last { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    private func childExited(_ gen: Int, code: Int32) async {
        guard gen == generation else { return }
        // Its last words may still be in the pipe: read them before explaining the exit (bounded).
        for _ in 0..<20 where !stderrClosed && gen == generation {
            try? await Task.sleep(for: .milliseconds(25))
        }
        guard gen == generation else { return }
        process = nil
        lifeline.clear()
        try? stdinWriter?.close()
        stdinWriter = nil
        let waiters = exitWaiters
        exitWaiters.removeAll()
        for c in waiters.values { c.resume() }
        if stopping { return }
        if case .failed = state { return } // already explained (bad handshake, timeout)

        let tail = stderrTail.joined(separator: "\n")
        if tail.contains("already in use") {
            set(.failed(.portInUse))
            return
        }
        if tail.contains("needs the runtime package") || tail.contains("Cannot find module") || tail.contains("ERR_MODULE_NOT_FOUND") {
            set(.failed(.engineMissing(lastLine ?? "")))
            return
        }
        if tail.contains("Workspace folder not found") {
            set(.failed(.workspaceMissing(configuration?.workspace.path ?? "")))
            return
        }
        let now = ContinuousClock.now
        let window = configuration?.restartWindow ?? .seconds(60)
        exits = exits.filter { now - $0 < window }
        exits.append(now)
        let limit = configuration?.maxRestarts ?? 3
        if exits.count > limit {
            set(.failed(.crashLoop(count: exits.count, lastLine: lastLine)))
            return
        }
        let attempt = exits.count
        set(.starting(attempt: attempt))
        let delay = configuration?.restartDelay(attempt) ?? .seconds(1)
        Task { [weak self] in
            try? await Task.sleep(for: delay)
            await self?.relaunch(after: gen, attempt: attempt)
        }
    }

    private func relaunch(after gen: Int, attempt: Int) {
        guard gen == generation, process == nil, !stopping, case .starting = state else { return }
        launch(attempt: attempt)
    }

    private func terminateChild() {
        try? stdinWriter?.close()
        stdinWriter = nil
        guard let p = process, p.isRunning else { return }
        kill(p.processIdentifier, SIGTERM)
    }

    /// Wait until the current child exits, at most `timeout`. True when it exited.
    private func waitForExit(_ timeout: Duration) async -> Bool {
        guard process != nil else { return true }
        waiterId += 1
        let id = waiterId
        Task { [weak self] in
            try? await Task.sleep(for: timeout)
            await self?.timeoutWaiter(id)
        }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            exitWaiters[id] = c
        }
        return process == nil
    }

    private func timeoutWaiter(_ id: Int) {
        exitWaiters.removeValue(forKey: id)?.resume()
    }

    /// Stop the child: close its stdin (it shuts down cleanly), then SIGTERM, then SIGKILL. Attached daemons
    /// are left alone.
    public func stop() async {
        guard !attached else { return }
        stopping = true
        defer { stopping = false }
        if let p = process {
            let pid = p.processIdentifier
            try? stdinWriter?.close()
            stdinWriter = nil
            if !(await waitForExit(configuration?.stopGrace ?? .seconds(3))) {
                kill(pid, SIGTERM)
                if !(await waitForExit(.seconds(2))) {
                    kill(pid, SIGKILL)
                    _ = await waitForExit(.seconds(2))
                }
            }
        }
        generation += 1 // late callbacks of the old child are ignored
        process = nil
        set(.notStarted)
    }
}

/// The engine's log file: stderr lines with a timestamp, the token and anything that looks like one redacted.
/// Kept under 1 MB (the older half is dropped). Never holds the handshake (stdout).
public final class DaemonLog: Sendable {
    public let url: URL
    private let secret = OSAllocatedUnfairLock<String?>(initialState: nil)
    private let queue = DispatchQueue(label: "mas-office.daemon-log")
    static let maxBytes = 1_000_000

    public init(url: URL) {
        self.url = url
        let fm = FileManager.default
        try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? Int, size > Self.maxBytes,
           let data = try? Data(contentsOf: url) {
            try? data.suffix(Self.maxBytes / 2).write(to: url, options: .atomic)
        }
        if !fm.fileExists(atPath: url.path) { fm.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
    }

    func setSecret(_ token: String) { secret.withLock { $0 = token } }

    public func write(_ line: String) {
        let text = Self.redact(line, secret: secret.withLock { $0 })
        let stamp = ISO8601DateFormatter().string(from: Date())
        let url = url
        queue.async {
            guard let h = try? FileHandle(forWritingTo: url) else { return }
            defer { try? h.close() }
            _ = try? h.seekToEnd()
            try? h.write(contentsOf: Data("\(stamp) \(text)\n".utf8))
        }
    }

    /// Wait for queued writes (checks).
    public func flush() { queue.sync {} }

    /// The line with the token, `token=…`, `Bearer …` and long hex runs (the token's shape) replaced. Pure.
    public static func redact(_ line: String, secret: String?) -> String {
        var s = line
        if let secret, secret.count >= 8 { s = s.replacingOccurrences(of: secret, with: "<redacted>") }
        let patterns = [#"(?i)(token[=:]\s*)[^\s&"']+"#, #"(?i)(bearer\s+)[^\s"']+"#, #"()\b[0-9a-fA-F]{40,}\b"#]
        for p in patterns {
            guard let re = try? NSRegularExpression(pattern: p) else { continue }
            s = re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "$1<redacted>")
        }
        return s
    }
}
