import Foundation
import Observation

/// Ties the engine (`DaemonController`), the environment checks and the `OfficeStore` together for the app:
/// finds Node, starts the daemon for the chosen workspace (or attaches to a running one), connects the store
/// when the daemon is ready, and stops it on quit.
@MainActor
@Observable
public final class AppController {
    public let store: OfficeStore
    public let options: LaunchOptions
    public private(set) var daemonState: DaemonState = .notStarted
    /// The workspace folder (nil until the person chooses one; attached daemons have their own).
    public private(set) var workspace: URL?
    public private(set) var nodeCheck: NodeCheck?
    public private(set) var shellSource: ShellEnvironment.Source?
    /// Roles working at once (passed to the daemon as `--max-parallel`, 1–12).
    public private(set) var maxParallel: Int
    public let launchedAt = Date()

    @ObservationIgnored private var daemon: DaemonController?
    @ObservationIgnored private var stateTask: Task<Void, Never>?
    @ObservationIgnored private var environment: ShellEnvironment?
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let bundle: Bundle

    public static let workspaceKey = "workspacePath"
    public static let maxParallelKey = "maxParallel"
    public static let nodePathKey = "nodePathOverride"
    public static let startAtLaunchKey = "startEngineAtLaunch"
    public static let keepInMenuBarKey = "keepRunningInMenuBar"

    /// A Node.js the person chose in Settings instead of the one on their login-shell PATH.
    public private(set) var nodePathOverride: String?
    /// Start the engine when the app opens (otherwise it waits for Start Engine).
    public var startEngineAtLaunch: Bool {
        didSet { defaults.set(startEngineAtLaunch, forKey: Self.startAtLaunchKey) }
    }
    /// Closing the main window keeps the app and a run alive in the menu bar.
    public var keepRunningInMenuBar: Bool {
        didSet { defaults.set(keepRunningInMenuBar, forKey: Self.keepInMenuBarKey) }
    }

    /// The engine's log (stderr, token redacted): `~/Library/Logs/MAS Office/engine.log`.
    public static var engineLogURL: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/MAS Office/engine.log")
    }

    public init(options: LaunchOptions, defaults: UserDefaults = .standard, bundle: Bundle = .main) {
        self.options = options
        self.defaults = defaults
        self.bundle = bundle
        store = OfficeStore()
        let saved = defaults.integer(forKey: Self.maxParallelKey)
        maxParallel = (1...12).contains(saved) ? saved : 3
        nodePathOverride = defaults.string(forKey: Self.nodePathKey).flatMap { $0.isEmpty ? nil : $0 }
        startEngineAtLaunch = defaults.object(forKey: Self.startAtLaunchKey) as? Bool ?? true
        keepRunningInMenuBar = defaults.object(forKey: Self.keepInMenuBarKey) as? Bool ?? true
        if let w = options.workspace {
            workspace = URL(fileURLWithPath: (w as NSString).expandingTildeInPath, isDirectory: true)
        } else if let w = defaults.string(forKey: Self.workspaceKey) {
            workspace = URL(fileURLWithPath: w, isDirectory: true)
        }
    }

    /// Attached to a daemon someone else runs.
    public var isAttached: Bool { options.attach != nil }

    /// First launch: no workspace chosen yet (and not attached).
    public var needsWorkspace: Bool { !isAttached && workspace == nil }

    /// The suggested workspace for first launch: `~/MAS Office`.
    public static var suggestedWorkspace: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("MAS Office", isDirectory: true)
    }

    /// Start: attach, or read the login shell, find Node and start the daemon for the workspace.
    public func start() async {
        if let info = options.attach {
            let d = DaemonController(attachingTo: info)
            watch(d)
            return
        }
        guard let workspace, startEngineAtLaunch || options.isAutomated else { return }
        await startDaemon(workspace: workspace)
    }

    /// Start the engine now (when it was not started at launch, or after it stopped).
    public func startEngine() async {
        guard !isAttached, let workspace else { return }
        if case .running = daemonState { return }
        await startDaemon(workspace: workspace)
    }

    private func watch(_ d: DaemonController) {
        daemon = d
        stateTask?.cancel()
        stateTask = Task { [weak self] in
            for await s in await d.states() {
                guard let self else { return }
                self.daemonStateChanged(s)
            }
        }
    }

    private func daemonStateChanged(_ s: DaemonState) {
        let before = daemonState.info
        daemonState = s
        if let info = s.info, info != before {
            store.connect(to: info)
        } else if s.info == nil, before != nil {
            store.disconnect()
        }
    }

    private func startDaemon(workspace: URL) async {
        let env: ShellEnvironment
        if let e = environment {
            env = e
        } else {
            env = await ShellEnvironment.capture()
            environment = env
            shellSource = env.source
        }
        let check: NodeCheck
        if let override = nodePathOverride {
            check = SettingsValidation.nodePathProblem(override) == nil
                ? await SettingsValidation.checkNode(at: URL(fileURLWithPath: (override as NSString).expandingTildeInPath), environment: env.daemonEnvironment())
                : .broken(URL(fileURLWithPath: override), SettingsValidation.nodePathProblem(override)?.message ?? "unusable")
        } else {
            check = await NodeCheck.run(in: env)
        }
        nodeCheck = check
        let d = daemon ?? DaemonController(configuration: nil)
        if daemon == nil { watch(d) }
        switch check {
        case .missing:
            await d.fail(.nodeNotFound)
            return
        case .tooOld(let url, let v):
            await d.fail(.nodeTooOld(found: v.description, path: url.path))
            return
        case .broken(let url, let detail):
            await d.fail(.nodeBroken(path: url.path, detail: detail))
            return
        case .found(let node, _):
            guard let script = Self.locateDaemonScript(bundle: bundle) else {
                await d.fail(.engineMissing("mas-office.js"))
                return
            }
            var cfg = DaemonConfiguration(node: node, script: script, workspace: workspace, maxParallel: maxParallel,
                                          environment: env.daemonEnvironment())
            cfg.logFile = options.isAutomated ? nil : Self.engineLogURL
            await d.configure(cfg)
            await d.start()
        }
    }

    /// Where `mas-office.js` is: inside the app bundle (`Resources/daemon/node_modules/mas-office/bin`), else
    /// `MAS_OFFICE_DAEMON_SCRIPT`, else the repository this binary was built in (development).
    public static func locateDaemonScript(bundle: Bundle = .main, environment: [String: String] = ProcessInfo.processInfo.environment) -> URL? {
        let fm = FileManager.default
        if let r = bundle.resourceURL?.appendingPathComponent("daemon/node_modules/mas-office/bin/mas-office.js"), fm.fileExists(atPath: r.path) {
            return r
        }
        if let p = environment["MAS_OFFICE_DAEMON_SCRIPT"], fm.fileExists(atPath: p) {
            return URL(fileURLWithPath: p)
        }
        var dir = URL(fileURLWithPath: CommandLine.arguments.first ?? "").resolvingSymlinksInPath().deletingLastPathComponent()
        for _ in 0..<8 {
            let candidate = dir.appendingPathComponent("packages/node/bin/mas-office.js")
            if fm.fileExists(atPath: candidate.path) { return candidate }
            dir.deleteLastPathComponent()
        }
        return nil
    }

    /// Use another workspace: creates it and its `home/` if missing, remembers it, restarts the daemon.
    public func chooseWorkspace(_ url: URL) async throws {
        let fm = FileManager.default
        try fm.createDirectory(at: url.appendingPathComponent("home", isDirectory: true), withIntermediateDirectories: true)
        workspace = url
        defaults.set(url.path, forKey: Self.workspaceKey)
        guard !isAttached else { return }
        if let d = daemon { await d.stop() }
        await startDaemon(workspace: url)
    }

    /// Change how many roles work at once; restarts the daemon to apply it.
    public func setMaxParallel(_ n: Int) async {
        let v = max(1, min(12, n))
        guard v != maxParallel else { return }
        maxParallel = v
        defaults.set(v, forKey: Self.maxParallelKey)
        await restartDaemon()
    }

    /// Use another Node.js (nil: the one on the login-shell PATH); restarts the engine to apply it.
    public func setNodePathOverride(_ path: String?) async {
        let v = path?.trimmingCharacters(in: .whitespacesAndNewlines)
        let value = v?.isEmpty == false ? v : nil
        guard value != nodePathOverride else { return }
        nodePathOverride = value
        defaults.set(value, forKey: Self.nodePathKey)
        await restartDaemon()
    }

    /// Re-run the environment checks (Node) without restarting a running engine; restarts a failed one.
    public func recheck() async {
        environment = nil
        if case .running = daemonState {
            let env = await ShellEnvironment.capture()
            environment = env
            shellSource = env.source
            if let override = nodePathOverride {
                nodeCheck = await SettingsValidation.checkNode(at: URL(fileURLWithPath: (override as NSString).expandingTildeInPath), environment: env.daemonEnvironment())
            } else {
                nodeCheck = await NodeCheck.run(in: env)
            }
            await store.refreshSession()
        } else {
            await restartDaemon()
        }
    }

    /// Run `mas-office team check|lock|show` on a project of the workspace with the engine's Node and script.
    public func runTeamCommand(_ action: TeamCLI.Action, project folder: String) async -> TeamCLI.Outcome {
        func failed(_ why: String) -> TeamCLI.Outcome {
            TeamCLI.Outcome(action: action.rawValue, status: nil, output: "", problems: [], timedOut: false, launchError: why)
        }
        guard let workspace else {
            return failed("the workspace folder of the attached engine is not known here (start the app with --workspace)")
        }
        guard OfficeClient.isProjectName(folder) else { return failed("\"\(folder)\" is not a project folder name") }
        let env: ShellEnvironment
        if let e = environment { env = e } else {
            env = await ShellEnvironment.capture()
            environment = env
            shellSource = env.source
        }
        if nodeCheck == nil { nodeCheck = await NodeCheck.run(in: env) }
        guard let node = nodeCheck?.node else { return failed("Node.js \(NodeVersion.minimum) or newer was not found") }
        guard let script = Self.locateDaemonScript(bundle: bundle) else { return failed("the engine files are missing") }
        return await TeamCLI.run(action, project: workspace.appendingPathComponent(folder, isDirectory: true), workspace: workspace,
                                 node: node, script: script, environment: env.daemonEnvironment())
    }

    /// Create a project from the bundled example team (unlocked) and follow it.
    @discardableResult
    public func createExampleProject() throws -> String {
        guard let workspace else { throw ExampleTeam.Failure.unreadable("no workspace folder") }
        guard let example = ExampleTeam.locate(bundle: bundle) else { throw ExampleTeam.Failure.unreadable("it is not in this app") }
        let project = try ExampleTeam.create(in: workspace, from: example)
        store.selectProject(project.lastPathComponent)
        return project.lastPathComponent
    }

    /// Stop and start the daemon again (Try Again after a failure, too). Re-reads Node.
    public func restartDaemon() async {
        guard !isAttached, let workspace else { return }
        if let d = daemon { await d.stop() }
        await startDaemon(workspace: workspace)
    }

    /// Stop the daemon. Attached daemons are left running.
    public func shutdown() async {
        store.disconnect()
        if let d = daemon { await d.stop() }
    }

    /// Stop the daemon without waiting on Swift tasks (blocks for at most a few seconds): for the app's quit,
    /// where AppKit's terminate loop does not run them. Attached daemons are left running.
    public func shutdownNow() {
        store.disconnect()
        daemon?.lifeline.stopBlocking()
    }

    /// "3 roles are working. Quit and stop them?" while a run is active, else nil.
    public var quitConfirmation: String? {
        guard !isAttached, store.isRunActive else { return nil }
        let n = store.busyAgentIds.count
        if n == 0 { return "A run is in progress. Quit and stop it?" }
        return n == 1 ? "1 role is working. Quit and stop it?" : "\(n) roles are working. Quit and stop them?"
    }

    /// The daemon's process id, when this app started it.
    public func daemonPID() async -> Int32? {
        await daemon?.pid
    }
}
