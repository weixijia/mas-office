import AppKit
import MASOfficeKit
import SwiftUI

/// Text-safe tones for the supervision views, adapted to light, dark and increased contrast. Vermilion is kept
/// for what needs you; questions read cobalt, flags ochre, finished things sage.
enum Tone {
    /// Needs you: vermilion ink on light, a lighter vermilion on dark.
    static let needsYou = adaptive(light: 0xB5_3A1C, dark: 0xFF_8A66, lightHC: 0x8E_2A10, darkHC: 0xFF_A88C)
    static let question = adaptive(light: 0x2B_57B5, dark: 0x8F_B0FF, lightHC: 0x1C_3F8C, darkHC: 0xB4_CBFF)
    static let warning = adaptive(light: 0x8A_5F00, dark: 0xF0_B840, lightHC: 0x6B_4900, darkHC: 0xFF_D06A)
    static let good = adaptive(light: 0x3F_6E39, dark: 0x8F_C987, lightHC: 0x2C_5227, darkHC: 0xB0_E0A8)
    static let bad = adaptive(light: 0xB0_2A1A, dark: 0xFF_7B6B, lightHC: 0x8A_1C10, darkHC: 0xFF_A396)

    /// The tone of a request kind.
    static func color(_ kind: RequestKind) -> Color {
        switch kind {
        case .question: return question
        case .flag: return warning
        default: return needsYou
        }
    }

    private static func adaptive(light: Int, dark: Int, lightHC: Int, darkHC: Int) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let match = appearance.bestMatch(from: [.aqua, .darkAqua, .accessibilityHighContrastAqua, .accessibilityHighContrastDarkAqua])
            switch match {
            case .darkAqua?: return rgb(dark)
            case .accessibilityHighContrastAqua?: return rgb(lightHC)
            case .accessibilityHighContrastDarkAqua?: return rgb(darkHC)
            default: return rgb(light)
            }
        })
    }

    private static func rgb(_ v: Int) -> NSColor {
        NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }
}

/// A small labelled badge: "APPROVAL", "URGENT", "A".
struct TagBadge: View {
    var text: String
    var color: Color
    var filled = false

    var body: some View {
        Text(verbatim: text)
            .font(.caption2.weight(.semibold))
            .tracking(0.4)
            .foregroundStyle(filled ? Color.white : color)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(filled ? AnyShapeStyle(color) : AnyShapeStyle(color.opacity(0.13))))
            .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).strokeBorder(color.opacity(filled ? 0 : 0.35), lineWidth: 0.5))
            .fixedSize()
    }
}

/// The kind of a request as a labelled badge.
struct KindBadge: View {
    var kind: RequestKind
    var dimmed = false

    var body: some View {
        TagBadge(text: kind.label.uppercased(), color: dimmed ? .secondary : Tone.color(kind))
            .accessibilityLabel(kind.label)
    }
}

/// A section heading in the inspector: small, secondary, with an optional count.
struct InspectorHeading: View {
    var title: String
    var count: Int?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            if let count {
                Text("\(count)")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// The card surface the supervision views share.
struct CardBackground: ViewModifier {
    var focused = false
    var accent: Color?

    func body(content: Content) -> some View {
        content
            .background {
                ZStack(alignment: .leading) {
                    Color(nsColor: .controlBackgroundColor)
                    if let accent {
                        accent.frame(width: 3).accessibilityHidden(true)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5))
            .overlay {
                if focused {
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .strokeBorder(Color(nsColor: .keyboardFocusIndicatorColor), lineWidth: 3)
                        .padding(-1.5)
                        .accessibilityHidden(true)
                }
            }
    }
}

extension View {
    func cardStyle(focused: Bool = false, accent: Color? = nil) -> some View { modifier(CardBackground(focused: focused, accent: accent)) }
}

/// Opens only http(s) links, in the default browser; everything else is dropped. Text from transcripts and
/// work files is untrusted.
struct SafeLinks: ViewModifier {
    func body(content: Content) -> some View {
        content.environment(\.openURL, OpenURLAction { url in
            guard let s = url.scheme?.lowercased(), s == "http" || s == "https" else { return .discarded }
            NSWorkspace.shared.open(url)
            return .handled
        })
    }
}

extension View {
    func safeLinks() -> some View { modifier(SafeLinks()) }
}

/// "09:26:00" for a transcript or request timestamp, in local time.
@MainActor
enum Clock {
    private static let time: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()
    private static let short: DateFormatter = {
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = .none
        return f
    }()

    static func time(_ iso: String?) -> String {
        guard let iso, let d = Supervision.parseISODate(iso) else { return "" }
        return time.string(from: d)
    }

    static func short(_ d: Date) -> String { short.string(from: d) }
}
