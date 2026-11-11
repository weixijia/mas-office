import Foundation

/// Errors from the daemon, in words a person can act on (`userMessage`).
public enum OfficeError: Error, Sendable, Equatable, LocalizedError {
    /// 401: the token is not (or no longer) valid.
    case unauthorized
    /// 409 `already_resolved`: someone else (the terminal, the Lead, a policy) answered first.
    case alreadyAnswered
    /// 409 `answer_in_terminal`: a prompt in a terminal the person opened; answer it there.
    case answerInTerminal
    /// 409 `no_runtime`: a viewer-only server (`mas-office serve`) cannot start runs.
    case noRuntime
    /// Another 409: the runtime refused (e.g. a run is already going). `reason` is the server's code.
    case refused(reason: String, message: String)
    /// 403: not allowed (e.g. the request's resolver excludes people).
    case forbidden(String)
    /// 400, 413, 415: the request was malformed.
    case badRequest(String)
    case server(status: Int, message: String)
    /// No connection to the daemon.
    case network(String)
    case invalidResponse(String)
    /// The project folder name is not valid (`^[a-z0-9][a-z0-9-]{0,39}$`).
    case invalidProject(String)

    public var userMessage: String {
        switch self {
        case .unauthorized: return "The connection to the MAS Office engine is no longer authorised. Restart the engine."
        case .alreadyAnswered: return "Already answered somewhere else."
        case .answerInTerminal: return "Answer this one in the terminal where that session runs."
        case .noRuntime: return "This engine only shows the office; it cannot run the team."
        case .refused(_, let message): return message
        case .forbidden(let message): return message
        case .badRequest(let message): return message
        case .server(let status, let message): return message.isEmpty ? "The engine answered \(status)." : message
        case .network(let message): return "No connection to the MAS Office engine (\(message))."
        case .invalidResponse(let message): return "The engine sent something unexpected (\(message))."
        case .invalidProject(let name): return "\"\(name)\" is not a project folder name."
        }
    }

    public var errorDescription: String? { userMessage }
}

/// What the server answered to a command: its id (to match the receipt in `inbox.commands`) and log position.
public struct CommandAccepted: Sendable, Hashable {
    public var cmdId: String
    public var seq: Int?
    /// The same `cmdId` was already known (a retry): one command, one effect.
    public var duplicate: Bool
}

/// A started run (or follow-up round).
public struct RunStarted: Sendable, Hashable {
    public var runId: String?
    public var round: Int?
}

/// An answer to a request.
public enum RequestAnswer: Sendable, Hashable {
    /// Pick an option, optionally with text (a gate's "revise" needs it).
    case option(String, text: String?)
    /// A typed reply (outcome `submitted`, payload `{text}`).
    case text(String)
    /// Decline without picking an option.
    case declined
}

/// One of an agent's work files (`outputs/work/<id>.md`, `<id>-round2.md` …).
public struct WorkFile: Sendable, Hashable, Identifiable {
    public var name: String
    public var text: String
    public var id: String { name }
}

/// The result of an incremental transcript read.
public struct TranscriptChunk: Sendable {
    /// New entries (all entries when `reset`).
    public var entries: [TranscriptEntry]
    public var cursor: TranscriptCursor
    /// The file was rewritten: replace what you had.
    public var reset: Bool
    /// No transcript file (yet).
    public var missing: Bool
}

/// Talks to one `mas-office` daemon: reads workspace documents over HTTP, sends commands with the token.
/// The token stays inside this actor and the request headers; it is never put in a URL or a log.
public actor OfficeClient {
    public nonisolated let baseURL: URL
    private nonisolated let token: String
    private let http: URLSession

    public init(baseURL: URL, token: String) {
        self.baseURL = baseURL
        self.token = token
        let config = URLSessionConfiguration.ephemeral
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.timeoutIntervalForRequest = 15
        config.connectionProxyDictionary = [:] // loopback only: never through a proxy
        http = URLSession(configuration: config)
    }

    deinit {
        http.invalidateAndCancel()
    }

    /// A live event stream from this daemon.
    public nonisolated func eventStream(project: String?, since: Int? = nil) -> EventStream {
        EventStream(baseURL: baseURL, token: token, project: project, since: since)
    }

    /// `cmd_` and 16 hex digits: what the server accepts as a client-chosen `cmdId`.
    public static func newCommandId() -> String {
        var rng = SystemRandomNumberGenerator()
        return "cmd_" + (0..<8).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &rng)) }.joined()
    }

    /// The server's rule for project folders: `^[a-z0-9][a-z0-9-]{0,39}$`.
    public static func isProjectName(_ s: String) -> Bool {
        s.utf8.count <= 40 && ProjectsIndex.isFolderName(s)
    }

    // MARK: HTTP

    private func url(_ path: String, query: [URLQueryItem] = []) throws -> URL {
        guard var c = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { throw OfficeError.invalidResponse("bad base URL") }
        c.percentEncodedPath = path
        c.queryItems = query.isEmpty ? nil : query
        guard let u = c.url else { throw OfficeError.invalidResponse("bad path") }
        return u
    }

    private func request(_ method: String, _ path: String, query: [URLQueryItem] = [], body: JSONValue? = nil,
                         auth: Bool) async throws -> (Data, Int) {
        var req = URLRequest(url: try url(path, query: query))
        req.httpMethod = method
        req.cachePolicy = .reloadIgnoringLocalCacheData
        if auth { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = Data(body.jsonText().utf8)
        }
        do {
            let (data, response) = try await http.data(for: req)
            guard let h = response as? HTTPURLResponse else { throw OfficeError.invalidResponse("not HTTP") }
            return (data, h.statusCode)
        } catch let e as OfficeError {
            throw e
        } catch {
            throw OfficeError.network((error as NSError).localizedDescription)
        }
    }

    /// Map a non-2xx answer to an `OfficeError`.
    static func error(status: Int, data: Data) -> OfficeError {
        let json = try? JSONValue.parse(data)
        let message = json?.string("error") ?? ""
        let reason = json?.string("reason") ?? ""
        switch status {
        case 401: return .unauthorized
        case 403: return .forbidden(message.isEmpty ? "Not allowed." : message)
        case 409:
            switch reason {
            case "already_resolved": return .alreadyAnswered
            case "answer_in_terminal": return .answerInTerminal
            case "no_runtime": return .noRuntime
            default: return .refused(reason: reason, message: message.isEmpty ? "The engine refused." : message)
            }
        case 400, 413, 415: return .badRequest(message.isEmpty ? "The engine could not read the request." : message)
        default: return .server(status: status, message: message)
        }
    }

    private func json(_ method: String, _ path: String, query: [URLQueryItem] = [], body: JSONValue? = nil) async throws -> JSONValue {
        let (data, status) = try await request(method, path, query: query, body: body, auth: true)
        guard (200..<300).contains(status) else { throw Self.error(status: status, data: data) }
        do { return try JSONValue.parse(data) } catch { throw OfficeError.invalidResponse("not JSON") }
    }

    /// Percent-encode each segment of a workspace path.
    static func workspacePath(_ segments: [String]) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#;")
        return "/" + segments.map { $0.addingPercentEncoding(withAllowedCharacters: allowed) ?? $0 }.joined(separator: "/")
    }

    /// The bytes of a workspace file, nil when it does not exist.
    public func file(_ segments: [String]) async throws -> Data? {
        let (data, status) = try await request("GET", Self.workspacePath(segments), auth: false)
        if status == 404 { return nil }
        guard (200..<300).contains(status) else { throw Self.error(status: status, data: data) }
        return data
    }

    /// Outcome of reading one snapshot document.
    public enum DocumentRead: Sendable {
        case missing
        case unreadable
        case value(JSONValue)
    }

    /// Read a snapshot document (`<project>/mas/state` …): the `.json`, else the `.js` twin (kit assistants may
    /// write only that), else missing. `statusId` reads a `mas/status/<id>.js` twin.
    public func document(project: String, path: String, global: String?, statusId: String? = nil) async throws -> DocumentRead {
        let parts = [project] + path.split(separator: "/").map(String.init)
        var jsonParts = parts
        jsonParts[jsonParts.count - 1] += ".json"
        if let data = try await file(jsonParts) {
            if let v = try? JSONValue.parse(data) { return .value(v) }
            return .unreadable
        }
        var jsParts = parts
        jsParts[jsParts.count - 1] += ".js"
        guard let data = try await file(jsParts) else { return .missing }
        let twin = JSTwin.parse(String(decoding: data, as: UTF8.self))
        if let statusId { return twin.statuses[statusId].map(DocumentRead.value) ?? .unreadable }
        if let global, let v = twin.globals[global] { return .value(v) }
        return .unreadable
    }

    // MARK: Reading

    /// `GET /v0/session`: whether the token is valid, whether a runtime is attached, backends, limits.
    public func session() async throws -> SessionInfo {
        SessionInfo(json: try await json("GET", "/v0/session"))
    }

    /// `home/projects`: nil when the workspace has none yet.
    public func projects() async throws -> ProjectsIndex? {
        switch try await documentAtHome() {
        case .value(let v): return ProjectsIndex(json: v)
        default: return nil
        }
    }

    private func documentAtHome() async throws -> DocumentRead {
        if let data = try await file(["home", "projects.json"]) {
            return (try? JSONValue.parse(data)).map(DocumentRead.value) ?? .unreadable
        }
        guard let data = try await file(["home", "projects.js"]) else { return .missing }
        return JSTwin.parse(String(decoding: data, as: UTF8.self)).globals["MAS_HOME"].map(DocumentRead.value) ?? .unreadable
    }

    /// All documents of a project, read in parallel. Missing optional documents are nil, never an error;
    /// documents that exist but cannot be read are listed in `unreadable`. Network failures throw.
    public func snapshot(project: String) async throws -> ProjectSnapshot {
        guard Self.isProjectName(project) else { throw OfficeError.invalidProject(project) }
        var snap = ProjectSnapshot(project: project)
        let docs = ProjectSnapshot.Document.allCases
        let reads = try await withThrowingTaskGroup(of: (ProjectSnapshot.Document, DocumentRead).self) { group in
            for d in docs {
                group.addTask { (d, try await self.document(project: project, path: d.rawValue, global: d.global)) }
            }
            var out: [ProjectSnapshot.Document: DocumentRead] = [:]
            for try await (d, r) in group { out[d] = r }
            return out
        }
        for (d, r) in reads {
            guard case .value(let v) = r else {
                if case .unreadable = r { snap.unreadable.insert(d.rawValue) }
                continue
            }
            switch d {
            case .structure: snap.structure = Structure(json: v)
            case .state: snap.state = ProjectState(json: v)
            case .task: snap.task = TaskDoc(json: v)
            case .result: snap.result = v.isObject ? ResultDoc(json: v) : nil
            case .inbox: snap.inbox = v.isObject ? Inbox(json: v) : nil
            case .board: snap.board = v.isObject ? Board(json: v) : nil
            case .verification: snap.verification = v.isObject ? Verification(json: v) : nil
            }
        }
        if let s = snap.structure {
            let ids = s.memberIds
            let statuses = try await withThrowingTaskGroup(of: (String, DocumentRead).self) { group in
                for id in ids {
                    group.addTask { (id, try await self.document(project: project, path: "mas/status/\(id)", global: nil, statusId: id)) }
                }
                var out: [(String, DocumentRead)] = []
                for try await r in group { out.append(r) }
                return out
            }
            for (id, r) in statuses {
                switch r {
                case .value(let v): snap.statuses[id] = AgentStatus(json: v)
                case .unreadable: snap.unreadable.insert("mas/status/\(id)")
                case .missing: break
                }
            }
        }
        return snap
    }

    /// `GET /v0/inbox`: the inbox snapshot.
    public func inbox(project: String) async throws -> Inbox {
        guard Self.isProjectName(project) else { throw OfficeError.invalidProject(project) }
        return Inbox(json: try await json("GET", "/v0/inbox", query: [URLQueryItem(name: "project", value: project)]))
    }

    /// Read the transcript of one agent from `cursor` on (nil: from the start).
    public func transcript(project: String, agentId: String, from cursor: TranscriptCursor? = nil) async throws -> TranscriptChunk {
        guard let data = try await file([project, "mas", "transcript", agentId + ".jsonl"]) else {
            return TranscriptChunk(entries: [], cursor: TranscriptCursor(), reset: cursor != nil && cursor!.consumed > 0, missing: true)
        }
        let r = (cursor ?? TranscriptCursor()).append(data)
        return TranscriptChunk(entries: r.entries, cursor: r.cursor, reset: r.reset || cursor == nil, missing: false)
    }

    /// The agent's work files: `<id>.md`, then `<id>-round2.md` … `-round9.md` until one is missing.
    public func workFiles(project: String, agentId: String) async throws -> [WorkFile] {
        var files: [WorkFile] = []
        let names = [agentId + ".md"] + (2...9).map { "\(agentId)-round\($0).md" }
        for (i, name) in names.enumerated() {
            guard let data = try await file([project, "outputs", "work", name]) else {
                if i == 0 { continue }
                break
            }
            files.append(WorkFile(name: name, text: String(String(decoding: data, as: UTF8.self).prefix(200_000))))
        }
        return files
    }

    // MARK: Commands

    private func command(project: String, type: String, agentId: String, data: [String: JSONValue], cmdId: String) async throws -> CommandAccepted {
        guard Self.isProjectName(project) else { throw OfficeError.invalidProject(project) }
        var d = data
        d["cmdId"] = .string(cmdId)
        let body = JSONValue.object(["type": .string(type), "agentId": .string(agentId), "data": .object(d)])
        let r = try await json("POST", "/v0/commands", query: [URLQueryItem(name: "project", value: project)], body: body)
        return CommandAccepted(cmdId: r.string("cmdId") ?? cmdId, seq: r.int("seq"), duplicate: r.bool("duplicate") == true)
    }

    /// Answer a request (`command.respond`). Throws `.alreadyAnswered` when it is no longer waiting.
    @discardableResult
    public func respond(project: String, requestId: String, agentId: String, answer: RequestAnswer, note: String? = nil,
                        cmdId: String = OfficeClient.newCommandId()) async throws -> CommandAccepted {
        var data: [String: JSONValue] = ["requestId": .string(requestId)]
        switch answer {
        case .option(let optionId, let text):
            data["outcome"] = "selected"
            data["optionId"] = .string(optionId)
            if let t = text?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { data["payload"] = .object(["text": .string(t)]) }
        case .text(let text):
            data["outcome"] = "submitted"
            data["payload"] = .object(["text": .string(text.trimmingCharacters(in: .whitespacesAndNewlines))])
        case .declined:
            data["outcome"] = "declined"
        }
        if let note, !note.isEmpty { data["note"] = .string(String(note.prefix(1000))) }
        return try await command(project: project, type: "command.respond", agentId: agentId, data: data, cmdId: cmdId)
    }

    /// Send a message to an agent (`command.message`).
    @discardableResult
    public func message(project: String, agentId: String, text: String, delivery: Delivery = .steer,
                        cmdId: String = OfficeClient.newCommandId()) async throws -> CommandAccepted {
        try await command(project: project, type: "command.message", agentId: agentId,
                          data: ["text": .string(text), "delivery": .string(delivery.rawValue)], cmdId: cmdId)
    }

    /// Ask an agent to stop its turn (`scope: turn`) or for good (`scope: agent`).
    @discardableResult
    public func interrupt(project: String, agentId: String, scope: String = "turn", reason: String? = nil,
                          cmdId: String = OfficeClient.newCommandId()) async throws -> CommandAccepted {
        var data: [String: JSONValue] = ["scope": .string(scope)]
        if let reason { data["reason"] = .string(reason) }
        return try await command(project: project, type: "command.interrupt", agentId: agentId, data: data, cmdId: cmdId)
    }

    /// Start a run of the locked team.
    public func startRun(project: String, task: String) async throws -> RunStarted {
        try await run(project: project, body: ["task": .string(task)])
    }

    /// Ask a follow-up question on the last result.
    public func followUp(project: String, question: String) async throws -> RunStarted {
        try await run(project: project, body: ["followUp": .string(question)])
    }

    private func run(project: String, body: [String: JSONValue]) async throws -> RunStarted {
        guard Self.isProjectName(project) else { throw OfficeError.invalidProject(project) }
        let r = try await json("POST", "/v0/runs", query: [URLQueryItem(name: "project", value: project)], body: .object(body))
        return RunStarted(runId: r.string("runId"), round: r.int("round"))
    }
}

