import AppKit
import MASOfficeKit
import SwiftUI

/// Verdict colours and underline patterns for claims, adapted to light, dark and increased contrast. Colour is
/// never the only signal: each verdict has its own underline pattern, symbol and word.
enum B_ClaimStyle {
    /// A dynamic colour: light, dark, and the increased-contrast variants.
    static func dynamic(light: NSColor, dark: NSColor, lightHC: NSColor? = nil, darkHC: NSColor? = nil) -> NSColor {
        NSColor(name: nil) { appearance in
            switch appearance.bestMatch(from: [.aqua, .darkAqua, .accessibilityHighContrastAqua, .accessibilityHighContrastDarkAqua]) {
            case .darkAqua?: return dark
            case .accessibilityHighContrastAqua?: return lightHC ?? light
            case .accessibilityHighContrastDarkAqua?: return darkHC ?? dark
            default: return light
            }
        }
    }

    static func rgb(_ hex: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }

    static let sage = dynamic(light: rgb(0x5E8C57), dark: rgb(0x8DBF84), lightHC: rgb(0x3D6B37), darkHC: rgb(0xA8DBA0))
    static let ochre = dynamic(light: rgb(0xB8820C), dark: rgb(0xE6B23A), lightHC: rgb(0x8A5F00), darkHC: rgb(0xFFCC55))
    static let vermilion = dynamic(light: rgb(0xD9471F), dark: rgb(0xFF6D47), lightHC: rgb(0xA8300F), darkHC: rgb(0xFF8F70))
    static let grey = NSColor.secondaryLabelColor

    static func nsColor(_ s: ClaimStatus) -> NSColor {
        switch s {
        case .supported: return sage
        case .partial: return ochre
        case .contradicted: return vermilion
        case .unknown: return grey
        case .unchecked, .notCheckworthy: return .tertiaryLabelColor
        }
    }

    static func color(_ s: ClaimStatus) -> Color { Color(nsColor: nsColor(s)) }

    /// supported = solid, partial = dashed, contradicted = thick solid, unknown = dotted, unchecked = none.
    static func underline(_ s: ClaimStatus) -> NSUnderlineStyle? {
        switch s {
        case .supported: return .single
        case .partial: return [.single, .patternDash]
        case .contradicted: return .thick
        case .unknown: return [.single, .patternDot]
        case .unchecked, .notCheckworthy: return nil
        }
    }

    static func symbol(_ s: ClaimStatus) -> String {
        switch s {
        case .supported: return "checkmark.circle.fill"
        case .partial: return "circle.lefthalf.filled"
        case .contradicted: return "xmark.octagon.fill"
        case .unknown: return "questionmark.circle"
        case .unchecked, .notCheckworthy: return "circle.dashed"
        }
    }

    /// What the verdict means, for the popover and help tags.
    static func meaning(_ s: ClaimStatus) -> String {
        switch s {
        case .supported: return "A checker found the claim in its source."
        case .partial: return "Part of the claim holds; part does not."
        case .contradicted: return "A checker found the source says otherwise."
        case .unknown: return "A checker could not tell from the source."
        case .unchecked: return "No checker has looked at it yet."
        case .notCheckworthy: return "Not a factual claim to check."
        }
    }
}

/// A verdict as a word with its symbol ("supported", "contradicted"): a tinted capsule.
struct B_VerdictChip: View {
    var status: ClaimStatus
    var compact = false

    var body: some View {
        Label(status.word, systemImage: B_ClaimStyle.symbol(status))
            .labelStyle(.titleAndIcon)
            .font(compact ? .caption.weight(.medium) : .callout.weight(.medium))
            .foregroundStyle(B_ClaimStyle.color(status))
            .padding(.horizontal, compact ? 6 : 8)
            .padding(.vertical, compact ? 1 : 2)
            .background(Capsule().fill(B_ClaimStyle.color(status).opacity(0.13)))
            .fixedSize()
            .accessibilityLabel("Verdict: \(status.word)")
    }
}

/// An evidence grade A–D: an outlined square with the letter. A grade says what kind of source it is; it is not a
/// verdict, so it looks like a key, not a status.
struct B_GradeBadge: View {
    var grade: EvidenceGrade?

    var body: some View {
        Text(grade?.rawValue ?? "–")
            .font(.system(size: 10.5, weight: .bold, design: .monospaced))
            .foregroundStyle(grade == nil ? .tertiary : .secondary)
            .frame(width: 17, height: 17)
            .overlay(RoundedRectangle(cornerRadius: 3.5).strokeBorder(Color.secondary.opacity(0.55), lineWidth: 1))
            .help(grade.map { "Evidence grade \($0.rawValue): \($0.meaning)" } ?? "Not graded")
            .accessibilityLabel(grade.map { "Evidence grade \($0.rawValue), \($0.meaning)" } ?? "Not graded")
    }
}

/// Link health in words with a small symbol: "live", "dead", "stale", "blocked", "unchecked".
struct B_HealthLabel: View {
    var health: URLHealth?
    var httpStatus: Int?

    var body: some View {
        if let health {
            Label(health.word, systemImage: symbol(health))
                .labelStyle(.titleAndIcon)
                .font(.caption)
                .foregroundStyle(health == .hallucinated ? Color(nsColor: B_ClaimStyle.ochre) : .secondary)
                .help("Link checked" + (httpStatus.map { ": HTTP \($0)" } ?? ""))
                .accessibilityLabel("Link \(health.word)")
                .fixedSize()
        }
    }

    private func symbol(_ h: URLHealth) -> String {
        switch h {
        case .live: return "link"
        case .stale: return "clock.arrow.circlepath"
        case .hallucinated: return "link.badge.plus"
        case .blocked: return "hand.raised.slash"
        case .unknown: return "questionmark"
        }
    }
}

/// The proportional bar of checked claims, one segment per verdict, each with its own pattern so the bar does not
/// rely on colour (and a combined accessibility label).
struct B_CredibilityBar: View {
    var credibility: Credibility
    var height: CGFloat = 8

    var body: some View {
        GeometryReader { geo in
            HStack(spacing: 2) {
                ForEach(Array(credibility.segments.enumerated()), id: \.offset) { _, seg in
                    segment(seg.status)
                        .frame(width: max(3, (geo.size.width - CGFloat(credibility.segments.count - 1) * 2) * CGFloat(seg.count) / CGFloat(max(1, credibility.total))))
                }
            }
        }
        .frame(height: height)
        .clipShape(Capsule())
        .accessibilityElement()
        .accessibilityLabel("Checked claims: " + credibility.segments.map { "\($0.count) \($0.status.word)" }.joined(separator: ", "))
    }

    @ViewBuilder
    private func segment(_ s: ClaimStatus) -> some View {
        let c = B_ClaimStyle.color(s)
        switch s {
        case .partial:
            c.opacity(0.85).overlay(Stripes().foregroundStyle(Color.white.opacity(0.35)))
        case .unknown, .unchecked, .notCheckworthy:
            c.opacity(s == .unknown ? 0.55 : 0.3)
        default:
            c
        }
    }

    /// Diagonal hatching for "partial".
    private struct Stripes: Shape {
        func path(in rect: CGRect) -> Path {
            var p = Path()
            var x = -rect.height
            while x < rect.width {
                p.move(to: CGPoint(x: x, y: rect.maxY))
                p.addLine(to: CGPoint(x: x + rect.height, y: rect.minY))
                p.addLine(to: CGPoint(x: x + rect.height + 1.5, y: rect.minY))
                p.addLine(to: CGPoint(x: x + 1.5, y: rect.maxY))
                p.closeSubpath()
                x += 4
            }
            return p
        }
    }
}

/// A small section heading in the inspector style ("Sources 4").
struct B_SectionHeader: View {
    var title: String
    var count: Int?
    var systemImage: String?

    var body: some View {
        HStack(spacing: 6) {
            if let systemImage { Image(systemName: systemImage).foregroundStyle(.secondary) }
            Text(title).font(.headline)
            if let count { Text("\(count)").font(.subheadline.monospacedDigit()).foregroundStyle(.secondary) }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// Ticks once a second through `store.now` without making its parent re-render: put the ticking text here.
struct B_Ticking<Content: View>: View {
    @Environment(OfficeStore.self) private var store
    var content: (Date) -> Content

    var body: some View { content(store.now) }
}

/// Copies plain text to the general pasteboard.
@MainActor
enum B_Pasteboard {
    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
