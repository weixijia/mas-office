import MASOfficeKit
import SwiftUI

/// "Notify me": system notifications when someone has waited 30 s while MAS Office is in the background.
/// Turning it on asks for permission (only from this control). Not shown when notifications cannot work here
/// (the binary run without its app bundle). Settings can host it too.
struct NotifyMeToggle: View {
    /// `.compact` for the inbox header (a checkbox and nothing else), `.full` for Settings (with the note).
    enum Style { case compact, full }
    var style: Style = .compact
    private var notifier: AttentionNotifier { .shared }

    var body: some View {
        if notifier.isAvailable {
            VStack(alignment: .leading, spacing: 4) {
                Toggle(isOn: Binding(get: { notifier.enabled && notifier.permitted }, set: { on in Task { await notifier.setEnabled(on) } })) {
                    Text("Notify me")
                }
                .toggleStyle(.checkbox)
                .help("Get a notification when someone has waited 30 seconds for you while MAS Office is in the background.")
                if style == .full {
                    Text("A notification when someone has waited 30 seconds for you while MAS Office is in the background. Simple approvals can be answered from it.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if style == .full, let note = notifier.note {
                    Text(verbatim: note)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .task { await notifier.refreshAuthorization() }
        }
    }
}
