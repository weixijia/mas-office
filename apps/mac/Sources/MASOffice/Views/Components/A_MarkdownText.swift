import MASOfficeKit
import SwiftUI

/// Readable text from untrusted markdown (work files, agent messages): split into blocks (headings,
/// paragraphs, list items, quotes, code and tables), each rendered with `AttributedString(markdown:)` for
/// inline styling only. Nothing is loaded and nothing runs: no HTML, no images, and links open in the
/// default browser only for http(s) (`safeLinks`). Claim tags are stripped.
struct MarkdownText: View {
    var markdown: String
    var font: Font = .callout

    var body: some View {
        let blocks = MarkdownBlocks.parse(ClaimTags.stripped(markdown))
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in
                block(b)
            }
        }
        .textSelection(.enabled)
        .safeLinks()
    }

    @ViewBuilder
    private func block(_ b: MarkdownBlocks.Block) -> some View {
        switch b {
        case .heading(let level, let text):
            Text(MarkdownBlocks.inline(text))
                .font(level <= 1 ? .title3.weight(.semibold) : level == 2 ? .headline : .subheadline.weight(.semibold))
                .padding(.top, level <= 2 ? 4 : 2)
                .fixedSize(horizontal: false, vertical: true)
        case .paragraph(let text):
            Text(MarkdownBlocks.inline(text))
                .font(font)
                .fixedSize(horizontal: false, vertical: true)
        case .item(let marker, let indent, let text):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(verbatim: marker)
                    .font(font.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 12, alignment: .trailing)
                Text(MarkdownBlocks.inline(text))
                    .font(font)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.leading, CGFloat(indent) * 14)
        case .quote(let text):
            Text(MarkdownBlocks.inline(text))
                .font(font)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    Rectangle().fill(Color(nsColor: .separatorColor)).frame(width: 2)
                }
        case .code(let text):
            ScrollView(.horizontal) {
                Text(verbatim: text)
                    .font(.system(.caption, design: .monospaced))
                    .padding(8)
            }
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color(nsColor: .textBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5))
        case .rule:
            Divider()
        }
    }
}

enum MarkdownBlocks {
    enum Block: Equatable {
        case heading(Int, String)
        case paragraph(String)
        case item(String, Int, String)
        case quote(String)
        /// Fenced code and tables, shown as written in a monospaced block.
        case code(String)
        case rule
    }

    static func parse(_ text: String) -> [Block] {
        var out: [Block] = []
        var para: [String] = []
        var quote: [String] = []
        var code: [String]?
        var table: [String] = []
        func flushText() {
            if !para.isEmpty { out.append(.paragraph(para.joined(separator: "\n"))); para = [] }
            if !quote.isEmpty { out.append(.quote(quote.joined(separator: "\n"))); quote = [] }
        }
        func flush() {
            flushText()
            if !table.isEmpty { out.append(.code(table.joined(separator: "\n"))); table = [] }
        }
        for raw in text.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            let t = line.trimmingCharacters(in: .whitespaces)
            if var c = code {
                if t.hasPrefix("```") || t.hasPrefix("~~~") {
                    out.append(.code(c.joined(separator: "\n")))
                    code = nil
                } else {
                    c.append(line)
                    code = c
                }
                continue
            }
            if t.hasPrefix("```") || t.hasPrefix("~~~") { flush(); code = []; continue }
            if t.isEmpty { flush(); continue }
            if t.hasPrefix("|") { flushText(); table.append(t); continue }
            if !table.isEmpty { flush() }
            if t.hasPrefix("#") {
                let hashes = t.prefix { $0 == "#" }.count
                if hashes <= 6, t.dropFirst(hashes).first == " " {
                    flush()
                    out.append(.heading(hashes, String(t.dropFirst(hashes + 1))))
                    continue
                }
            }
            if t == "---" || t == "***" || t == "___" { flush(); out.append(.rule); continue }
            if t.hasPrefix(">") {
                if !para.isEmpty { out.append(.paragraph(para.joined(separator: "\n"))); para = [] }
                quote.append(String(t.dropFirst()).trimmingCharacters(in: .whitespaces))
                continue
            }
            let indent = (line.prefix { $0 == " " || $0 == "\t" }.count) / 2
            if let item = listItem(t) {
                flush()
                out.append(.item(item.marker, indent, item.text))
                continue
            }
            if !quote.isEmpty { flush() }
            if case .item(let m, let i, let prev)? = out.last, para.isEmpty, line.first == " " {
                out[out.count - 1] = .item(m, i, prev + "\n" + t)
                continue
            }
            para.append(t)
        }
        if let c = code { out.append(.code(c.joined(separator: "\n"))) }
        flush()
        return out
    }

    private static func listItem(_ t: String) -> (marker: String, text: String)? {
        for b in ["- ", "* ", "+ "] where t.hasPrefix(b) { return ("•", String(t.dropFirst(2))) }
        let digits = t.prefix { $0.isNumber }
        if !digits.isEmpty, digits.count <= 3 {
            let rest = t.dropFirst(digits.count)
            if rest.hasPrefix(". ") || rest.hasPrefix(") ") { return (digits + ".", String(rest.dropFirst(2))) }
        }
        return nil
    }

    /// Inline markdown (bold, italic, code, links) as an attributed string; links other than http(s) are
    /// removed. Falls back to the plain text.
    static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace,
                                                              failurePolicy: .returnPartiallyParsedIfPossible)
        guard var s = try? AttributedString(markdown: text, options: options) else { return AttributedString(text) }
        for run in s.runs {
            if let url = run.link, !["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                s[run.range].link = nil
            }
            if run.imageURL != nil { s[run.range].imageURL = nil }
        }
        return s
    }
}
