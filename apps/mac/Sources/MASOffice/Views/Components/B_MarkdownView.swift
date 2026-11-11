import AppKit
import MASOfficeKit
import SwiftUI

/// Native rendering of the safe markdown subset (`Markdown.parse` in the Kit): text runs are TextKit 1 text views
/// (selectable, links open in the default browser), tables are a real grid with a header row and wrapping cells
/// (scrolling sideways only when a table cannot fit), fenced code is monospaced. No HTML, no images, no remote
/// loads: every input is text.
///
/// Claims: pass `claims` (claim id → status) to underline each claim span with its verdict's pattern, and
/// `claimDetail` to open a popover on hover, click, or keyboard focus (Tab moves between claims, Return or
/// Space pins the popover, Escape closes it).
///
///     B_MarkdownView(markdown: text)                                    // work files, summaries
///     B_MarkdownView(markdown: round.markdown, claims: statuses) { id in AnyView(ClaimDetailView(claimId: id)) }
struct B_MarkdownView: View {
    var markdown: String
    var claims: [String: ClaimStatus] = [:]
    var textSize: CGFloat = NSFont.systemFontSize
    var claimDetail: ((String) -> AnyView?)?

    @ViewState private var width: CGFloat = 0

    init(markdown: String, claims: [String: ClaimStatus] = [:], textSize: CGFloat = NSFont.systemFontSize,
         claimDetail: ((String) -> AnyView?)? = nil) {
        self.markdown = markdown
        self.claims = claims
        self.textSize = textSize
        self.claimDetail = claimDetail
    }

    var body: some View {
        let segments = B_MarkdownCache.shared.segments(markdown, claims: claims, size: textSize, interactive: claimDetail != nil)
        VStack(alignment: .leading, spacing: textSize * 0.8) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, seg in
                switch seg {
                case .text(let text):
                    B_RichText(text: text, claimDetail: claimDetail)
                case .table(let table):
                    B_FitWidth {
                        B_MarkdownTableView(table: table, claims: claims, textSize: textSize, available: width > 0 ? width : 240, claimDetail: claimDetail)
                    }
                    .clipped()
                case .code(let language, let code):
                    B_CodeBlock(language: language, code: code, textSize: textSize)
                case .rule:
                    Divider().padding(.vertical, 2)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(GeometryReader { g in
            Color.clear
                .onAppear { width = g.size.width }
                .onChange(of: g.size.width) { _, w in width = w }
        })
    }
}

/// Reports at most the offered width, whatever its content asks for, so a wide table never widens the column it
/// sits in (the table measures that width and wraps or scrolls inside it).
struct B_FitWidth: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        let size = child.sizeThatFits(proposal)
        guard let w = proposal.width else { return CGSize(width: min(size.width, 300), height: size.height) }
        return CGSize(width: w.isFinite ? min(size.width, w) : size.width, height: size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, anchor: .topLeading, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}

/// A run of the document as one view.
enum B_MarkdownSegment {
    case text(NSAttributedString)
    case table(MarkdownTable)
    case code(String?, String)
    case rule
}

/// Parsed and styled documents, so re-rendering a view does not re-parse its text.
@MainActor
final class B_MarkdownCache {
    static let shared = B_MarkdownCache()
    private struct Key: Hashable {
        var markdown: String
        var claims: [String: ClaimStatus]
        var size: CGFloat
        var interactive: Bool
    }
    private var entries: [Key: [B_MarkdownSegment]] = [:]
    private var order: [Key] = []

    func segments(_ markdown: String, claims: [String: ClaimStatus], size: CGFloat, interactive: Bool) -> [B_MarkdownSegment] {
        let key = Key(markdown: markdown, claims: claims, size: size, interactive: interactive)
        if let hit = entries[key] { return hit }
        let made = B_AttributedMarkdown.segments(Markdown.parse(markdown), claims: claims, size: size, interactive: interactive)
        entries[key] = made
        order.append(key)
        if order.count > 48 { entries[order.removeFirst()] = nil }
        return made
    }
}

/// Builds attributed strings from parsed blocks.
@MainActor
enum B_AttributedMarkdown {
    static let claimKey = NSAttributedString.Key("MASClaimID")
    static let claimScheme = "x-mas-claim"

    static func segments(_ blocks: [MarkdownBlock], claims: [String: ClaimStatus], size: CGFloat, interactive: Bool) -> [B_MarkdownSegment] {
        var out: [B_MarkdownSegment] = []
        var run: [MarkdownBlock] = []
        func flush() {
            if !run.isEmpty { out.append(.text(text(run, claims: claims, size: size, interactive: interactive))) }
            run = []
        }
        for b in blocks {
            switch b {
            case .table(let t): flush(); out.append(.table(t))
            case .code(let l, let c): flush(); out.append(.code(l, c))
            case .rule: flush(); out.append(.rule)
            default: run.append(b)
            }
        }
        flush()
        return out
    }

    static func paragraphStyle(_ configure: (NSMutableParagraphStyle) -> Void) -> NSParagraphStyle {
        let p = NSMutableParagraphStyle()
        p.lineSpacing = 1.5
        p.paragraphSpacing = 7
        configure(p)
        return p
    }

    /// Headings, paragraphs, lists and quotes as one attributed string.
    static func text(_ blocks: [MarkdownBlock], claims: [String: ClaimStatus], size: CGFloat, interactive: Bool) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let body = NSFont.systemFont(ofSize: size)
        func newline() { if out.length > 0 { out.append(NSAttributedString(string: "\n")) } }
        for (k, b) in blocks.enumerated() {
            switch b {
            case .heading(let level, let t):
                newline()
                let sizes: [CGFloat] = [size * 1.55, size * 1.28, size * 1.1, size, size, size]
                let font = NSFont.systemFont(ofSize: sizes[min(level, 6) - 1], weight: level <= 2 ? .bold : .semibold)
                let s = inline(t, font: font, color: .labelColor, claims: claims, interactive: interactive)
                s.addAttribute(.paragraphStyle, value: paragraphStyle {
                    $0.paragraphSpacingBefore = k == 0 ? 0 : size * (level <= 2 ? 0.9 : 0.6)
                    $0.paragraphSpacing = size * 0.35
                }, range: NSRange(location: 0, length: s.length))
                out.append(s)
            case .paragraph(let t):
                newline()
                let s = inline(t, font: body, color: .labelColor, claims: claims, interactive: interactive)
                s.addAttribute(.paragraphStyle, value: paragraphStyle { _ in }, range: NSRange(location: 0, length: s.length))
                out.append(s)
            case .quote(let t):
                newline()
                let s = inline(t, font: body, color: .secondaryLabelColor, claims: claims, interactive: interactive)
                let block = NSTextBlock()
                block.setWidth(3, type: .absoluteValueType, for: .border, edge: .minX)
                block.setBorderColor(.separatorColor, for: .minX)
                block.setWidth(10, type: .absoluteValueType, for: .padding, edge: .minX)
                s.addAttribute(.paragraphStyle, value: paragraphStyle { $0.textBlocks = [block] }, range: NSRange(location: 0, length: s.length))
                out.append(s)
            case .list(let l):
                list(l, depth: 0, into: out, body: body, claims: claims, interactive: interactive)
            case .table, .code, .rule:
                break
            }
        }
        return out
    }

    static func list(_ l: MarkdownList, depth: Int, into out: NSMutableAttributedString, body: NSFont, claims: [String: ClaimStatus], interactive: Bool) {
        let bullets = ["•", "◦", "▪︎"]
        let size = body.pointSize
        let indent = CGFloat(depth) * size * 1.5
        let marker = size * 1.5
        for (k, item) in l.items.enumerated() {
            if out.length > 0 { out.append(NSAttributedString(string: "\n")) }
            let m = l.ordered ? "\(l.start + k)." : bullets[depth % bullets.count]
            let line = NSMutableAttributedString(string: m + "\t", attributes: [
                .font: l.ordered ? NSFont.monospacedDigitSystemFont(ofSize: size, weight: .regular) : body,
                .foregroundColor: NSColor.secondaryLabelColor,
            ])
            line.append(inline(item.content, font: body, color: .labelColor, claims: claims, interactive: interactive))
            let last = k == l.items.count - 1 && item.children.isEmpty
            line.addAttribute(.paragraphStyle, value: paragraphStyle {
                $0.firstLineHeadIndent = indent
                $0.headIndent = indent + marker
                $0.tabStops = [NSTextTab(textAlignment: .left, location: indent + marker)]
                $0.paragraphSpacing = last && depth == 0 ? 7 : 2.5
            }, range: NSRange(location: 0, length: line.length))
            out.append(line)
            for child in item.children {
                list(child, depth: depth + 1, into: out, body: body, claims: claims, interactive: interactive)
            }
        }
    }

    /// Inline runs: bold, italic, code, links (http/https), claim spans with their verdict underline.
    static func inline(_ t: MarkdownInline, font: NSFont, color: NSColor, claims: [String: ClaimStatus], interactive: Bool) -> NSMutableAttributedString {
        let out = NSMutableAttributedString()
        let fm = NSFontManager.shared
        for s in t.spans {
            var f = font
            if s.code {
                f = NSFont.monospacedSystemFont(ofSize: font.pointSize * 0.92, weight: s.strong ? .semibold : .regular)
            } else {
                if s.strong { f = fm.convert(f, toHaveTrait: .boldFontMask) }
                if s.emphasis { f = fm.convert(f, toHaveTrait: .italicFontMask) }
            }
            var a: [NSAttributedString.Key: Any] = [.font: f, .foregroundColor: color]
            if s.code { a[.backgroundColor] = NSColor.quaternaryLabelColor.withAlphaComponent(0.12) }
            if let url = s.link {
                a[.link] = url
                a[.foregroundColor] = NSColor.linkColor
                a[.underlineStyle] = NSUnderlineStyle.single.rawValue
                a[.toolTip] = url.absoluteString
            }
            if let claim = s.claim {
                let known = claims[claim.id]
                let status = known ?? .unchecked
                a[claimKey] = claim.id
                if let u = B_ClaimStyle.underline(status) {
                    a[.underlineStyle] = u.rawValue
                    a[.underlineColor] = B_ClaimStyle.nsColor(status)
                }
                if known != nil, interactive, s.link == nil,
                   let url = URL(string: claimScheme + ":" + (claim.id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")) {
                    a[.link] = url
                    a[.toolTip] = "Claim, \(status.word). Click or press Return for who checked it."
                }
            }
            out.append(NSAttributedString(string: s.text, attributes: a))
        }
        return out
    }
}

// MARK: - Text views

/// A self-sizing, selectable TextKit 1 text view in SwiftUI.
struct B_RichText: NSViewRepresentable {
    var text: NSAttributedString
    var claimDetail: ((String) -> AnyView?)?

    func makeNSView(context: Context) -> B_ClaimTextView { B_ClaimTextView.make() }

    func updateNSView(_ view: B_ClaimTextView, context: Context) {
        view.claimDetail = claimDetail
        if let storage = view.textStorage, !storage.isEqual(to: text) {
            storage.setAttributedString(text)
            view.textChanged()
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: B_ClaimTextView, context: Context) -> CGSize? {
        let natural = nsView.naturalWidth()
        let w: CGFloat
        switch proposal.width {
        case let p? where p.isFinite && p > 0: w = p
        // A minimum-size question (0) or an ideal-size question (nil) gets a modest width, so a long paragraph
        // does not widen its column; a maximum-size question (infinity) gets the single-line width.
        case let p? where p == 0: w = min(natural, 120)
        case nil: w = min(natural, 300)
        default: w = natural
        }
        return CGSize(width: w, height: nsView.height(forWidth: max(w, 1)))
    }
}

/// A read-only text view whose claim spans open a popover on hover, click and keyboard focus.
final class B_ClaimTextView: NSTextView, NSTextViewDelegate {
    var claimDetail: ((String) -> AnyView?)?
    private var claimRanges: [(id: String, range: NSRange)] = []
    private var focusedClaim: Int?
    private var popover: NSPopover?
    private var popoverClaim: (id: String, range: NSRange)?
    private var pinned = false
    private var pending: DispatchWorkItem?

    static func make() -> B_ClaimTextView {
        let v = B_ClaimTextView(usingTextLayoutManager: false)
        v.isEditable = false
        v.isSelectable = true
        v.isRichText = true
        v.importsGraphics = false
        v.drawsBackground = false
        v.textContainerInset = .zero
        v.textContainer?.lineFragmentPadding = 0
        v.textContainer?.widthTracksTextView = true
        v.isVerticallyResizable = false
        v.isHorizontallyResizable = false
        v.isAutomaticLinkDetectionEnabled = false
        v.linkTextAttributes = [.cursor: NSCursor.pointingHand]
        v.delegate = v
        v.setContentHuggingPriority(.defaultLow, for: .horizontal)
        v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return v
    }

    /// Heights by width, measured with a separate text system so measuring never disturbs the visible layout.
    private var heights: [CGFloat: CGFloat] = [:]
    private var measureStorage: NSTextStorage?

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        textContainer?.size = NSSize(width: newSize.width, height: .greatestFiniteMagnitude)
    }

    func textChanged() {
        heights = [:]
        measureStorage = nil
        claimRanges = []
        guard let s = textStorage else { return }
        s.enumerateAttribute(.link, in: NSRange(location: 0, length: s.length)) { value, range, _ in
            if let url = value as? URL, url.scheme == B_AttributedMarkdown.claimScheme,
               let id = s.attribute(B_AttributedMarkdown.claimKey, at: range.location, effectiveRange: nil) as? String {
                claimRanges.append((id, range))
            }
        }
        focusedClaim = nil
        closePopover()
        invalidateIntrinsicContentSize()
    }

    func height(forWidth w: CGFloat) -> CGFloat {
        let key = (w * 2).rounded() / 2
        if let h = heights[key] { return h }
        guard let text = textStorage, text.length > 0 else { return 0 }
        let storage = measureStorage ?? {
            let s = NSTextStorage(attributedString: text)
            let lm = NSLayoutManager()
            s.addLayoutManager(lm)
            let tc = NSTextContainer(size: .zero)
            tc.lineFragmentPadding = 0
            lm.addTextContainer(tc)
            measureStorage = s
            return s
        }()
        guard let lm = storage.layoutManagers.first, let tc = lm.textContainers.first else { return 0 }
        tc.size = NSSize(width: key, height: .greatestFiniteMagnitude)
        lm.ensureLayout(for: tc)
        let h = ceil(lm.usedRect(for: tc).height) + 1
        if heights.count > 64 { heights = [:] }
        heights[key] = h
        return h
    }

    func naturalWidth() -> CGFloat {
        guard let s = textStorage, s.length > 0 else { return 0 }
        let r = s.boundingRect(with: NSSize(width: 100_000, height: 100_000), options: [.usesLineFragmentOrigin, .usesFontLeading])
        return ceil(r.width) + 2
    }

    // MARK: Hover

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for t in trackingAreas where t.owner === self && t.userInfo?["claims"] != nil { removeTrackingArea(t) }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
                                       owner: self, userInfo: ["claims": true]))
    }

    private func claim(at windowPoint: NSPoint) -> (id: String, range: NSRange, point: NSPoint)? {
        guard !claimRanges.isEmpty, let lm = layoutManager, let tc = textContainer, let s = textStorage else { return nil }
        let p = convert(windowPoint, from: nil)
        let pt = NSPoint(x: p.x - textContainerOrigin.x, y: p.y - textContainerOrigin.y)
        var fraction: CGFloat = 0
        let glyph = lm.glyphIndex(for: pt, in: tc, fractionOfDistanceThroughGlyph: &fraction)
        guard lm.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: tc).contains(pt) else { return nil }
        let char = lm.characterIndexForGlyph(at: glyph)
        guard char < s.length, let hit = claimRanges.first(where: { NSLocationInRange(char, $0.range) }) else { return nil }
        return (hit.id, hit.range, p)
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        if let hit = claim(at: event.locationInWindow) {
            if popover?.isShown == true, popoverClaim?.id == hit.id { cancelPending(); return }
            schedule(after: 0.35) { [weak self] in self?.showPopover(id: hit.id, range: hit.range, near: hit.point, pinned: false) }
        } else if !pinned {
            schedule(after: 0.3) { [weak self] in self?.closeIfMouseOutside() }
        }
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        if !pinned { schedule(after: 0.35) { [weak self] in self?.closeIfMouseOutside() } }
    }

    private func schedule(after seconds: Double, _ work: @escaping @MainActor () -> Void) {
        pending?.cancel()
        let item = DispatchWorkItem { MainActor.assumeIsolated { work() } }
        pending = item
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
    }

    private func cancelPending() {
        pending?.cancel()
        pending = nil
    }

    private func closeIfMouseOutside() {
        guard let pop = popover, pop.isShown, !pinned else { return }
        if let frame = pop.contentViewController?.view.window?.frame, frame.insetBy(dx: -6, dy: -6).contains(NSEvent.mouseLocation) {
            schedule(after: 0.4) { [weak self] in self?.closeIfMouseOutside() }
            return
        }
        closePopover()
    }

    // MARK: Click and keyboard

    func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
        guard let url = link as? URL else { return true }
        if url.scheme == B_AttributedMarkdown.claimScheme {
            if let hit = claimRanges.first(where: { NSLocationInRange(charIndex, $0.range) }) {
                showPopover(id: hit.id, range: hit.range, near: nil, pinned: true)
            }
            return true
        }
        if let safe = Markdown.safeURL(url.absoluteString) { NSWorkspace.shared.open(safe) }
        return true
    }

    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok, let e = NSApp.currentEvent, e.type == .keyDown, e.keyCode == 48, !claimRanges.isEmpty {
            focusClaim(e.modifierFlags.contains(.shift) ? claimRanges.count - 1 : 0)
        }
        return ok
    }

    override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        if ok {
            focusedClaim = nil
            if !pinned { closePopover() }
        }
        return ok
    }

    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 48: // Tab: next claim, then out of the view
            let back = event.modifierFlags.contains(.shift)
            if let next = nextClaim(back: back) {
                focusClaim(next)
            } else {
                focusedClaim = nil
                closePopover()
                if back { window?.selectPreviousKeyView(self) } else { window?.selectNextKeyView(self) }
            }
            return
        case 36, 76, 49: // Return, Enter, Space: pin the focused claim's popover
            if let f = focusedClaim, f < claimRanges.count {
                showPopover(id: claimRanges[f].id, range: claimRanges[f].range, near: nil, pinned: true)
                return
            }
        case 53: // Escape
            if popover?.isShown == true {
                closePopover()
                return
            }
        default:
            break
        }
        super.keyDown(with: event)
    }

    private func nextClaim(back: Bool) -> Int? {
        guard !claimRanges.isEmpty else { return nil }
        guard let f = focusedClaim else { return back ? claimRanges.count - 1 : 0 }
        let n = back ? f - 1 : f + 1
        return claimRanges.indices.contains(n) ? n : nil
    }

    private func focusClaim(_ k: Int) {
        focusedClaim = k
        let c = claimRanges[k]
        setSelectedRange(c.range)
        scrollRangeToVisible(c.range)
        showPopover(id: c.id, range: c.range, near: nil, pinned: false)
    }

    // MARK: Popover

    private func anchorRect(for range: NSRange, near point: NSPoint?) -> NSRect {
        guard let lm = layoutManager, let tc = textContainer else { return bounds }
        let glyphs = lm.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        var rects: [NSRect] = []
        lm.enumerateEnclosingRects(forGlyphRange: glyphs, withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0), in: tc) { r, _ in
            rects.append(r.offsetBy(dx: self.textContainerOrigin.x, dy: self.textContainerOrigin.y))
        }
        if let point, let r = rects.first(where: { $0.insetBy(dx: -2, dy: -2).contains(point) }) { return r }
        return rects.first ?? bounds
    }

    private func showPopover(id: String, range: NSRange, near point: NSPoint?, pinned pin: Bool) {
        cancelPending()
        guard window != nil, let content = claimDetail?(id) else { return }
        if let pop = popover, pop.isShown, popoverClaim?.id == id {
            if pin {
                pinned = true
                pop.behavior = .transient
            }
            return
        }
        closePopover()
        let host = NSHostingController(rootView: content.frame(width: 340))
        host.sizingOptions = .preferredContentSize
        let pop = NSPopover()
        pop.contentViewController = host
        pop.behavior = pin ? .transient : .semitransient
        pop.animates = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        pop.show(relativeTo: anchorRect(for: range, near: point), of: self, preferredEdge: .maxY)
        popover = pop
        popoverClaim = (id, range)
        pinned = pin
    }

    func closePopover() {
        cancelPending()
        popover?.performClose(nil)
        popover = nil
        popoverClaim = nil
        pinned = false
    }
}

// MARK: - Tables and code

/// A markdown table as a grid: header row, wrapping cells, hairlines; scrolls sideways only when the columns'
/// minimum widths do not fit.
struct B_MarkdownTableView: View {
    var table: MarkdownTable
    var claims: [String: ClaimStatus]
    var textSize: CGFloat
    var available: CGFloat
    var claimDetail: ((String) -> AnyView?)?

    private static let pad: CGFloat = 8

    var body: some View {
        let interactive = claimDetail != nil
        let body = NSFont.systemFont(ofSize: textSize)
        let bold = NSFont.systemFont(ofSize: textSize, weight: .semibold)
        let head = table.header.enumerated().map { j, c in cell(c, font: bold, align: table.alignments[j], interactive: interactive) }
        let rows = table.rows.map { r in r.enumerated().map { j, c in cell(c, font: body, align: table.alignments[j], interactive: interactive) } }
        let pad = Double(Self.pad * 2)
        let natural: [Double] = table.header.indices.map { j in Double(([head[j]] + rows.map { $0[j] }).map(Self.naturalWidth).max() ?? 0) + pad }
        let minimum: [Double] = table.header.indices.map { j in
            Double(min(170, max(44, ([head[j]] + rows.map { $0[j] }).map(Self.longestWord).max() ?? 0))) + pad
        }
        let layout = MarkdownTableLayout.fit(natural: natural, minimum: minimum, available: Double(max(120, available - 2)))
        let widths = layout.widths.map { CGFloat($0) }
        if layout.scrolls {
            ScrollView(.horizontal) { grid(head: head, rows: rows, widths: widths) }
                .accessibilityLabel("Table, scrolls sideways")
        } else {
            grid(head: head, rows: rows, widths: widths)
        }
    }

    private func cell(_ c: MarkdownInline, font: NSFont, align: MarkdownAlignment, interactive: Bool) -> NSAttributedString {
        let s = B_AttributedMarkdown.inline(c, font: font, color: .labelColor, claims: claims, interactive: interactive)
        let p = NSMutableParagraphStyle()
        p.alignment = align == .center ? .center : align == .trailing ? .right : .natural
        p.lineSpacing = 1
        s.addAttribute(.paragraphStyle, value: p, range: NSRange(location: 0, length: s.length))
        return s
    }

    private static func naturalWidth(_ s: NSAttributedString) -> CGFloat {
        ceil(s.boundingRect(with: NSSize(width: 100_000, height: 100_000), options: [.usesLineFragmentOrigin, .usesFontLeading]).width) + 2
    }

    private static func longestWord(_ s: NSAttributedString) -> CGFloat {
        let text = s.string as NSString
        var best: CGFloat = 0
        var location = 0
        for word in s.string.split(whereSeparator: \.isWhitespace) {
            let r = text.range(of: String(word), options: [], range: NSRange(location: location, length: text.length - location))
            guard r.location != NSNotFound else { continue }
            location = r.location + r.length
            best = max(best, naturalWidth(s.attributedSubstring(from: r)))
        }
        return best
    }

    private func grid(head: [NSAttributedString], rows: [[NSAttributedString]], widths: [CGFloat]) -> some View {
        Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                ForEach(head.indices, id: \.self) { j in
                    cellView(head[j], width: widths[j], last: j == head.count - 1)
                        .background(Color(nsColor: .quaternaryLabelColor).opacity(0.35))
                        .accessibilityAddTraits(.isHeader)
                }
            }
            ForEach(rows.indices, id: \.self) { r in
                Rectangle().fill(Color(nsColor: .separatorColor)).frame(height: 1).gridCellUnsizedAxes(.horizontal)
                GridRow {
                    ForEach(rows[r].indices, id: \.self) { j in
                        cellView(rows[r][j], width: widths[j], last: j == rows[r].count - 1)
                            .background(r % 2 == 1 ? Color.primary.opacity(0.025) : Color.clear)
                    }
                }
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: .separatorColor), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .fixedSize(horizontal: false, vertical: true)
    }

    private func cellView(_ s: NSAttributedString, width: CGFloat, last: Bool) -> some View {
        B_RichText(text: s, claimDetail: claimDetail)
            .frame(width: max(10, width - Self.pad * 2))
            .padding(.horizontal, Self.pad)
            .padding(.vertical, 5)
            .frame(maxHeight: .infinity, alignment: .topLeading)
            .overlay(alignment: .trailing) {
                if !last { Rectangle().fill(Color(nsColor: .separatorColor)).frame(width: 1) }
            }
    }
}

/// A fenced code block: monospaced, selectable, scrolls sideways for long lines.
struct B_CodeBlock: View {
    var language: String?
    var code: String
    var textSize: CGFloat

    var body: some View {
        ScrollView(.horizontal) {
            Text(verbatim: code.isEmpty ? " " : code)
                .font(.system(size: textSize - 1, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: true)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .quaternaryLabelColor).opacity(0.22)))
        .overlay(alignment: .topTrailing) {
            if let language {
                Text(language).font(.caption2).foregroundStyle(.tertiary).padding(6)
            }
        }
        .accessibilityLabel("Code" + (language.map { ", \($0)" } ?? ""))
    }
}
