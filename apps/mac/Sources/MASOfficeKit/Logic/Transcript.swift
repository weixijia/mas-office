import Foundation

/// Where an incremental transcript read got to: the bytes consumed and the first bytes of the file, so a
/// rewritten file (it no longer starts the same) is read again from the start. The panel's `jsonlAppend`,
/// in bytes instead of UTF-16 units.
public struct TranscriptCursor: Sendable, Hashable {
    /// Bytes of complete lines already read (the byte offset of the next line).
    public var consumed: Int = 0
    var head = Data()

    public init() {}

    /// Parse the complete lines after `consumed` of the whole file `data`. A half-written last line waits for
    /// the next read; a broken line is skipped; a line that is not an object with a string `kind` is skipped.
    public func append(_ data: Data) -> (entries: [TranscriptEntry], cursor: TranscriptCursor, reset: Bool) {
        let bytes = [UInt8](data)
        let reset = !(consumed <= bytes.count && bytes.starts(with: head))
        let start = reset ? 0 : consumed
        let end = (bytes.lastIndex(of: 0x0A).map { $0 + 1 }) ?? 0
        var entries: [TranscriptEntry] = []
        if end > start {
            var lineStart = start
            for i in start..<end where bytes[i] == 0x0A {
                if i > lineStart, let value = try? JSONValue.parse(Data(bytes[lineStart..<i])), let e = TranscriptEntry(json: value) {
                    entries.append(e)
                }
                lineStart = i + 1
            }
        }
        var next = TranscriptCursor()
        next.consumed = max(start, end)
        next.head = Data(bytes.prefix(min(next.consumed, 256)))
        return (entries, next, reset)
    }
}

/// Transcript rows: a tool call and its result (same `callId`) form one step; consecutive steps of the same
/// tool collapse into one row with a count; a failed result marks its row. Other entries pass through.
public enum TranscriptRow: Sendable, Hashable {
    public struct Step: Sendable, Hashable {
        public var call: TranscriptEntry?
        public var result: TranscriptEntry?
    }
    public struct Tools: Sendable, Hashable {
        public var tool: String
        public var steps: [Step]
        public var ts: String?
        public var count: Int { steps.count }
        public var failed: Int { steps.filter { $0.result?.ok == false }.count }
        public var running: Int { steps.filter { $0.call != nil && $0.result == nil }.count }
    }
    case entry(TranscriptEntry)
    case tools(Tools)

    static func toolName(_ e: TranscriptEntry) -> String {
        guard let t = e.tool, !t.isEmpty else { return "tool" }
        return t
    }

    /// The panel's `groupTranscript`.
    public static func group(_ entries: [TranscriptEntry]) -> [TranscriptRow] {
        var rows: [TranscriptRow] = []
        // Where each open call's step lives: (row index, step index).
        var open: [String: (Int, Int)] = [:]
        for e in entries {
            if e.kind == "tool_call" {
                let step = Step(call: e, result: nil)
                if case .tools(var last)? = rows.last, last.tool == toolName(e), last.steps.first?.call != nil {
                    last.steps.append(step)
                    rows[rows.count - 1] = .tools(last)
                    if let id = e.callId { open[id] = (rows.count - 1, last.steps.count - 1) }
                } else {
                    rows.append(.tools(Tools(tool: toolName(e), steps: [step], ts: e.ts)))
                    if let id = e.callId { open[id] = (rows.count - 1, 0) }
                }
                continue
            }
            if e.kind == "tool_result" {
                if let id = e.callId, let (r, s) = open[id], case .tools(var t) = rows[r], t.steps[s].result == nil {
                    t.steps[s].result = e
                    rows[r] = .tools(t)
                    open.removeValue(forKey: id)
                    continue
                }
                rows.append(.tools(Tools(tool: toolName(e), steps: [Step(call: nil, result: e)], ts: e.ts)))
                continue
            }
            rows.append(.entry(e))
        }
        return rows
    }

    /// The tool an agent is using right now: the last call without a result (nil after an answer or result).
    public static func currentTool(_ entries: [TranscriptEntry]) -> (tool: String, summary: String?)? {
        var done = Set<String>()
        for e in entries.reversed() {
            if e.kind == "tool_result", let id = e.callId { done.insert(id) }
            if e.kind == "tool_call" {
                if let id = e.callId, done.contains(id) { return nil }
                return (toolName(e), e.summary)
            }
            if e.kind == "result" || e.kind == "assistant" { return nil }
        }
        return nil
    }
}
