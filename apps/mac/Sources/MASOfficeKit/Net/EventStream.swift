import Foundation

/// One logged protocol event as the stream carries it (`event: mas`).
public struct OfficeEvent: Sendable, Hashable {
    public var project: String?
    public var seq: Int
    public var type: String
    public var agentId: String?
    public var ts: String?
    public var data: JSONValue

    /// From the stream payload `{"project", "event": {...}}`; nil when malformed.
    public init?(payload: JSONValue) {
        guard let e = payload.objectValue("event"), let seq = e.int("seq"), let type = e.nonEmpty("type") else { return nil }
        project = payload.string("project")
        self.seq = seq
        self.type = type
        agentId = e.string("agentId")
        ts = e.string("ts")
        data = e["data"] ?? .object([:])
    }
}

/// What the stream reports.
public enum StreamEvent: Sendable, Hashable {
    /// Connected (again): anything may have changed meanwhile, so re-read the snapshots.
    case connected
    /// A workspace file changed (`path` is relative to the workspace, e.g. `deals/mas/state.json`).
    case change(path: String)
    /// A protocol event was appended to a project's log.
    case event(OfficeEvent)
    /// The stream is down; it reconnects by itself after `retryIn` seconds.
    case disconnected(reason: String, retryIn: Double)
}

/// The daemon's `/v0/stream` (Server-Sent Events) as an `AsyncStream`. Reconnects with backoff (1, 2, 4 … 30 s)
/// and asks for a replay from the last `seq` of `project` it saw. Cancel by dropping the stream (or the task
/// iterating it).
public struct EventStream: Sendable {
    public let baseURL: URL
    let token: String?
    public let project: String?
    public var since: Int?
    /// Idle timeout: the server sends a comment every 15 s, so 45 s of silence means the connection is gone.
    public var idleTimeout: TimeInterval = 45

    public init(baseURL: URL, token: String?, project: String?, since: Int? = nil) {
        self.baseURL = baseURL
        self.token = token
        self.project = project
        self.since = since
    }

    /// Seconds to wait before reconnect attempt `n` (0-based): 1, 2, 4, 8, 16, 30, 30 …
    public static func backoff(_ n: Int) -> Double {
        min(30, pow(2, Double(min(n, 10))))
    }

    func url(since: Int?) -> URL? {
        guard var c = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return nil }
        c.path = "/v0/stream"
        var q: [URLQueryItem] = []
        if let project { q.append(URLQueryItem(name: "project", value: project)) }
        if let since { q.append(URLQueryItem(name: "since", value: String(since))) }
        c.queryItems = q.isEmpty ? nil : q
        return c.url
    }

    public func events() -> AsyncStream<StreamEvent> {
        let config = self
        return AsyncStream(bufferingPolicy: .bufferingNewest(1000)) { continuation in
            let task = Task {
                await config.run(continuation)
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func run(_ out: AsyncStream<StreamEvent>.Continuation) async {
        let sessionConfig = URLSessionConfiguration.ephemeral
        sessionConfig.timeoutIntervalForRequest = idleTimeout
        sessionConfig.timeoutIntervalForResource = 60 * 60 * 24 * 365
        sessionConfig.requestCachePolicy = .reloadIgnoringLocalCacheData
        sessionConfig.urlCache = nil
        sessionConfig.connectionProxyDictionary = [:]
        let session = URLSession(configuration: sessionConfig)
        defer { session.invalidateAndCancel() }
        var lastSeq = since
        var attempt = 0
        while !Task.isCancelled {
            var reason = "closed"
            do {
                guard let url = url(since: lastSeq) else { return }
                var req = URLRequest(url: url)
                req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
                let (bytes, response) = try await session.bytes(for: req)
                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    throw OfficeError.server(status: (response as? HTTPURLResponse)?.statusCode ?? 0, message: "stream refused")
                }
                out.yield(.connected)
                attempt = 0
                var parser = SSEParser()
                for try await byte in bytes {
                    guard let message = parser.push(byte) else { continue }
                    guard let payload = try? JSONValue.parse(message.data) else { continue }
                    switch message.event {
                    case "change":
                        if let path = payload.string("path") { out.yield(.change(path: path)) }
                    case "mas":
                        if let e = OfficeEvent(payload: payload) {
                            if e.project == project { lastSeq = max(lastSeq ?? 0, e.seq) }
                            out.yield(.event(e))
                        }
                    default:
                        break
                    }
                }
            } catch is CancellationError {
                return
            } catch let e as OfficeError {
                reason = e.userMessage
            } catch {
                reason = (error as NSError).localizedDescription
            }
            if Task.isCancelled { return }
            let wait = Self.backoff(attempt)
            attempt += 1
            out.yield(.disconnected(reason: reason, retryIn: wait))
            try? await Task.sleep(for: .seconds(wait))
        }
    }
}
