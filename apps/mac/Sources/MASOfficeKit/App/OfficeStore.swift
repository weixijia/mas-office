import Foundation
import Observation

/// An agent's transcript as loaded so far.
public struct TranscriptState: Sendable, Hashable {
    public enum Status: Sendable, Hashable { case loading, ok, missing, failed(String) }
    public var entries: [TranscriptEntry] = []
    public var cursor = TranscriptCursor()
    public var status: Status = .loading
    public var loadedAt: Date?

    /// Rows for display: tool calls grouped with their results.
    public var rows: [TranscriptRow] { TranscriptRow.group(entries) }
}

/// An agent's work files as loaded.
public struct WorkFilesState: Sendable, Hashable {
    public var files: [WorkFile] = []
    public var loading = true
    public var error: String?
    public var loadedAt: Date?
}

/// The single source of truth the views bind to: connection, session, projects, the current project's
/// snapshot, derived inbox values, the selected agent, transcripts, and intents that call the daemon.
///
/// Everything is read from the daemon (`OfficeClient`); the store refreshes on stream events (debounced) and
/// polls while the stream is down. Errors from intents become `lastError` (a sentence for people).
@MainActor
@Observable
public final class OfficeStore {
    public enum Connection: Sendable, Equatable {
        /// No daemon yet.
        case disconnected
        case connecting
        /// Snapshots are current and the event stream is up.
        case live
        /// Snapshots are read by polling because the stream is down (`reason`).
        case polling(String)
        /// The daemon does not answer.
        case offline(String)

        public var isUsable: Bool {
            switch self {
            case .live, .polling: return true
            default: return false
            }
        }
    }

    /// Where a selection came from (the office drawing reports clicks; native views set it directly; the inbox
    /// selects a request's agent without leaving the inbox).
    public enum SelectionOrigin: Sendable { case native, office, inbox }

    // MARK: State

    public private(set) var connection: Connection = .disconnected
    public private(set) var session: SessionInfo?
    public private(set) var projects: ProjectsIndex?
    public private(set) var currentProject: String?
    public private(set) var snapshot: ProjectSnapshot = .empty
    /// Ticks every second while connected, for wait clocks.
    public private(set) var now = Date()
    /// When this app first saw each pending request (for requests without a usable `openedAt`).
    public private(set) var firstSeen: [String: Date] = [:]
    /// Commands sent from this app, by `cmdId`.
    public private(set) var localCommands: [String: LocalCommand] = [:]
    /// The last command this app sent per request id (its receipt shows on the request).
    public private(set) var answers: [String: String] = [:]
    /// Stops sent from this app, by agent id (see `stopState(for:)`).
    public internal(set) var stops: [String: StopRecord] = [:]
    /// The inbox as the views show it (sorted like `panel/inbox.js`). Stored, not derived from `now`, so the
    /// 1 s clock re-renders only the views that show a wait clock.
    public private(set) var arrangedInbox: ArrangedInbox = .empty
    public private(set) var selectedAgentId: String?
    public private(set) var selectionOrigin: SelectionOrigin = .native
    public private(set) var transcripts: [String: TranscriptState] = [:]
    public private(set) var workFiles: [String: WorkFilesState] = [:]
    /// The newest protocol events seen on the stream (current project only), newest last, at most 200.
    public private(set) var recentEvents: [OfficeEvent] = []
    /// A sentence for people about the last intent that failed; nil when dismissed.
    public private(set) var lastError: String?
    public private(set) var lastErrorAt: Date?
    public private(set) var lastUpdated: Date?

    @ObservationIgnored private var client: OfficeClient?
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var clockTask: Task<Void, Never>?
    @ObservationIgnored private var debounceTask: Task<Void, Never>?
    @ObservationIgnored private var refreshing = false
    @ObservationIgnored private var refreshAgain = false
    @ObservationIgnored private var streamUp = false
    @ObservationIgnored private var lastSessionRead = Date.distantPast
    @ObservationIgnored private var nextNeeding = NextUp()
    @ObservationIgnored private var nextIdle = NextUp()

    public init() {}

    // MARK: Connecting

    /// Connect to a daemon (replaces any previous connection) and start reading.
    public func connect(baseURL: URL, token: String) {
        disconnect()
        client = OfficeClient(baseURL: baseURL, token: token)
        connection = .connecting
        clockTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                self?.now = Date()
            }
        }
        pollTask = Task { [weak self] in
            await self?.refresh()
            while !Task.isCancelled {
                // Every 2 s while the stream is down, every 10 s as a safety net while it is up.
                let live = self?.streamUp ?? false
                try? await Task.sleep(for: .seconds(live ? 10 : 2))
                await self?.refresh()
            }
        }
        startStream()
    }

    /// Connect to what `DaemonController` reports.
    public func connect(to info: DaemonInfo) {
        connect(baseURL: info.url, token: info.token)
    }

    public func disconnect() {
        for t in [streamTask, pollTask, clockTask, debounceTask] { t?.cancel() }
        streamTask = nil
        pollTask = nil
        clockTask = nil
        debounceTask = nil
        client = nil
        streamUp = false
        connection = .disconnected
        session = nil
    }

    private func startStream() {
        streamTask?.cancel()
        guard let client else { return }
        let stream = client.eventStream(project: currentProject).events()
        let project = currentProject
        streamTask = Task { [weak self] in
            for await e in stream {
                guard let self, !Task.isCancelled else { return }
                self.handle(e, project: project)
            }
        }
    }

    private func handle(_ e: StreamEvent, project: String?) {
        switch e {
        case .connected:
            streamUp = true
            if connection != .connecting { connection = .live }
            scheduleRefresh(after: .milliseconds(10))
        case .disconnected(let reason, _):
            streamUp = false
            if connection.isUsable { connection = .polling(reason) }
        case .change(let path):
            guard let project, path.hasPrefix(project + "/") || path.hasPrefix("home/") else { return }
            let rel = String(path.dropFirst(project.count + 1))
            if rel.hasPrefix("mas/transcript/"), rel.hasSuffix(".jsonl") {
                let id = String(rel.dropFirst("mas/transcript/".count).dropLast(".jsonl".count))
                if transcripts[id] != nil { Task { await loadTranscript(id) } }
                return
            }
            if rel.hasPrefix("outputs/work/") {
                for id in workFiles.keys where rel.dropFirst("outputs/work/".count).hasPrefix(id) {
                    Task { await loadWorkFiles(id) }
                }
                return
            }
            scheduleRefresh()
        case .event(let ev):
            guard ev.project == project else { return }
            recentEvents.append(ev)
            if recentEvents.count > 200 { recentEvents.removeFirst(recentEvents.count - 200) }
            scheduleRefresh()
        }
    }

    /// Re-read soon; many changes in a burst cause one read.
    public func scheduleRefresh(after delay: Duration = .milliseconds(100)) {
        debounceTask?.cancel()
        debounceTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.refresh()
        }
    }

    /// Read session (every 30 s), projects and the current project's snapshot now.
    public func refresh() async {
        guard let client else { return }
        if refreshing {
            refreshAgain = true
            return
        }
        refreshing = true
        defer {
            refreshing = false
            if refreshAgain {
                refreshAgain = false
                scheduleRefresh(after: .milliseconds(10))
            }
        }
        do {
            if session == nil || Date().timeIntervalSince(lastSessionRead) > 30 {
                session = try await client.session()
                lastSessionRead = Date()
            }
            let index = try await client.projects()
            guard client === self.client else { return }
            if index != projects { projects = index }
            let wanted = chooseProject(index)
            if wanted != currentProject {
                switchProject(to: wanted)
            }
            if let project = currentProject {
                let snap = try await client.snapshot(project: project)
                guard client === self.client, project == currentProject else { return }
                apply(snap.keepingGoodParts(of: snapshot))
            } else if snapshot != .empty {
                snapshot = .empty
            }
            lastUpdated = Date()
            connection = streamUp ? .live : .polling(connection == .connecting ? "connecting to the event stream" : pollingReason)
        } catch let e as OfficeError {
            if client === self.client { connection = .offline(e.userMessage) }
        } catch {
            if client === self.client { connection = .offline(error.localizedDescription) }
        }
    }

    /// Read the session (backends, runtime) now instead of on the 30 s schedule, then everything else.
    public func refreshSession() async {
        lastSessionRead = .distantPast
        await refresh()
    }

    private var pollingReason: String {
        if case .polling(let r) = connection { return r }
        return "the event stream is down"
    }

    /// The project to follow: the one chosen here if it still exists, else the workspace's current one, else the
    /// first listed.
    private func chooseProject(_ index: ProjectsIndex?) -> String? {
        guard let index else { return currentProject }
        if let c = currentProject, index.projects.contains(where: { $0.folder == c }) { return c }
        return index.current ?? index.projects.first?.folder
    }

    private func switchProject(to project: String?) {
        currentProject = project
        snapshot = ProjectSnapshot(project: project)
        firstSeen = [:]
        answers = [:]
        stops = [:]
        arrangedInbox = .empty
        transcripts = [:]
        workFiles = [:]
        recentEvents = []
        selectedAgentId = nil
        nextNeeding = NextUp()
        nextIdle = NextUp()
        startStream()
    }

    private func apply(_ snap: ProjectSnapshot) {
        let t = Date()
        for r in snap.inbox?.pending ?? [] where firstSeen[r.requestId] == nil { firstSeen[r.requestId] = t }
        if snap != snapshot { snapshot = snap }
        rearrange(now: t)
    }

    /// Recompute `arrangedInbox` (assigned only when it changed, so observers stay quiet otherwise).
    private func rearrange(now t: Date) {
        let arranged = Supervision.arrange(snapshot.inbox, structure: snapshot.structure, statuses: snapshot.statuses, firstSeen: firstSeen, now: t)
        if arranged != arrangedInbox { arrangedInbox = arranged }
    }

    /// Follow another project of the workspace.
    public func selectProject(_ folder: String) {
        guard folder != currentProject else { return }
        switchProject(to: folder)
        scheduleRefresh(after: .milliseconds(10))
    }

    // MARK: Selection

    /// Select an agent (nil clears). The office drawing reports clicks with `origin: .office`.
    public func selectAgent(_ id: String?, origin: SelectionOrigin = .native) {
        selectionOrigin = origin
        guard id != selectedAgentId else { return }
        selectedAgentId = id
        if let id {
            Task { await loadTranscript(id) }
            Task { await loadWorkFiles(id) }
        }
    }

    /// Select the next agent that needs you (cycling, like the panel's N key). Returns its id.
    @discardableResult
    public func selectNextNeedingYou() -> String? {
        let id = nextNeeding.next(NextUp.line(waitingAgents), here: selectedAgentId)
        if let id { selectAgent(id) }
        return id
    }

    /// Select the next agent that is free for more work (Shift+N in the panel). Returns its id.
    @discardableResult
    public func selectNextIdle() -> String? {
        let line = Supervision.idleAgents(structure: snapshot.structure, statuses: snapshot.statuses)
        let id = nextIdle.next(line, here: selectedAgentId)
        if let id { selectAgent(id) }
        return id
    }

    // MARK: Derived values

    public var structure: Structure? { snapshot.structure }
    public var statuses: [String: AgentStatus] { snapshot.statuses }

    /// Requests that need you.
    public var needsYouCount: Int { arrangedInbox.human.count }

    /// Agents with a blocking request that needs you, most urgent / longest waiting first.
    public var waitingAgents: [WaitingAgent] {
        guard snapshot.structure?.locked == true else { return [] }
        return Supervision.waitingAgents(arrangedInbox.human)
    }

    /// "4 min", "1 h 05 min", or "" in the first minute.
    public func waited(_ item: PendingItem) -> String { Supervision.waited(since: item.since, now: now) }

    /// "Holds up Catch checker and Lead" with display names.
    public func holdsUpText(_ item: PendingItem) -> String { Supervision.holdsUpText(item.holds.map(displayName)) }

    /// The receipt of a command this app sent.
    public func receipt(for cmdId: String) -> Receipt? {
        let local = localCommands[cmdId]
        let server = snapshot.inbox?.command(cmdId)
        guard local != nil || server != nil else { return nil }
        return Supervision.receipt(local: local, command: server)
    }

    /// Receipts of all commands this app sent, by `cmdId`.
    public var receiptsByCommand: [String: Receipt] {
        Dictionary(uniqueKeysWithValues: localCommands.keys.compactMap { id in receipt(for: id).map { (id, $0) } })
    }

    /// The receipt of this app's answer to a request, if it answered.
    public func answerReceipt(for requestId: String) -> Receipt? {
        answers[requestId].flatMap(receipt(for:))
    }

    /// Commands this app sent to one agent, oldest first, with receipts.
    public func sentCommands(to agentId: String) -> [(cmdId: String, command: LocalCommand, receipt: Receipt)] {
        localCommands.filter { $0.value.agentId == agentId }
            .sorted { $0.value.at < $1.value.at }
            .compactMap { id, c in receipt(for: id).map { (id, c, $0) } }
    }

    public func status(of agentId: String) -> AgentStatus? { snapshot.statuses[agentId] }

    public func displayName(_ agentId: String) -> String {
        snapshot.structure?.name(of: agentId) ?? (agentId == "lead" ? "Lead" : agentId)
    }

    /// Agents working, flagged or handing off right now.
    public var busyAgentIds: [String] {
        (snapshot.structure?.memberIds ?? []).filter { snapshot.statuses[$0]?.state.isBusy == true }
    }

    /// A run is going: the phase says so or someone is busy.
    public var isRunActive: Bool { snapshot.state?.isRunning == true || !busyAgentIds.isEmpty }

    /// This app may answer, message and start runs (valid token, a project).
    public var canAct: Bool { session?.tokenValid == true && currentProject != nil }

    /// Why this app may not act, or nil when it may.
    public var actReason: String? {
        if session == nil { return "Connecting to the MAS Office engine…" }
        if session?.tokenValid != true { return "The engine did not accept this app's access. Restart the engine." }
        if currentProject == nil { return "No project is selected." }
        return nil
    }

    /// Whether the agent takes a command (`message`, `respond`, `interrupt`, `assign`).
    public func accepts(_ agentId: String, _ command: String) -> Bool {
        snapshot.board?.accepts(agentId, command) ?? false
    }

    public var credibility: Credibility? {
        guard let v = snapshot.verification, v.summary.claims > 0 else { return nil }
        return Credibility(v.summary)
    }

    // MARK: Intents

    public func dismissError() {
        lastError = nil
        lastErrorAt = nil
    }

    private func report(_ error: Error) {
        lastError = (error as? OfficeError)?.userMessage ?? error.localizedDescription
        lastErrorAt = Date()
    }

    private func ready() -> (OfficeClient, String)? {
        guard let client, let project = currentProject else {
            lastError = actReason ?? "Not connected."
            lastErrorAt = Date()
            return nil
        }
        return (client, project)
    }

    private func setLocal(_ cmdId: String, _ state: ReceiptState, error: String? = nil) {
        localCommands[cmdId]?.state = state
        localCommands[cmdId]?.error = error
    }

    /// Answer a request with one of its options (plus text for a gate's "revise"). Returns the `cmdId`, or nil
    /// when it could not be sent. "Already answered" is a receipt, not an error.
    @discardableResult
    public func answer(_ request: InboxRequest, option: RequestOption, text: String? = nil) async -> String? {
        await respond(request, .option(option.optionId, text: text), label: option.name)
    }

    /// Answer a request with typed text.
    @discardableResult
    public func reply(_ request: InboxRequest, text: String) async -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        return await respond(request, .text(t), label: t)
    }

    private func respond(_ request: InboxRequest, _ answer: RequestAnswer, label: String) async -> String? {
        guard let (client, project) = ready() else { return nil }
        let agentId = request.agentId ?? "lead"
        let cmdId = OfficeClient.newCommandId()
        localCommands[cmdId] = LocalCommand(state: .sending, type: "command.respond", agentId: agentId, text: label,
                                            requestId: request.requestId, at: Date())
        answers[request.requestId] = cmdId
        do {
            try await client.respond(project: project, requestId: request.requestId, agentId: agentId, answer: answer, cmdId: cmdId)
            setLocal(cmdId, .sent)
        } catch OfficeError.alreadyAnswered {
            setLocal(cmdId, .conflict)
        } catch {
            setLocal(cmdId, .failed, error: (error as? OfficeError)?.userMessage ?? error.localizedDescription)
            report(error)
        }
        scheduleRefresh()
        return cmdId
    }

    /// Message an agent. Returns the `cmdId` (its receipt is `receipt(for:)`).
    @discardableResult
    public func sendMessage(to agentId: String, text: String, delivery: Delivery = .steer) async -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, let (client, project) = ready() else { return nil }
        let cmdId = OfficeClient.newCommandId()
        localCommands[cmdId] = LocalCommand(state: .sending, type: "command.message", agentId: agentId, text: t, delivery: delivery, at: Date())
        do {
            try await client.message(project: project, agentId: agentId, text: t, delivery: delivery, cmdId: cmdId)
            setLocal(cmdId, .sent)
        } catch {
            setLocal(cmdId, .failed, error: (error as? OfficeError)?.userMessage ?? error.localizedDescription)
            report(error)
        }
        scheduleRefresh()
        return cmdId
    }

    /// Ask an agent to stop its current turn. Accepted is not stopped: watch its status.
    @discardableResult
    public func interrupt(_ agentId: String, cmdId: String = OfficeClient.newCommandId()) async -> String? {
        guard let (client, project) = ready() else { return nil }
        localCommands[cmdId] = LocalCommand(state: .sending, type: "command.interrupt", agentId: agentId, at: Date())
        do {
            try await client.interrupt(project: project, agentId: agentId, cmdId: cmdId)
            setLocal(cmdId, .sent)
        } catch {
            setLocal(cmdId, .failed, error: (error as? OfficeError)?.userMessage ?? error.localizedDescription)
            report(error)
        }
        scheduleRefresh()
        return cmdId
    }

    /// Start a run of the locked team. Returns what the engine said, or nil (see `lastError`).
    @discardableResult
    public func startRun(task: String) async -> RunStarted? {
        let t = task.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, let (client, project) = ready() else { return nil }
        do {
            let r = try await client.startRun(project: project, task: t)
            scheduleRefresh()
            return r
        } catch {
            report(error)
            return nil
        }
    }

    /// Ask a follow-up question on the last result.
    @discardableResult
    public func followUp(question: String) async -> RunStarted? {
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, let (client, project) = ready() else { return nil }
        do {
            let r = try await client.followUp(project: project, question: q)
            scheduleRefresh()
            return r
        } catch {
            report(error)
            return nil
        }
    }

    /// Load (or continue loading) an agent's transcript.
    public func loadTranscript(_ agentId: String) async {
        guard let client, let project = currentProject else { return }
        var t = transcripts[agentId] ?? TranscriptState()
        if transcripts[agentId] == nil { transcripts[agentId] = t }
        do {
            let chunk = try await client.transcript(project: project, agentId: agentId, from: t.status == .loading ? nil : t.cursor)
            guard project == currentProject else { return }
            t = transcripts[agentId] ?? t
            if chunk.missing {
                t.entries = []
                t.status = .missing
            } else {
                t.entries = Array(((chunk.reset ? [] : t.entries) + chunk.entries).suffix(5000))
                t.status = .ok
            }
            t.cursor = chunk.cursor
            t.loadedAt = Date()
            transcripts[agentId] = t
        } catch {
            t.status = .failed((error as? OfficeError)?.userMessage ?? error.localizedDescription)
            transcripts[agentId] = t
        }
    }

    /// Load an agent's work files.
    public func loadWorkFiles(_ agentId: String) async {
        guard let client, let project = currentProject else { return }
        if workFiles[agentId] == nil { workFiles[agentId] = WorkFilesState() }
        do {
            let files = try await client.workFiles(project: project, agentId: agentId)
            guard project == currentProject else { return }
            workFiles[agentId] = WorkFilesState(files: files, loading: false, error: nil, loadedAt: Date())
        } catch {
            workFiles[agentId] = WorkFilesState(files: workFiles[agentId]?.files ?? [], loading: false,
                                                error: (error as? OfficeError)?.userMessage ?? error.localizedDescription, loadedAt: Date())
        }
    }

    // MARK: Previews and checks

    /// A store filled with fixed data and no daemon, for previews, renders and checks.
    public static func preview(snapshot: ProjectSnapshot, projects: ProjectsIndex? = nil, session: SessionInfo? = nil,
                               now: Date = Date(), transcripts: [String: [TranscriptEntry]] = [:]) -> OfficeStore {
        let s = OfficeStore()
        s.currentProject = snapshot.project
        s.projects = projects
        s.session = session
        s.now = now
        s.apply(snapshot)
        s.firstSeen = Dictionary(uniqueKeysWithValues: (snapshot.inbox?.pending ?? []).map { ($0.requestId, now) })
        s.rearrange(now: now)
        s.connection = .live
        for (id, entries) in transcripts {
            s.transcripts[id] = TranscriptState(entries: entries, cursor: TranscriptCursor(), status: .ok, loadedAt: now)
        }
        return s
    }

    /// Select without loading anything (previews).
    public func previewSelect(_ id: String?) {
        selectedAgentId = id
    }
}
