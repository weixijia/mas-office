import AppKit
import SwiftUI

/// A one-line text field where Return and ⌘↩ both send (`onSubmit`). AppKit-backed so ⌘↩ belongs to the
/// focused field only: several cards and the composer can be on screen without one shortcut answering for
/// another.
struct ReplyField: NSViewRepresentable {
    @Binding var text: String
    var placeholder: String
    var isEnabled = true
    var accessibilityLabel: String
    var onSubmit: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> SubmitTextField {
        let f = SubmitTextField()
        f.isBezeled = true
        f.bezelStyle = .roundedBezel
        f.usesSingleLineMode = true
        f.cell?.isScrollable = true
        f.cell?.wraps = false
        f.lineBreakMode = .byClipping
        f.font = .systemFont(ofSize: NSFont.systemFontSize)
        f.delegate = context.coordinator
        f.setContentHuggingPriority(.defaultLow, for: .horizontal)
        f.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return f
    }

    func updateNSView(_ f: SubmitTextField, context: Context) {
        context.coordinator.parent = self
        if f.stringValue != text { f.stringValue = text }
        if f.placeholderString != placeholder { f.placeholderString = placeholder }
        if f.isEnabled != isEnabled { f.isEnabled = isEnabled }
        f.setAccessibilityLabel(accessibilityLabel)
        f.onCommandReturn = { context.coordinator.parent.onSubmit() }
    }

    @MainActor
    final class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: ReplyField
        init(_ parent: ReplyField) { self.parent = parent }

        func controlTextDidChange(_ note: Notification) {
            guard let f = note.object as? NSTextField else { return }
            parent.text = f.stringValue
        }

        func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            if selector == #selector(NSResponder.insertNewline(_:)) {
                parent.text = control.stringValue
                parent.onSubmit()
                return true
            }
            return false
        }
    }
}

/// An `NSTextField` that takes ⌘↩ while it is being edited.
final class SubmitTextField: NSTextField {
    var onCommandReturn: (() -> Void)?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if currentEditor() != nil, event.isCommandReturn {
            onCommandReturn?()
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

/// The multi-line message field: Return makes a new line, ⌘↩ sends, Tab moves on. Grows from two to six
/// lines.
struct ComposerField: NSViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    @Binding var isFocused: Bool
    var placeholder: String
    var isEnabled = true
    var accessibilityLabel: String
    var onSubmit: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        let tv = ComposerTextView()
        tv.isRichText = false
        tv.importsGraphics = false
        tv.allowsUndo = true
        tv.isAutomaticQuoteSubstitutionEnabled = false
        tv.isAutomaticDashSubstitutionEnabled = false
        tv.isAutomaticLinkDetectionEnabled = false
        tv.font = .systemFont(ofSize: NSFont.systemFontSize)
        tv.textColor = .labelColor
        tv.drawsBackground = false
        tv.textContainerInset = NSSize(width: 4, height: 6)
        tv.isVerticallyResizable = true
        tv.isHorizontallyResizable = false
        tv.autoresizingMask = [.width]
        tv.textContainer?.widthTracksTextView = true
        tv.delegate = context.coordinator
        scroll.documentView = tv
        context.coordinator.textView = tv
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let tv = scroll.documentView as? ComposerTextView else { return }
        if tv.string != text {
            tv.string = text
            context.coordinator.measure()
        }
        tv.placeholder = placeholder
        tv.isEditable = isEnabled
        tv.isSelectable = isEnabled
        tv.setAccessibilityLabel(accessibilityLabel)
        tv.onCommandReturn = { context.coordinator.parent.onSubmit() }
        tv.onFocusChange = { focused in
            DispatchQueue.main.async { context.coordinator.parent.isFocused = focused }
        }
        tv.needsDisplay = true
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerField
        weak var textView: ComposerTextView?
        init(_ parent: ComposerField) { self.parent = parent }

        func textDidChange(_ note: Notification) {
            guard let tv = note.object as? NSTextView else { return }
            parent.text = tv.string
            measure()
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            if selector == #selector(NSResponder.insertTab(_:)) {
                textView.window?.selectNextKeyView(nil)
                return true
            }
            if selector == #selector(NSResponder.insertBacktab(_:)) {
                textView.window?.selectPreviousKeyView(nil)
                return true
            }
            return false
        }

        /// Two to six lines, following the text.
        func measure() {
            guard let tv = textView, let lm = tv.layoutManager, let tc = tv.textContainer else { return }
            lm.ensureLayout(for: tc)
            let line = (tv.font.map { lm.defaultLineHeight(for: $0) } ?? 16)
            let used = lm.usedRect(for: tc).height
            let h = min(max(used, line * 2), line * 6) + tv.textContainerInset.height * 2
            if abs(h - parent.height) > 0.5 {
                DispatchQueue.main.async { self.parent.height = h }
            }
        }
    }
}

/// The composer's text view: ⌘↩ sends; draws its placeholder while empty.
final class ComposerTextView: NSTextView {
    var onCommandReturn: (() -> Void)?
    var onFocusChange: ((Bool) -> Void)?
    var placeholder = "" {
        didSet { if placeholder != oldValue { needsDisplay = true } }
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if window?.firstResponder === self, event.isCommandReturn {
            onCommandReturn?()
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    override func keyDown(with event: NSEvent) {
        if event.isCommandReturn {
            onCommandReturn?()
            return
        }
        super.keyDown(with: event)
    }

    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { onFocusChange?(true) }
        return ok
    }

    override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        if ok { onFocusChange?(false) }
        return ok
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty, !placeholder.isEmpty else { return }
        let attrs: [NSAttributedString.Key: Any] = [.font: font ?? .systemFont(ofSize: NSFont.systemFontSize), .foregroundColor: NSColor.placeholderTextColor]
        let x = textContainerInset.width + (textContainer?.lineFragmentPadding ?? 5)
        NSString(string: placeholder).draw(at: NSPoint(x: x, y: textContainerInset.height), withAttributes: attrs)
    }
}

extension NSEvent {
    /// ⌘↩ or ⌘⌤ (no other modifier but Shift-free Command).
    var isCommandReturn: Bool {
        guard type == .keyDown, keyCode == 36 || keyCode == 76 else { return false }
        return modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function]) == .command
    }
}
