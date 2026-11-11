import MASOfficeKit
import Observation
import SwiftUI

/// The agent page's segments.
enum AgentSegment: String, CaseIterable, Identifiable {
    case transcript = "Transcript"
    case outputs = "Outputs"
    case terminal = "Terminal"
    var id: String { rawValue }
}

/// UI state of the inbox and agent pages that other parts of the app (notifications, the menu bar, renders)
/// set: which segment shows, and which request card to bring into view.
@MainActor
@Observable
final class SupervisionUI {
    static let shared = SupervisionUI()

    var agentSegment: AgentSegment = .transcript
    /// A request to scroll to and focus in the inbox (a notification or menu bar item was chosen).
    var revealRequestId: String?
    /// Bumped with each reveal, so choosing the same request twice scrolls again.
    var revealCount = 0

    /// Show a request: select its agent (without leaving the inbox), switch to the inbox and bring the card
    /// into view.
    func reveal(_ requestId: String, store: OfficeStore, ui: WindowState) {
        if let agent = store.pendingItem(requestId)?.request.agentId {
            store.selectAgent(agent, origin: .inbox)
        }
        ui.show(.inbox)
        revealRequestId = requestId
        revealCount += 1
    }

    /// Show an agent's page.
    func showAgent(_ agentId: String, store: OfficeStore, ui: WindowState) {
        store.selectAgent(agentId)
        ui.show(.agent)
    }
}
