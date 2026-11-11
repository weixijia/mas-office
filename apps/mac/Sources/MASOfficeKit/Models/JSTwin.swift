import Foundation

/// Reads a `.js` twin (spec §1.1) without running it. Recognises `window.NAME = <json>;` and the status form
/// `window.MAS_STATUS["<id>"] = <json>;`; everything else in the file is skipped. Linear in the input.
public enum JSTwin {
    public struct Document: Sendable, Hashable {
        /// `MAS_STATE` → value, …
        public var globals: [String: JSONValue] = [:]
        /// Status id → value, from `window.MAS_STATUS["<id>"] = …`.
        public var statuses: [String: JSONValue] = [:]
    }

    public static func parse(_ text: String) -> Document {
        let b = Array(text.utf8)
        let n = b.count
        var doc = Document()
        let prefix = Array("window.".utf8)
        var i = 0

        func skipSpace(_ j: inout Int) {
            while j < n, b[j] == 0x20 || b[j] == 0x09 || b[j] == 0x0A || b[j] == 0x0D { j += 1 }
        }
        func isIdent(_ c: UInt8) -> Bool {
            (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x5F || c == 0x24
        }
        /// Index just past a JSON string starting at `j` (a `"`), or nil when unterminated.
        func stringEnd(_ j: Int) -> Int? {
            var k = j + 1
            while k < n {
                if b[k] == 0x5C { k += 2; continue }
                if b[k] == 0x22 { return k + 1 }
                k += 1
            }
            return nil
        }
        /// Index just past the JSON value starting at `j`, or nil.
        func valueEnd(_ j: Int) -> Int? {
            guard j < n else { return nil }
            switch b[j] {
            case 0x22:
                return stringEnd(j)
            case 0x7B, 0x5B:
                var depth = 0
                var k = j
                while k < n {
                    switch b[k] {
                    case 0x22:
                        guard let e = stringEnd(k) else { return nil }
                        k = e
                        continue
                    case 0x7B, 0x5B: depth += 1
                    case 0x7D, 0x5D:
                        depth -= 1
                        if depth == 0 { return k + 1 }
                    default: break
                    }
                    k += 1
                }
                return nil
            case 0x2D, 0x30...0x39, 0x74, 0x66, 0x6E:
                var k = j
                while k < n, ![0x3B, 0x2C, 0x0A, 0x0D, 0x20, 0x09, 0x7D, 0x5D].contains(b[k]) { k += 1 }
                return k
            default:
                return nil
            }
        }
        func json(_ from: Int, _ to: Int) -> JSONValue? {
            try? JSONValue.parse(Data(b[from..<to]))
        }

        while i + prefix.count <= n {
            guard b[i] == 0x77, Array(b[i..<(i + prefix.count)]) == prefix, i == 0 || !isIdent(b[i - 1]) && b[i - 1] != 0x2E else {
                i += 1
                continue
            }
            var j = i + prefix.count
            let nameStart = j
            while j < n, isIdent(b[j]) { j += 1 }
            guard j > nameStart else { i = j; continue }
            let name = String(decoding: b[nameStart..<j], as: UTF8.self)
            var key: String?
            skipSpace(&j)
            if j < n, b[j] == 0x5B {
                j += 1
                skipSpace(&j)
                guard j < n, b[j] == 0x22, let e = stringEnd(j), let k = json(j, e)?.string else { i = j; continue }
                j = e
                skipSpace(&j)
                guard j < n, b[j] == 0x5D else { i = j; continue }
                j += 1
                key = k
                skipSpace(&j)
            }
            guard j < n, b[j] == 0x3D, j + 1 >= n || b[j + 1] != 0x3D else { i = j; continue }
            j += 1
            skipSpace(&j)
            guard let end = valueEnd(j), let value = json(j, end) else { i = j; continue }
            if let key {
                if name == "MAS_STATUS" { doc.statuses[key] = value }
            } else {
                doc.globals[name] = value
            }
            i = end
        }
        return doc
    }
}
