import Foundation

/// One dispatched Server-Sent Event.
public struct SSEMessage: Sendable, Hashable {
    /// The event type (`message` when the stream gave none).
    public var event: String
    public var data: String
    /// The last event id seen on the stream (it persists across events, per the spec).
    public var id: String?
    /// A `retry:` value in milliseconds given with this event, if any.
    public var retry: Int?
}

/// A Server-Sent Events parser following the WHATWG event-stream interpretation: lines end in CRLF, LF or CR
/// (also across chunk boundaries); `:` lines are comments; `data` lines accumulate with "\n"; an empty line
/// dispatches; an event with no data is dropped; `id` with a NUL is ignored; `retry` must be all digits; a
/// leading UTF-8 BOM is skipped. Feed bytes as they arrive.
public struct SSEParser: Sendable {
    private var line: [UInt8] = []
    private var lastWasCR = false
    private var sawFirstBytes = false
    private var eventType = ""
    private var data = ""
    private var hasData = false
    private var retry: Int?
    public private(set) var lastEventId: String?

    public init() {}

    /// Push one byte; returns an event when this byte completed one.
    public mutating func push(_ byte: UInt8) -> SSEMessage? {
        if byte == 0x0A {
            if lastWasCR {
                lastWasCR = false
                return nil
            }
            return endLine()
        }
        if byte == 0x0D {
            lastWasCR = true
            return endLine()
        }
        lastWasCR = false
        line.append(byte)
        return nil
    }

    /// Feed a chunk; returns the events it completed, in order.
    public mutating func feed<S: Sequence>(_ bytes: S) -> [SSEMessage] where S.Element == UInt8 {
        var out: [SSEMessage] = []
        for b in bytes {
            if let m = push(b) { out.append(m) }
        }
        return out
    }

    private mutating func endLine() -> SSEMessage? {
        var bytes = line
        line.removeAll(keepingCapacity: true)
        if !sawFirstBytes {
            sawFirstBytes = true
            if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { bytes.removeFirst(3) }
        }
        if bytes.isEmpty { return dispatch() }
        if bytes[0] == 0x3A { return nil } // comment
        let field: String
        var value: String
        if let colon = bytes.firstIndex(of: 0x3A) {
            field = String(decoding: bytes[..<colon], as: UTF8.self)
            var rest = bytes[(colon + 1)...]
            if rest.first == 0x20 { rest = rest.dropFirst() }
            value = String(decoding: rest, as: UTF8.self)
        } else {
            field = String(decoding: bytes, as: UTF8.self)
            value = ""
        }
        switch field {
        case "event":
            eventType = value
        case "data":
            data += value
            data += "\n"
            hasData = true
        case "id":
            if !value.unicodeScalars.contains("\u{0}") { lastEventId = value }
        case "retry":
            if !value.isEmpty, value.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }), let ms = Int(value) { retry = ms }
        default:
            value = ""
        }
        return nil
    }

    private mutating func dispatch() -> SSEMessage? {
        defer {
            eventType = ""
            data = ""
            hasData = false
            retry = nil
        }
        guard hasData else { return nil }
        var text = data
        if text.hasSuffix("\n") { text.removeLast() }
        return SSEMessage(event: eventType.isEmpty ? "message" : eventType, data: text, id: lastEventId, retry: retry)
    }
}
