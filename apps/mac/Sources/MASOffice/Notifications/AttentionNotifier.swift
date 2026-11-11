import AppKit
import MASOfficeKit
import Observation
import UserNotifications

/// System notifications for agents that wait on you (negotiated interruption): only for a blocking request
/// that has waited at least 30 s while the app is not frontmost, once per wait episode, one notification per
/// agent (a newer one replaces it), taken away when the request is answered elsewhere. A simple allow / deny
/// approval can be answered from the notification; anything else opens the app on that request. Also keeps
/// the Dock badge.
///
/// `UNUserNotificationCenter` needs a bundled app: run unbundled (`swift run`) this does nothing and the
/// "Notify me" control is not shown. Permission is asked only when the person turns notifications on.
@MainActor
@Observable
final class AttentionNotifier: NSObject {
    static let shared = AttentionNotifier()
    static let enabledKey = "notifyWhenWaiting"

    private static let approvalCategory = "mas-office.approval"
    private static let requestCategory = "mas-office.request"
    private static let allowAction = "allow-once"
    private static let denyAction = "deny"

    /// Notifications can work here (a bundled app with an identifier).
    let isAvailable: Bool
    /// The person turned notifications on (remembered).
    private(set) var enabled: Bool
    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    /// A sentence when notifications cannot be shown although they are on (blocked in System Settings).
    private(set) var note: String?

    @ObservationIgnored private var notified: Set<String> = []
    /// agent id → the request id its delivered notification is about.
    @ObservationIgnored private var delivered: [String: String] = [:]
    @ObservationIgnored private var store: OfficeStore?
    @ObservationIgnored private var activated = false
    /// Opens the main window (captured from SwiftUI's `openWindow` by the menu bar label).
    @ObservationIgnored var openMainWindow: (() -> Void)?

    private override init() {
        let bundle = Bundle.main
        isAvailable = bundle.bundleIdentifier != nil && bundle.bundleURL.pathExtension == "app"
        enabled = UserDefaults.standard.bool(forKey: Self.enabledKey)
        super.init()
    }

    var permitted: Bool {
        authorization == .authorized || authorization == .provisional
    }

    /// Become the notification delegate (call before launch finishes so a click that launched the app is
    /// delivered) and read the current permission. Asks nothing.
    func activate(store: OfficeStore) {
        self.store = store
        guard isAvailable, !activated else { return }
        activated = true
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let allow = UNNotificationAction(identifier: Self.allowAction, title: "Allow once", options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: Self.denyAction, title: "Deny", options: [.destructive])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.approvalCategory, actions: [allow, deny], intentIdentifiers: []),
            UNNotificationCategory(identifier: Self.requestCategory, actions: [], intentIdentifiers: []),
        ])
        Task { await refreshAuthorization() }
    }

    func refreshAuthorization() async {
        guard isAvailable else { return }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorization = settings.authorizationStatus
        note = enabled && !permitted && authorization == .denied
            ? "Notifications are turned off for MAS Office in System Settings › Notifications." : nil
    }

    /// Turn notifications on or off. Turning them on asks for permission the first time (from this user action
    /// only).
    func setEnabled(_ on: Bool) async {
        guard isAvailable else { return }
        if on, authorization == .notDetermined {
            let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            await refreshAuthorization()
            if !granted {
                enabled = false
                UserDefaults.standard.set(false, forKey: Self.enabledKey)
                note = "MAS Office was not allowed to send notifications. You can allow it in System Settings › Notifications."
                return
            }
        }
        enabled = on
        UserDefaults.standard.set(on, forKey: Self.enabledKey)
        await refreshAuthorization()
        if !on { removeAll() }
    }

    /// Once a second: the Dock badge, then what to notify and what to take away.
    func tick() {
        guard let store else { return }
        let n = store.needsYouCount
        let label = n > 0 ? String(n) : nil
        if NSApp.dockTile.badgeLabel != label { NSApp.dockTile.badgeLabel = label }

        guard isAvailable, activated else { return }
        let plan = store.attentionPlan(enabled: enabled, permitted: permitted, hidden: !NSApp.isActive,
                                       notified: notified, delivered: delivered)
        if !plan.remove.isEmpty {
            let ids = plan.remove.map(Self.identifier)
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
            plan.remove.forEach { delivered[$0] = nil }
        }
        for notice in plan.post {
            notified.insert(notice.episode)
            post(notice, project: store.currentProject)
        }
    }

    /// What the self-check reports (no content, no identifiers).
    var selfCheckInfo: [String: Any] {
        ["available": isAvailable, "enabled": enabled, "permitted": permitted, "delivered": delivered.count, "episodesNotified": notified.count]
    }

    private static func identifier(_ agentId: String) -> String { "mas-office.wait." + agentId }

    private func post(_ n: AttentionNotice, project: String?) {
        let content = UNMutableNotificationContent()
        content.title = n.title
        content.subtitle = n.subtitle
        content.body = n.body
        content.threadIdentifier = "agent." + n.agentId
        content.sound = n.sound ? .default : nil
        var info: [String: String] = ["requestId": n.requestId, "agentId": n.agentId]
        if let project { info["project"] = project }
        if let a = n.allowOptionId, let r = n.rejectOptionId {
            content.categoryIdentifier = Self.approvalCategory
            info["allow"] = a
            info["deny"] = r
        } else {
            content.categoryIdentifier = Self.requestCategory
        }
        content.userInfo = info
        let request = UNNotificationRequest(identifier: Self.identifier(n.agentId), content: content, trigger: nil)
        delivered[n.agentId] = n.requestId
        UNUserNotificationCenter.current().add(request) { _ in }
    }

    private func removeAll() {
        guard isAvailable else { return }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: delivered.keys.map(Self.identifier))
        delivered = [:]
    }

    /// A notification (or one of its buttons) was chosen.
    fileprivate func handle(action: String, info: [String: String]) async {
        guard let store, let requestId = info["requestId"] else { return }
        let sameProject = info["project"] == nil || info["project"] == store.currentProject
        switch action {
        case Self.allowAction, Self.denyAction:
            // Answer only if it still waits, in the same project, and the options are still the ones offered.
            guard sameProject, let item = store.pendingItem(requestId) else { return }
            let actions = RequestActions(item.request)
            let wanted = action == Self.allowAction ? info["allow"] : info["deny"]
            let option = action == Self.allowAction ? actions.quickAllow : actions.quickReject
            guard let option, option.optionId == wanted else { return }
            await store.answer(item.request, option: option)
        default:
            NSApp.activate(ignoringOtherApps: true)
            if let open = openMainWindow {
                open()
            } else {
                NSApp.windows.first { $0.identifier?.rawValue.hasPrefix("main") == true }?.makeKeyAndOrderFront(nil)
            }
            if sameProject {
                SupervisionUI.shared.reveal(requestId, store: store, ui: Shared.ui)
            } else {
                Shared.ui.show(.inbox)
            }
        }
    }
}

extension AttentionNotifier: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let action = response.actionIdentifier
        let raw = response.notification.request.content.userInfo
        var info: [String: String] = [:]
        for (k, v) in raw { if let k = k as? String, let v = v as? String { info[k] = v } }
        let sendable = info
        await handle(action: action, info: sendable)
    }

    /// While the app is frontmost nothing is shown: the inbox already is.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        []
    }
}
