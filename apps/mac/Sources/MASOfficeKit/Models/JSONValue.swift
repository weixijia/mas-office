import Foundation

/// A JSON value, for the free-form parts of snapshots (request subjects, tool inputs, payloads) and as the
/// intermediate form every model is decoded from. Snapshots are written by agents, so models read fields
/// from a `JSONValue` leniently: a missing field or a field of the wrong type reads as "not given".
public enum JSONValue: Sendable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    /// Parse JSON text (any top-level value).
    public static func parse(_ data: Data) throws -> JSONValue {
        let any = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        return JSONValue(any: any)
    }

    /// Parse JSON text from a string.
    public static func parse(_ text: String) throws -> JSONValue {
        try parse(Data(text.utf8))
    }

    /// Convert what `JSONSerialization` returns. Anything it cannot return reads as `null`.
    public init(any: Any) {
        switch any {
        case let n as NSNumber:
            // JSONSerialization returns booleans as NSNumber too: tell them apart by their CF type.
            if CFGetTypeID(n) == CFBooleanGetTypeID() {
                self = .bool(n.boolValue)
            } else {
                self = .number(n.doubleValue)
            }
        case let s as String: self = .string(s)
        case let a as [Any]: self = .array(a.map(JSONValue.init(any:)))
        case let o as [String: Any]: self = .object(o.mapValues(JSONValue.init(any:)))
        default: self = .null
        }
    }

    /// The Foundation form (`JSONSerialization` input).
    public var foundationValue: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let b): return b
        case .number(let n): return n
        case .string(let s): return s
        case .array(let a): return a.map(\.foundationValue)
        case .object(let o): return o.mapValues(\.foundationValue)
        }
    }

    /// Compact JSON text with sorted keys.
    public func jsonText(pretty: Bool = false) -> String {
        if case .string(let s) = self, let data = try? JSONSerialization.data(withJSONObject: [s], options: [.fragmentsAllowed]),
           let text = String(data: data, encoding: .utf8) {
            return String(text.dropFirst().dropLast())
        }
        var options: JSONSerialization.WritingOptions = [.sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes]
        if pretty { options.insert(.prettyPrinted) }
        guard let data = try? JSONSerialization.data(withJSONObject: foundationValue, options: options) else { return "null" }
        return String(decoding: data, as: UTF8.self)
    }

    /// For people: a string as it is, anything else as indented JSON.
    public var prettyText: String {
        if case .string(let s) = self { return s }
        return jsonText(pretty: true)
    }
}

// MARK: - Accessors

extension JSONValue {
    public subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var string: String? { if case .string(let s) = self { return s }; return nil }
    public var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var array: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    public var object: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
    public var isNull: Bool { if case .null = self { return true }; return false }
    public var isObject: Bool { object != nil }

    /// A finite number.
    public var double: Double? {
        if case .number(let n) = self, n.isFinite { return n }
        return nil
    }

    /// A number with an integral value that fits an `Int`.
    public var int: Int? {
        guard let n = double, n.rounded() == n, abs(n) < 9.0e15 else { return nil }
        return Int(n)
    }

    /// `self[key]` as a string.
    public func string(_ key: String) -> String? { self[key]?.string }

    /// `self[key]` as a non-empty string.
    public func nonEmpty(_ key: String) -> String? {
        guard let s = self[key]?.string, !s.isEmpty else { return nil }
        return s
    }

    public func bool(_ key: String) -> Bool? { self[key]?.bool }
    public func double(_ key: String) -> Double? { self[key]?.double }
    public func int(_ key: String) -> Int? { self[key]?.int }

    /// `self[key]` as an array (empty when missing or not an array).
    public func list(_ key: String) -> [JSONValue] { self[key]?.array ?? [] }

    /// The string items of `self[key]` (other items are dropped).
    public func strings(_ key: String) -> [String] { list(key).compactMap(\.string) }

    /// `self[key]` when it is an object, else nil.
    public func objectValue(_ key: String) -> JSONValue? {
        guard let v = self[key], v.isObject else { return nil }
        return v
    }
}

// MARK: - Codable

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? c.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Not a JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}

/// A model that is built leniently from a `JSONValue`. `Decodable` comes for free: decode a `JSONValue`,
/// then build from it, so wrong types never fail a whole document.
public protocol JSONModel: Decodable {
    init(json: JSONValue)
}

extension JSONModel {
    public init(from decoder: Decoder) throws {
        self.init(json: try JSONValue(from: decoder))
    }

    /// Decode from JSON text.
    public static func decode(_ data: Data) throws -> Self {
        Self(json: try JSONValue.parse(data))
    }
}

// MARK: - Literals

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral,
    ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
    }
    public init(nilLiteral: ()) { self = .null }
}
