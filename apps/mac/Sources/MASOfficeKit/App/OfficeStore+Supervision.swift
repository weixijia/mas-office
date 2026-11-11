import Foundation

/// Intents and derived values the native supervision views (inbox cards, agent page, notifications, menu bar)
/// call. They sit on the store so the checks drive exactly what the views do.
extension OfficeStore {
    // MARK: Requests

    /// A pending request (needs you, or with the Lead) by id.
    public func pendingItem(_ requestId: String) -> PendingItem? {
        arrangedInbox.human.first { $0.request.requestId == requestId } ?? arrangedInbox.withLead.first { $0.request.requestId == requestId }
    }

    /// An agent's own pending requests: those that need you, then those with the Lead.
    public func pendingItems(of agentId: String) -> (human: [PendingItem], withLead: [PendingItem]) {
        (arrangedInbox.human.filter { $0.request.agentId == agentId }, arrangedInbox.withLead.filter { $0.request.agentId == agentId })
    }

    /// An answer from here is on its way or settled: the card takes no other.
    public func isAnswerLocked(_ requestId: String) -> Bool {
        Supervision.isAnswerLocked(answerReceipt(for: requestId))
    }

    /// Return on a focused card: answer with its allow-once / accept option, and nothing else. Nil when the
    /// request has no such option, an answer is already on its way, or this app may not act.
    @discardableResult
    public func answerWithReturnKey(_ request: InboxRequest) async -> String? {
        guard canAct, !isAnswerLocked(request.requestId), let primary = RequestActions(request).primary else { return nil }
        return await answer(request, option: primary)
    }

    /// The A / D keys (and the notification and menu bar buttons): only for exactly one allow-once and one
    /// reject-once option.
    @discardableResult
    public func quickAnswer(_ request: InboxRequest, allow: Bool) async -> String? {
        let a = RequestActions(request)
        guard canAct, !isAnswerLocked(request.requestId), let option = allow ? a.quickAllow : a.quickReject else { return nil }
        return await answer(request, option: option)
    }

    /// The card's text field: a reply, or for a checkpoint a send-back with a note (through its revise option
    /// when it has one). Empty text sends nothing.
    @discardableResult
    public func submitText(_ request: InboxRequest, text: String) async -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, canAct, !isAnswerLocked(request.requestId) else { return nil }
        switch RequestActions(request).reply {
        case .none: return nil
        case .reply: return await reply(request, text: t)
        case .sendBack(let revise?): return await answer(request, option: revise, text: t)
        case .sendBack(nil): return await reply(request, text: t)
        }
    }

    // MARK: Stop

    /// Ask an agent to stop its current turn. Its `stopState` reads "Stop requested" until its status really
    /// changes, then "Stopped". Returns the `cmdId`.
    @discardableResult
    public func requestStop(_ agentId: String) async -> String? {
        let cmdId = OfficeClient.newCommandId()
        stops[agentId] = StopRecord(cmdId: cmdId, key: Supervision.statusKey(status(of: agentId)), at: Date())
        guard let sent = await interrupt(agentId, cmdId: cmdId) else {
            stops[agentId] = nil
            return nil
        }
        return sent
    }

    /// Where the last Stop sent from here stands, or nil when none is open.
    public func stopState(for agentId: String) -> StopState? {
        guard let stop = stops[agentId] else { return nil }
        let st = status(of: agentId)
        return Supervision.stopState(stop, local: localCommands[stop.cmdId], command: snapshot.inbox?.command(stop.cmdId),
                                     keyNow: Supervision.statusKey(st), stopReason: st?.stopReason)
    }

    /// Clear a finished Stop's line (the views do this a few seconds after "Stopped").
    public func forgetStop(_ agentId: String) {
        if let s = stopState(for: agentId), s.phase == .requested { return }
        stops[agentId] = nil
    }

    // MARK: Notifications and the menu bar

    /// What to notify and what to take away now (rule: `AttentionPlan.make`).
    public func attentionPlan(enabled: Bool, permitted: Bool, hidden: Bool, notified: Set<String>,
                              delivered: [String: String]) -> AttentionPlan {
        guard snapshot.structure?.locked == true else {
            return AttentionPlan(post: [], remove: delivered.keys.sorted())
        }
        return AttentionPlan.make(human: arrangedInbox.human, now: now, enabled: enabled, permitted: permitted, hidden: hidden,
                                  notified: notified, delivered: delivered, nameOf: displayName)
    }

    /// "3 of 4 working · 12:04", "Run finished", …
    public var runLine: String {
        RunLine.text(structure: snapshot.structure, statuses: snapshot.statuses, state: snapshot.state, board: snapshot.board, now: now)
    }

    /// Usage the backend reported for one agent.
    public func usage(of agentId: String) -> UsageSummary? {
        snapshot.board?.usage[agentId].map(UsageSummary.init)
    }

    /// The three layers of the agent page.
    public func strip(for agentId: String) -> AgentStrip {
        AgentStrip(agentId: agentId, structure: snapshot.structure, status: status(of: agentId), board: snapshot.board,
                   result: snapshot.result, verification: snapshot.verification, entries: transcripts[agentId]?.entries ?? [],
                   nameOf: displayName)
    }
}
