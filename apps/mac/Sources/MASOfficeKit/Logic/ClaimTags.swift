import Foundation

/// A claim reference from a `<claim id="c3" src="a,b">` tag (RFC 0001 §2.5).
public struct ClaimRef: Sendable, Hashable {
    public var id: String
    /// Cited source ids (valid ids only).
    public var src: [String]

    public init(id: String, src: [String]) {
        self.id = id
        self.src = src
    }
}

/// A run of result text: plain, or the span of one claim.
public struct ClaimSegment: Sendable, Hashable {
    public var text: String
    public var claim: ClaimRef?

    public init(text: String, claim: ClaimRef? = nil) {
        self.text = text
        self.claim = claim
    }
}

/// Splits result markdown into plain runs and claim spans with the same grammar as `panel/model.js`
/// `claimSegments`: linear (each tag is looked for within a bounded window), and a tag that is malformed,
/// unclosed, nested or closes nothing stays as plain text. Works on UTF-16 units like the JS.
public enum ClaimTags {
    static let maxTag = 300

    /// `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`
    public static func isClaimId(_ s: String) -> Bool {
        let u = Array(s.utf16)
        guard (1...64).contains(u.count), isAlnum(u[0]) else { return false }
        return u.dropFirst().allSatisfy { isAlnum($0) || $0 == 0x2E || $0 == 0x5F || $0 == 0x3A || $0 == 0x2D }
    }

    static func isAlnum(_ c: UInt16) -> Bool { isLetter(c) || (c >= 0x30 && c <= 0x39) }
    static func isLetter(_ c: UInt16) -> Bool { (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) }

    /// JavaScript's `\s`.
    static func isSpace(_ c: UInt16) -> Bool {
        switch c {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
        default: return false
        }
    }

    static func lower(_ c: UInt16) -> UInt16 { (c >= 0x41 && c <= 0x5A) ? c + 32 : c }

    static func startsWith(_ t: [UInt16], _ at: Int, _ word: [UInt16]) -> Bool {
        guard at + word.count <= t.count else { return false }
        for k in 0..<word.count where lower(t[at + k]) != word[k] { return false }
        return true
    }

    static func string(_ t: ArraySlice<UInt16>) -> String { String(decoding: t, as: UTF16.self) }

    /// The attributes of a tag body (between `<claim` and `>`), or nil when malformed or without a valid id.
    static func attributes(_ body: ArraySlice<UInt16>) -> ClaimRef? {
        let b = Array(body)
        if b.contains(0x3C) || b.contains(0x3E) { return nil }
        var pairs: [(String, String)] = []
        var p = 0
        let n = b.count
        // ( \s+ name \s* = \s* value )* \s* $
        while true {
            let start = p
            var q = p
            while q < n, isSpace(b[q]) { q += 1 }
            var parsed = false
            if q > start {
                let nameStart = q
                while q < n, isLetter(b[q]) { q += 1 }
                if q > nameStart {
                    let name = string(b[nameStart..<q])
                    while q < n, isSpace(b[q]) { q += 1 }
                    if q < n, b[q] == 0x3D {
                        q += 1
                        while q < n, isSpace(b[q]) { q += 1 }
                        if q < n, b[q] == 0x22 || b[q] == 0x27 {
                            let quote = b[q]
                            var e = q + 1
                            while e < n, b[e] != quote { e += 1 }
                            if e < n {
                                pairs.append((name, string(b[(q + 1)..<e])))
                                p = e + 1
                                parsed = true
                            }
                        } else {
                            var e = q
                            while e < n, !isSpace(b[e]), ![0x22, 0x27, 0x3D, 0x3C, 0x3E, 0x60].contains(b[e]) { e += 1 }
                            if e > q {
                                pairs.append((name, string(b[q..<e])))
                                p = e
                                parsed = true
                            }
                        }
                    }
                }
            }
            if !parsed {
                // What is left must be whitespace only.
                guard b[start...].allSatisfy(isSpace) else { return nil }
                break
            }
        }
        var out: [String: String] = [:]
        for (k, v) in pairs { out[k.lowercased()] = v }
        guard let id = out["id"], isClaimId(id) else { return nil }
        let src = (out["src"] ?? "").split(separator: ",", omittingEmptySubsequences: false)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter(isClaimId)
        return ClaimRef(id: id, src: src)
    }

    /// Plain runs and claim spans, neighbouring plain runs merged. `segments("")` is `[]`.
    public static func segments(_ text: String) -> [ClaimSegment] {
        let t = Array(text.utf16)
        let n = t.count
        let closeWord = Array("</claim>".utf16), openWord = Array("<claim".utf16)
        var segs: [ClaimSegment] = []
        var plainFrom = 0
        var open: (at: Int, end: Int, ref: ClaimRef)?
        var i = 0
        func flushPlain(_ to: Int) {
            if to > plainFrom { segs.append(ClaimSegment(text: string(t[plainFrom..<to]), claim: nil)) }
        }
        while i < n {
            guard let at = t[i...].firstIndex(of: 0x3C) else { break }
            if startsWith(t, at, closeWord) {
                if let o = open {
                    flushPlain(o.at)
                    segs.append(ClaimSegment(text: string(t[o.end..<at]), claim: o.ref))
                    plainFrom = at + 8
                    open = nil
                }
                i = at + 8
                continue
            }
            if startsWith(t, at, openWord), at + 6 < n, isSpace(t[at + 6]) || t[at + 6] == 0x3E {
                let windowEnd = min(n, at + maxTag)
                if let gt = t[at..<windowEnd].firstIndex(of: 0x3E), gt > at, let ref = attributes(t[(at + 6)..<gt]) {
                    // A nested open replaces the outer one, which stays text.
                    open = (at, gt + 1, ref)
                    i = gt + 1
                    continue
                }
            }
            i = at + 1
        }
        flushPlain(n) // an unclosed tag: everything from it on is plain text
        var merged: [ClaimSegment] = []
        for s in segs {
            if s.claim == nil, let last = merged.last, last.claim == nil {
                merged[merged.count - 1].text += s.text
            } else {
                merged.append(s)
            }
        }
        return merged
    }

    /// The text with claim tags stripped (well-formed ones only, as a viewer shows it).
    public static func stripped(_ text: String) -> String {
        segments(text).map(\.text).joined()
    }

    /// The ids of the claims in `text`, in order of appearance.
    public static func claimIds(_ text: String) -> [String] {
        segments(text).compactMap { $0.claim?.id }
    }
}

/// "12 claims · 9 supported · 2 partial · 1 unknown · links: 7 live, 1 dead", with the bar's segments
/// (the panel's `credibility`).
public struct Credibility: Sendable, Hashable {
    public var text: String
    public var segments: [(status: ClaimStatus, count: Int)]
    public var total: Int

    public static func == (a: Credibility, b: Credibility) -> Bool {
        a.text == b.text && a.total == b.total && a.segments.map(\.status) == b.segments.map(\.status) && a.segments.map(\.count) == b.segments.map(\.count)
    }

    public func hash(into h: inout Hasher) {
        h.combine(text)
        h.combine(total)
    }

    public init(_ s: Verification.Summary) {
        let counts: [(ClaimStatus, Int)] = [(.supported, s.supported), (.partial, s.partial), (.contradicted, s.contradicted),
                                            (.unknown, s.unknown), (.unchecked, s.unchecked)]
        segments = counts.filter { $0.1 > 0 }.map { (status: $0.0, count: $0.1) }
        total = segments.reduce(0) { $0 + $1.count }
        let parts = ["\(s.claims) " + (s.claims == 1 ? "claim" : "claims")] + segments.map { "\($0.count) \($0.status.word)" }
        let links = [(s.live, "live"), (s.stale, "stale"), (s.hallucinated, "dead"), (s.blocked, "blocked")]
            .filter { $0.0 > 0 }.map { "\($0.0) \($0.1)" }
        text = parts.joined(separator: " · ") + (links.isEmpty ? "" : " · links: " + links.joined(separator: ", "))
    }
}
