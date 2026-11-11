import Foundation

/// One run of inline text with its styles. `link` is set for http/https links only; `claim` for text inside a
/// `<claim>` tag.
public struct MarkdownSpan: Sendable, Hashable {
    public var text: String
    public var strong: Bool
    public var emphasis: Bool
    public var code: Bool
    public var link: URL?
    public var claim: ClaimRef?

    public init(text: String, strong: Bool = false, emphasis: Bool = false, code: Bool = false, link: URL? = nil, claim: ClaimRef? = nil) {
        self.text = text
        self.strong = strong
        self.emphasis = emphasis
        self.code = code
        self.link = link
        self.claim = claim
    }
}

/// Inline content: styled runs in order.
public struct MarkdownInline: Sendable, Hashable {
    public var spans: [MarkdownSpan]

    public init(_ spans: [MarkdownSpan] = []) { self.spans = spans }

    /// The text without any markup.
    public var plainText: String { spans.map(\.text).joined() }
    public var isEmpty: Bool { spans.allSatisfy { $0.text.isEmpty } }
    /// The claims in this run, in order of appearance (each once).
    public var claims: [ClaimRef] {
        var seen = Set<String>()
        return spans.compactMap(\.claim).filter { seen.insert($0.id).inserted }
    }
}

public enum MarkdownAlignment: String, Sendable, Hashable { case leading, center, trailing }

public struct MarkdownTable: Sendable, Hashable {
    public var header: [MarkdownInline]
    public var alignments: [MarkdownAlignment]
    /// Every row has exactly `header.count` cells (missing cells are empty, extra ones dropped).
    public var rows: [[MarkdownInline]]
}

public struct MarkdownList: Sendable, Hashable {
    public var ordered: Bool
    /// The first number of an ordered list.
    public var start: Int
    public var items: [MarkdownListItem]
}

public struct MarkdownListItem: Sendable, Hashable {
    public var content: MarkdownInline
    public var children: [MarkdownList]
}

public enum MarkdownBlock: Sendable, Hashable {
    case heading(level: Int, MarkdownInline)
    case paragraph(MarkdownInline)
    case list(MarkdownList)
    case table(MarkdownTable)
    case code(language: String?, text: String)
    case quote(MarkdownInline)
    case rule
}

/// The safe markdown subset the panel renders (`panel/model.js` `renderMarkdown`): headings, paragraphs, bold,
/// italics, inline code, ordered and unordered lists, tables, block quotes, rules and links, plus fenced code
/// blocks and nested lists. Claim tags (`<claim id=…>`) become claim spans with the panel's grammar.
///
/// - No HTML passes through: anything that is not this syntax is text.
/// - Links are kept for `http`/`https` only; any other target leaves the label as text.
/// - No images and no remote loads: `![alt](url)` is text plus a link label.
/// - Linear time: every scan uses precomputed "next delimiter" tables, so hostile input cannot backtrack.
public enum Markdown {
    /// Lists nest at most this deep; deeper items continue the list at this depth.
    public static let maxListDepth = 8

    // MARK: Blocks

    public static func parse(_ markdown: String) -> [MarkdownBlock] {
        let normalized = markdown.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var blocks: [MarkdownBlock] = []
        var i = 0
        while i < lines.count {
            let l = lines[i]
            if isBlank(l) { i += 1; continue }
            if let fence = fenceOpen(l) {
                var body: [String] = []
                i += 1
                while i < lines.count, !isFenceClose(lines[i], fence) {
                    body.append(lines[i])
                    i += 1
                }
                if i < lines.count { i += 1 } // the closing fence
                blocks.append(.code(language: fence.language, text: body.joined(separator: "\n")))
                continue
            }
            if let h = heading(l) {
                blocks.append(.heading(level: h.level, inline(h.text)))
                i += 1
                continue
            }
            if isRule(l) {
                blocks.append(.rule)
                i += 1
                continue
            }
            if l.contains("|"), i + 1 < lines.count, isSeparator(lines[i + 1]) {
                let head = row(l)
                let aligns = row(lines[i + 1]).map { c -> MarkdownAlignment in
                    if c.hasPrefix(":") && c.hasSuffix(":") { return .center }
                    return c.hasSuffix(":") ? .trailing : .leading
                }
                i += 2
                var body: [[String]] = []
                while i < lines.count, !isBlank(lines[i]), lines[i].contains("|") {
                    body.append(row(lines[i]))
                    i += 1
                }
                let alignments = head.indices.map { $0 < aligns.count ? aligns[$0] : .leading }
                blocks.append(.table(MarkdownTable(header: head.map(inline), alignments: alignments,
                                                   rows: body.map { r in head.indices.map { inline($0 < r.count ? r[$0] : "") } })))
                continue
            }
            if listItem(l) != nil {
                blocks.append(.list(parseList(lines, &i, depth: 0)))
                continue
            }
            if l.hasPrefix(">") {
                var q: [String] = []
                while i < lines.count, lines[i].hasPrefix(">") {
                    var s = Substring(lines[i].dropFirst())
                    if let f = s.first, f == " " || f == "\t" { s = s.dropFirst() }
                    q.append(String(s))
                    i += 1
                }
                blocks.append(.quote(inline(q.joined(separator: " "))))
                continue
            }
            var para = [trim(l)]
            i += 1
            while i < lines.count, !isBlank(lines[i]), !startsBlock(lines[i], i + 1 < lines.count ? lines[i + 1] : nil) {
                para.append(trim(lines[i]))
                i += 1
            }
            blocks.append(.paragraph(inline(para.joined(separator: " "))))
        }
        return blocks
    }

    /// One list starting at `lines[i]` (a list line); `i` ends after it. Items at the first item's indentation
    /// (±1) of the same kind are siblings; lines indented 2+ deeper start a child list.
    static func parseList(_ lines: [String], _ i: inout Int, depth: Int) -> MarkdownList {
        guard let first = listItem(lines[i]) else { return MarkdownList(ordered: false, start: 1, items: []) }
        let level = first.indent
        var items: [MarkdownListItem] = []
        var isFirst = true
        while i < lines.count, let m = listItem(lines[i]), m.ordered == first.ordered,
              isFirst || (m.indent >= level && m.indent < level + 2) {
            isFirst = false
            var text = m.text
            var children: [MarkdownList] = []
            i += 1
            while i < lines.count {
                if let c = listItem(lines[i]) {
                    guard depth + 1 < maxListDepth, c.indent >= level + 2 else { break }
                    children.append(parseList(lines, &i, depth: depth + 1))
                } else if leadingSpaces(lines[i]) >= 2, !isBlank(lines[i]), children.isEmpty {
                    text += " " + trim(lines[i])
                    i += 1
                } else {
                    break
                }
            }
            items.append(MarkdownListItem(content: inline(text), children: children))
        }
        return MarkdownList(ordered: first.ordered, start: first.number ?? 1, items: items)
    }

    // MARK: Line tests (no regular expressions: each is one pass over the line)

    static func isBlank(_ l: String) -> Bool { l.allSatisfy(\.isWhitespace) }

    static func trim(_ s: String) -> String { s.trimmingCharacters(in: .whitespaces) }

    static func leadingSpaces(_ l: String) -> Int {
        var n = 0
        for c in l {
            if c == " " { n += 1 } else if c == "\t" { n += 4 } else { break }
        }
        return n
    }

    /// `^(#{1,6})\s+(.*?)\s*#*\s*$`
    static func heading(_ l: String) -> (level: Int, text: String)? {
        var level = 0
        var idx = l.startIndex
        while idx < l.endIndex, l[idx] == "#" {
            level += 1
            idx = l.index(after: idx)
        }
        guard (1...6).contains(level), idx < l.endIndex, l[idx] == " " || l[idx] == "\t" else { return nil }
        var text = Substring(l[idx...]).trimmingCharacters(in: .whitespaces)
        while text.hasSuffix("#") { text.removeLast() }
        return (level, text.trimmingCharacters(in: .whitespaces))
    }

    /// `^\s*([-*_])(\s*\1){2,}\s*$`
    static func isRule(_ l: String) -> Bool {
        var marker: Character?
        var count = 0
        for c in l where c != " " && c != "\t" {
            guard c == "-" || c == "*" || c == "_" else { return false }
            if marker == nil { marker = c }
            guard c == marker else { return false }
            count += 1
        }
        return count >= 3
    }

    /// A table separator line: `| :--- | ---: |` (cells of 2+ dashes with optional colons).
    static func isSeparator(_ l: String) -> Bool {
        guard l.contains("-") else { return false }
        var s = Substring(trim(l))
        if s.hasPrefix("|") { s = s.dropFirst() }
        if s.hasSuffix("|") { s = s.dropLast() }
        guard !s.isEmpty else { return false }
        for cell in s.split(separator: "|", omittingEmptySubsequences: false) {
            var c = Substring(cell.trimmingCharacters(in: .whitespaces))
            if c.hasPrefix(":") { c = c.dropFirst() }
            if c.hasSuffix(":") { c = c.dropLast() }
            guard c.count >= 2, c.allSatisfy({ $0 == "-" }) else { return false }
        }
        return true
    }

    static func row(_ l: String) -> [String] {
        var s = Substring(trim(l))
        if s.hasPrefix("|") { s = s.dropFirst() }
        if s.hasSuffix("|") { s = s.dropLast() }
        return s.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// `^\s*([-*+]|\d+[.)])\s+(.*)$`
    static func listItem(_ l: String) -> (indent: Int, ordered: Bool, number: Int?, text: String)? {
        let indent = leadingSpaces(l)
        let body = l.drop { $0 == " " || $0 == "\t" }
        guard let c = body.first else { return nil }
        var rest: Substring
        var number: Int?
        if c == "-" || c == "*" || c == "+" {
            rest = body.dropFirst()
        } else if c.isASCII, c.isNumber {
            let digits = body.prefix { $0.isASCII && $0.isNumber }
            rest = body.dropFirst(digits.count)
            guard let d = rest.first, d == "." || d == ")" else { return nil }
            rest = rest.dropFirst()
            number = digits.count <= 9 ? Int(digits) : nil
        } else {
            return nil
        }
        guard let sp = rest.first, sp == " " || sp == "\t" else { return nil }
        let text = rest.drop { $0 == " " || $0 == "\t" }
        guard !text.isEmpty else { return nil }
        return (indent, !(c == "-" || c == "*" || c == "+"), number, String(text))
    }

    struct Fence { var char: Character; var count: Int; var language: String? }

    static func fenceOpen(_ l: String) -> Fence? {
        guard leadingSpaces(l) <= 3 else { return nil }
        let body = l.drop { $0 == " " }
        guard let c = body.first, c == "`" || c == "~" else { return nil }
        let run = body.prefix { $0 == c }
        guard run.count >= 3 else { return nil }
        let info = body.dropFirst(run.count).trimmingCharacters(in: .whitespaces)
        if c == "`", info.contains("`") { return nil }
        let lang = info.split(separator: " ").first.map(String.init)
        return Fence(char: c, count: run.count, language: lang?.isEmpty == false ? lang : nil)
    }

    static func isFenceClose(_ l: String, _ f: Fence) -> Bool {
        guard leadingSpaces(l) <= 3 else { return false }
        let t = trim(l)
        return t.count >= f.count && t.allSatisfy { $0 == f.char }
    }

    static func startsBlock(_ l: String, _ next: String?) -> Bool {
        heading(l) != nil || listItem(l) != nil || l.hasPrefix(">") || isRule(l) || fenceOpen(l) != nil
            || (l.contains("|") && next.map(isSeparator) == true)
    }

    // MARK: Inline

    /// Inline content of one block: claim spans first (as the panel's `inlineMd`), then code, links and emphasis
    /// inside each run.
    public static func inline(_ text: String) -> MarkdownInline {
        var spans: [MarkdownSpan] = []
        for seg in ClaimTags.segments(text) {
            for var s in core(seg.text) {
                s.claim = seg.claim
                spans.append(s)
            }
        }
        return MarkdownInline(merge(spans))
    }

    /// Code spans and links, with emphasis in the text between them and in link labels.
    static func core(_ text: String) -> [MarkdownSpan] {
        let c = Array(text)
        let n = c.count
        guard n > 0 else { return [] }
        // next[k][i]: the first index >= i holding the delimiter, or n.
        func table(_ want: (Character) -> Bool) -> [Int] {
            var t = [Int](repeating: n, count: n + 1)
            var j = n - 1
            while j >= 0 {
                t[j] = want(c[j]) ? j : t[j + 1]
                j -= 1
            }
            return t
        }
        let nextTick = table { $0 == "`" }
        let nextClose = table { $0 == "]" }
        let nextQuote = table { $0 == "\"" }
        let nextSpaceOrParen = table { $0 == ")" || $0.isWhitespace }
        var failedClose = Set<Int>()
        var out: [MarkdownSpan] = []
        var plainFrom = 0
        var i = 0
        func flush(_ to: Int) {
            if to > plainFrom { out += emphasis(Array(c[plainFrom..<to])) }
        }
        while i < n {
            let ch = c[i]
            if ch == "`" {
                let j = nextTick[i + 1]
                if j < n, j > i + 1 {
                    flush(i)
                    out.append(MarkdownSpan(text: String(c[(i + 1)..<j]), code: true))
                    i = j + 1
                    plainFrom = i
                    continue
                }
            } else if ch == "[" {
                let k = nextClose[i + 1]
                if k < n, k > i + 1, !failedClose.contains(k) {
                    if let (end, url) = linkTarget(c, open: k + 1, nextQuote: nextQuote, nextSpaceOrParen: nextSpaceOrParen) {
                        flush(i)
                        let label = emphasis(Array(c[(i + 1)..<k]))
                        let target = safeURL(url)
                        out += label.map { var s = $0; s.link = target; return s }
                        i = end + 1
                        plainFrom = i
                        continue
                    }
                    failedClose.insert(k)
                }
            }
            i += 1
        }
        flush(n)
        return out
    }

    /// `\(([^)\s]+)(?:\s+"[^"]*")?\)` starting at `open` (which must be `(`). Returns the index of `)` and the URL.
    static func linkTarget(_ c: [Character], open: Int, nextQuote: [Int], nextSpaceOrParen: [Int]) -> (Int, String)? {
        let n = c.count
        guard open < n, c[open] == "(" else { return nil }
        let urlStart = open + 1
        let urlEnd = nextSpaceOrParen[min(urlStart, n)]
        guard urlEnd < n, urlEnd > urlStart else { return nil }
        let url = String(c[urlStart..<urlEnd])
        if c[urlEnd] == ")" { return (urlEnd, url) }
        var p = urlEnd
        while p < n, c[p].isWhitespace { p += 1 }
        guard p < n, c[p] == "\"" else { return nil }
        let q = nextQuote[p + 1]
        guard q < n, q + 1 < n, c[q + 1] == ")" else { return nil }
        return (q + 1, url)
    }

    /// An http(s) URL, or nil for anything else (javascript:, file:, relative paths…).
    public static func safeURL(_ raw: String) -> URL? {
        let s = raw.trimmingCharacters(in: .whitespaces)
        let lower = s.lowercased()
        guard lower.hasPrefix("http://") || lower.hasPrefix("https://"), let url = URL(string: s), url.host?.isEmpty == false else { return nil }
        return url
    }

    static func isWord(_ ch: Character) -> Bool { (ch.isASCII && (ch.isLetter || ch.isNumber)) || ch == "_" }

    /// Bold (`**x**`, `__x__`) then italics (`*x*`, `_x_`), as the panel's `emphasis`.
    static func emphasis(_ chars: [Character]) -> [MarkdownSpan] {
        var c = chars
        var strong = [Bool](repeating: false, count: c.count)
        for marker in ["*", "_"] as [Character] {
            let n = c.count
            var positions: [Int] = []
            var i = 0
            while i + 1 < n {
                if c[i] == marker, c[i + 1] == marker {
                    positions.append(i)
                    i += 2
                } else {
                    i += 1
                }
            }
            var drop = [Bool](repeating: false, count: n)
            var k = 0
            while k + 1 < positions.count {
                let o = positions[k], e = positions[k + 1]
                if e >= o + 3, !c[o + 2].isWhitespace {
                    for j in (o + 2)..<e { strong[j] = true }
                    drop[o] = true; drop[o + 1] = true; drop[e] = true; drop[e + 1] = true
                    k += 2
                } else {
                    k += 1
                }
            }
            if drop.contains(true) {
                var nc: [Character] = [], ns: [Bool] = []
                nc.reserveCapacity(n)
                for j in 0..<n where !drop[j] {
                    nc.append(c[j])
                    ns.append(strong[j])
                }
                c = nc
                strong = ns
            }
        }
        var em = [Bool](repeating: false, count: c.count)
        for marker in ["*", "_"] as [Character] {
            let n = c.count
            var next = [Int](repeating: n, count: n + 1)
            var j = n - 1
            while j >= 0 {
                next[j] = c[j] == marker ? j : next[j + 1]
                j -= 1
            }
            var drop = [Bool](repeating: false, count: n)
            var i = 0
            while i < n {
                guard c[i] == marker, !drop[i] else { i += 1; continue }
                let prevOK: Bool = {
                    guard i > 0 else { return true }
                    let p = c[i - 1]
                    return marker == "*" ? !(isWord(p) || p == "*") : !isWord(p)
                }()
                guard prevOK, i + 1 < n, !c[i + 1].isWhitespace, c[i + 1] != marker else { i += 1; continue }
                let e = next[i + 1]
                guard e < n, e + 1 == n || !isWord(c[e + 1]) else { i += 1; continue }
                for k in (i + 1)..<e { em[k] = true }
                drop[i] = true
                drop[e] = true
                i = e + 1
            }
            if drop.contains(true) {
                var nc: [Character] = [], ns: [Bool] = [], ne: [Bool] = []
                for k in 0..<n where !drop[k] {
                    nc.append(c[k])
                    ns.append(strong[k])
                    ne.append(em[k])
                }
                c = nc
                strong = ns
                em = ne
            }
        }
        var out: [MarkdownSpan] = []
        var from = 0
        for k in 0...c.count {
            if k == c.count || (k > from && (strong[k] != strong[from] || em[k] != em[from])) {
                if k > from { out.append(MarkdownSpan(text: String(c[from..<k]), strong: strong[from], emphasis: em[from])) }
                from = k
            }
        }
        return out
    }

    /// Neighbouring spans with the same styles become one.
    static func merge(_ spans: [MarkdownSpan]) -> [MarkdownSpan] {
        var out: [MarkdownSpan] = []
        for s in spans where !s.text.isEmpty {
            if var last = out.last, last.strong == s.strong, last.emphasis == s.emphasis, last.code == s.code,
               last.link == s.link, last.claim == s.claim {
                last.text += s.text
                out[out.count - 1] = last
            } else {
                out.append(s)
            }
        }
        return out
    }

    /// Plain text of the blocks (for accessibility and search), one block per line.
    public static func plainText(_ blocks: [MarkdownBlock]) -> String {
        func list(_ l: MarkdownList, _ depth: Int) -> [String] {
            l.items.enumerated().flatMap { k, item in
                [String(repeating: "  ", count: depth) + (l.ordered ? "\(l.start + k). " : "• ") + item.content.plainText]
                    + item.children.flatMap { list($0, depth + 1) }
            }
        }
        return blocks.flatMap { b -> [String] in
            switch b {
            case .heading(_, let t), .paragraph(let t), .quote(let t): return [t.plainText]
            case .list(let l): return list(l, 0)
            case .table(let t): return [t.header.map(\.plainText).joined(separator: "\t")] + t.rows.map { $0.map(\.plainText).joined(separator: "\t") }
            case .code(_, let text): return [text]
            case .rule: return ["—"]
            }
        }.joined(separator: "\n")
    }
}

/// Column widths for a table: natural widths when they fit, else shrink wrapping columns toward their minimum
/// (longest word), else keep the minimums and scroll horizontally.
public struct MarkdownTableLayout: Sendable, Hashable {
    public var widths: [Double]
    /// The minimum widths do not fit: the table scrolls sideways.
    public var scrolls: Bool

    public init(widths: [Double], scrolls: Bool) {
        self.widths = widths
        self.scrolls = scrolls
    }

    public static func fit(natural: [Double], minimum: [Double], available: Double) -> MarkdownTableLayout {
        let mins = zip(natural, minimum).map { Swift.min($0, $1) }
        let total = natural.reduce(0, +)
        if total <= available { return MarkdownTableLayout(widths: natural, scrolls: false) }
        let minTotal = mins.reduce(0, +)
        if minTotal > available { return MarkdownTableLayout(widths: mins, scrolls: true) }
        let slack = zip(natural, mins).map { $0 - $1 }
        let slackTotal = slack.reduce(0, +)
        let spare = available - minTotal
        let widths = zip(mins, slack).map { m, s in slackTotal > 0 ? (m + spare * s / slackTotal).rounded(.down) : m }
        return MarkdownTableLayout(widths: widths, scrolls: false)
    }
}
