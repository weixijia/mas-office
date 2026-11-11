import Foundation
import MASOfficeKit

// Checks for the native supervision views' rules (MASOfficeKit/Logic/Attention.swift and
// App/OfficeStore+Supervision.swift): what a card offers, Stop, notification admission, usage and the run line,
// against the panel's JS where the panel has the same rule; and `--supervision`, which drives the same store
// intents the inbox and agent page call against a scripted daemon (or the fixture with `--fixture`).

@MainActor
func supervisionChecks() async {
    Harness.section("Supervision views: request actions, Stop, notifications (parity with the panel where it has the rule)")
    let fixture = Harness.repo.appendingPathComponent("panel/tests/fixtures/mock-supervise/deals")
    func doc(_ rel: String, _ g: String) -> JSONValue { Harness.twin(fixture.appendingPathComponent(rel)).globals[g] ?? .null }
    let s = Structure(json: doc("mas/structure.js", "MAS_STRUCTURE"))
    let inbox = Inbox(json: doc("mas/inbox.js", "MAS_INBOX"))
    func req(_ id: String) -> InboxRequest? { inbox.pending.first { $0.requestId == id } }

    // What each card offers.
    if let r = req("req_browse") {
        let a = RequestActions(r)
        Harness.equal(a.primary?.optionId, "allow-once", "approval: Return answers Allow once")
        Harness.equal(a.buttons.map(\.option.optionId), ["allow-once", "deny"], "approval: buttons in order")
        Harness.check(a.hasQuickPair && a.quickReject?.optionId == "deny", "approval: A / D pair")
        Harness.equal(a.reply, .reply, "approval: reply field")
    }
    if let r = req("req_cmd") {
        let a = RequestActions(r)
        Harness.equal(a.primary?.optionId, "once", "standing-rule option is never the Return option")
        Harness.check(!a.hasQuickPair, "allow once + always + decline: no A / D pair")
        Harness.equal(a.buttons.first { $0.always }?.option.optionId, "always", "the standing rule is a button, marked always")
    }
    if let r = req("req_q") {
        let a = RequestActions(r)
        Harness.check(a.primary == nil, "a question's choices: Return answers nothing")
        Harness.equal(a.replyButton, "Send", "question: Send")
    }
    if let r = req("req_gate") {
        let a = RequestActions(r)
        Harness.equal(a.buttons.map(\.option.optionId), ["accept", "stop"], "checkpoint: Accept and Stop are buttons")
        Harness.equal(a.primary?.optionId, "accept", "checkpoint: Return accepts")
        Harness.equal(a.reply, .sendBack(RequestOption(optionId: "revise", name: "Revise", kind: "choice")), "checkpoint: send back through Revise")
        Harness.equal(a.replyButton, "Send back", "checkpoint: Send back")
        Harness.equal(r.kindInfo.label, "Checkpoint", "a gate reads Checkpoint")
    }
    if let hook = InboxRequest(json: .object(["requestId": "hook_1", "kind": "approval", "title": "Run ls?", "options": .array([]),
                                               "source": .object(["backend": "claude-code", "raw": "hook:PermissionRequest"])])) {
        let a = RequestActions(hook)
        Harness.check(hook.answeredInTerminalOnly && a.terminalOnly && a.buttons.isEmpty && a.reply == .none && a.primary == nil,
                      "a terminal hook prompt without options: no buttons, no field")
    }
    if let noOptions = InboxRequest(json: .object(["requestId": "q", "kind": "question", "title": "Which?", "options": .array([])])) {
        Harness.check(!noOptions.answeredInTerminalOnly && RequestActions(noOptions).reply == .reply, "a question without options takes a reply")
    }

    func receipt(_ s: ReceiptState) -> Receipt { Supervision.receipt(local: LocalCommand(state: s, type: "command.respond", agentId: "a", at: Date()), command: nil) }
    Harness.equal([nil, receipt(.sending), receipt(.sent), receipt(.applied), receipt(.conflict), receipt(.failed), receipt(.rejected)].map(Supervision.isAnswerLocked),
                  [false, true, true, true, true, false, false], "answer locked while on its way or settled; unlocked after a failure")

    // Parity: Stop, notification admission, status keys, usage, ledger line, run clock.
    guard let node = Harness.node else {
        Harness.check(false, "node is needed to compute the JS expectations")
        return
    }
    let statuses: [JSONValue] = [
        .object(["state": "working", "say": "Reading"]),
        .object(["state": "flagged", "say": "x", "flag": "Needs approval", "flagKind": "needs_approval"]),
        .object(["state": "idle", "stopReason": "cancelled"]),
        .object(["state": "handoff", "to": "lead"]),
    ]
    struct StopCase { var local: ReceiptState; var error: String?; var key: String; var cmd: String?; var keyNow: String; var stopReason: String? }
    let stopCases: [StopCase] = [
        StopCase(local: .sending, key: "k", cmd: nil, keyNow: "k"),
        StopCase(local: .sent, key: "k", cmd: "accepted", keyNow: "k"),
        StopCase(local: .sent, key: "k", cmd: "applied", keyNow: "k2"),
        StopCase(local: .sent, key: "k", cmd: "applied", keyNow: "k", stopReason: "cancelled"),
        StopCase(local: .failed, error: "offline", key: "k", cmd: nil, keyNow: "k"),
        StopCase(local: .sent, key: "k", cmd: "rejected", keyNow: "k2"),
        StopCase(local: .sent, key: "k", cmd: "unsupported", keyNow: "k"),
    ]
    struct NotifyCase { var enabled = true, permitted = true, hidden = true, blocking = true, routeTo = "human"; var waited: Double? = 31; var notified = false }
    let notifyCases: [NotifyCase] = [
        NotifyCase(), NotifyCase(enabled: false), NotifyCase(permitted: false), NotifyCase(hidden: false), NotifyCase(blocking: false),
        NotifyCase(routeTo: "lead"), NotifyCase(waited: 29.999), NotifyCase(waited: 30), NotifyCase(waited: nil), NotifyCase(notified: true),
    ]
    let usages: [JSONValue] = [
        .object(["inputTokens": 12_400, "outputTokens": 3_100, "costUsd": 0.42, "turns": 6]),
        .object(["inputTokens": 999, "outputTokens": 0, "turns": 1]),
        .object(["inputTokens": 12_345_678, "outputTokens": 1_250_000, "costUsd": 12.5, "limit": .object(["status": "allowed_warning", "resetsAt": "18:00"])]),
        .object(["inputTokens": 0, "outputTokens": 0, "limit": .object(["status": "allowed"])]),
        .object(["inputTokens": 9_950, "outputTokens": 99_950, "costUsd": 0.005]),
        .object(["inputTokens": 1_250, "outputTokens": 2_350_000, "costUsd": 1.125, "turns": 2]),
    ]
    let ledgers: [JSONValue] = [
        .object(["satisfied": true]), .object(["progressing": true, "next": "checker", "stalls": 2]), .object(["progressing": false, "stalls": 1]),
        .object(["looping": true, "next": "lead"]), .object([:]),
    ]
    let clocks: [Double] = [0, 7_000, 84_000, 723_000, 3_723_000, -5]
    let cases: JSONValue = .object([
        "fixture": .string(fixture.path), "now": .number(1_794_303_600_000),
        "stops": .array(stopCases.map { c in
            .object(["stop": .object(["state": .string(c.local.rawValue), "error": c.error.map(JSONValue.string) ?? .null, "key": .string(c.key)]),
                     "cmd": c.cmd.map { .object(["cmdId": "c", "status": .string($0)]) } ?? .null,
                     "keyNow": .string(c.keyNow), "stopReason": c.stopReason.map(JSONValue.string) ?? .null])
        }),
        "notify": .array(notifyCases.map { c in
            .object(["enabled": .bool(c.enabled), "permission": .string(c.permitted ? "granted" : "default"), "hidden": .bool(c.hidden),
                     "blocking": .bool(c.blocking), "routeTo": .string(c.routeTo), "waitedMs": c.waited.map { .number($0 * 1000) } ?? .null,
                     "notified": .bool(c.notified)])
        }),
        "statusKeys": .array(statuses), "usage": .array(usages), "ledgers": .array(ledgers), "clocks": .array(clocks.map(JSONValue.number)),
    ])
    let file = Harness.scratch("supervision").appendingPathComponent("cases.json")
    try? Data(cases.jsonText().utf8).write(to: file)
    let out = await ProcessRunner.run(node, arguments: [Harness.repo.appendingPathComponent("apps/mac/scripts/js-expected.cjs").path, file.path],
                                      timeout: .seconds(60))
    guard out.status == 0, let js = try? JSONValue.parse(out.stdout) else {
        Harness.check(false, "js-expected.cjs ran (status \(String(describing: out.status)))")
        return
    }
    for (i, c) in stopCases.enumerated() {
        let st = Supervision.stopState(StopRecord(cmdId: "c", key: c.key, at: Date()),
                                       local: LocalCommand(state: c.local, error: c.error, type: "command.interrupt", agentId: "a", at: Date()),
                                       command: c.cmd.flatMap { CommandRecord(json: .object(["cmdId": "c", "status": .string($0)])) },
                                       keyNow: c.keyNow, stopReason: c.stopReason)
        let j = js["stops"]?.array?[safe: i]
        Harness.equal("\(st?.phase.rawValue ?? "nil")|\(st?.text ?? "")", "\(j?.string("state") ?? "nil")|\(j?.string("text") ?? "")", "stopState case \(i)")
    }
    for (i, c) in notifyCases.enumerated() {
        let mine = Supervision.shouldNotify(enabled: c.enabled, permitted: c.permitted, hidden: c.hidden, blocking: c.blocking, routeTo: c.routeTo,
                                            waited: c.waited, alreadyNotified: c.notified)
        Harness.equal(mine, js["notify"]?.array?[safe: i]?.bool ?? !mine, "shouldNotify case \(i)")
    }
    Harness.equal(statuses.map { Supervision.statusKey(AgentStatus(json: $0)) }, (js["statusKeys"]?.array ?? []).map { $0.string ?? "" }, "statusKey (+ stopReason)")
    for (i, u) in usages.enumerated() {
        let mine = UsageSummary(json: u)
        let j = js["usage"]?.array?[safe: i]
        Harness.equal("\(mine.text)|\(mine.warning ?? "")|\(mine.tokens)|\(mine.cost)",
                      "\(j?.string("text") ?? "")|\(j?.string("warn") ?? "")|\(j?.double("tokens") ?? -1)|\(j?.double("cost") ?? -1)", "usageInfo case \(i)")
    }
    Harness.equal(ledgers.map { l in AgentStrip.ledgerLine(Board(json: .object(["ledger": l])).ledger, nameOf: { "N:" + $0 }) },
                  (js["ledgers"]?.array ?? []).map { $0.string ?? "" }, "ledgerLine")
    Harness.equal(clocks.map { RunLine.clock($0 / 1000) }, (js["clocks"]?.array ?? []).map { $0.string ?? "" }, "formatClock")

    // Notification plan: one per wait episode, after 30 s, while hidden; removal when resolved elsewhere.
    let now = date(ms: 1_794_303_600_000)
    let statusMap = Dictionary(uniqueKeysWithValues: s.memberIds.compactMap { id in
        Harness.twin(fixture.appendingPathComponent("mas/status/\(id).js")).statuses[id].map { (id, AgentStatus(json: $0)) }
    })
    let ar = Supervision.arrange(inbox, structure: s, statuses: statusMap, firstSeen: [:], now: now)
    func plan(hidden: Bool = true, notified: Set<String> = [], delivered: [String: String] = [:], at t: Date = now) -> AttentionPlan {
        AttentionPlan.make(human: ar.human, now: t, enabled: true, permitted: true, hidden: hidden, notified: notified, delivered: delivered, nameOf: s.name(of:))
    }
    let first = plan()
    Harness.equal(first.post.map(\.agentId), Supervision.waitingAgents(ar.human).map(\.id), "one notification per waiting agent, in waiting order")
    Harness.check(plan(hidden: false).post.isEmpty, "nothing while the app is frontmost")
    Harness.check(plan(notified: Set(first.post.map(\.episode))).post.isEmpty, "once per wait episode")
    if let rf = first.post.first(where: { $0.agentId == "retail-finder" }) {
        Harness.equal(rf.title, "Retail finder needs you", "notification title")
        Harness.check(rf.allowOptionId != nil && rf.rejectOptionId != nil, "a simple allow / deny approval gets Allow once / Deny buttons")
        Harness.equal(rf.body, "Open currys.co.uk in the browser?", "body: the request's title (its other request is with the Lead)")
    }
    if let mf = first.post.first(where: { $0.agentId == "marketplace-finder" }) {
        Harness.check(mf.allowOptionId == nil, "anything else: no buttons (opens the app)")
    }
    let soon = Supervision.waitingAgents(ar.human).first?.since.map { $0.addingTimeInterval(29) } ?? now
    Harness.check(!plan(at: soon).post.contains { $0.agentId == Supervision.waitingAgents(ar.human).first?.id }, "not before 30 s")
    Harness.equal(plan(delivered: ["retail-finder": "req_gone", "lead": "req_gate", "nobody": "x"]).remove, ["nobody", "retail-finder"],
                  "take away notifications whose request was resolved or whose agent no longer waits")

    // The store keeps the arranged inbox; the 1 s clock does not change it.
    let snap = ProjectSnapshot(project: "deals", structure: s, statuses: statusMap, inbox: inbox)
    let store = OfficeStore.preview(snapshot: snap, now: now)
    Harness.equal(store.arrangedInbox.human.map(\.id), Supervision.arrange(inbox, structure: s, statuses: statusMap, firstSeen: store.firstSeen, now: now).human.map(\.id),
                  "store.arrangedInbox is the arranged inbox")
    Harness.equal(store.pendingItems(of: "retail-finder").human.count, 1, "an agent's own requests (needs you)")
    Harness.equal(store.pendingItems(of: "retail-finder").withLead.count, 1, "an agent's own requests (with the Lead)")
    Harness.check(store.stopState(for: "retail-finder") == nil, "no Stop open")
    Harness.check(store.runLine.hasSuffix("working") || store.runLine.contains(" working · "), "run line: \(store.runLine)")
    Harness.check(RunLine.text(structure: nil, statuses: [:], state: nil, board: nil, now: now) == "No team yet", "run line without a team")
}

/// `--supervision [--fixture]`: the inbox and agent page intents against a running daemon.
@MainActor
func supervisionIntegration(fixture: Bool) async {
    Harness.section("Supervision intents against the \(fixture ? "fixture daemon (no runtime)" : "scripted daemon")")
    guard let opts = LaunchOptions.parse(arguments: [], environment: ProcessInfo.processInfo.environment).attach else {
        Harness.check(false, "MAS_OFFICE_ATTACH_URL and MAS_OFFICE_ATTACH_TOKEN are set (loopback)")
        return
    }
    let store = OfficeStore()
    store.connect(to: opts)
    guard await until("connected with a locked team", 20, { store.connection.isUsable && store.structure?.locked == true && store.canAct }) else { return }

    if fixture {
        await fixturePart(store, opts)
    } else {
        await scriptedPart(store)
    }
    store.disconnect()
}

@MainActor
private func fixturePart(_ store: OfficeStore, _ opts: DaemonInfo) async {
    // The fixture's requests exist only as written snapshots, not in the engine's log, so the engine would
    // say they no longer wait. Open a question, a checkpoint and an approval through the log first (allowed
    // with the token while no runtime is attached).
    func opened(_ id: String, _ agent: String, _ kind: String, _ title: String, options: JSONValue, subject: JSONValue = .null) -> JSONValue {
        .object(["type": "request.opened", "agentId": .string(agent),
                 "data": .object(["requestId": .string(id), "kind": .string(kind), "title": .string(title), "options": options, "subject": subject])])
    }
    let events: JSONValue = .array([
        opened("chk_q", "marketplace-finder", "question", "Include refurbished units?",
               options: .array([.object(["optionId": "yes", "name": "Yes", "kind": "choice"]), .object(["optionId": "no", "name": "No", "kind": "choice"])])),
        opened("chk_gate", "lead", "gate", "Look at the offers before checking", options: .array([]),
               subject: .object(["type": "stage", "after": "A", "summary": "5 offers"])),
        opened("chk_ok", "retail-finder", "approval", "Open currys.co.uk?",
               options: .array([.object(["optionId": "allow", "name": "Allow once", "kind": "allow_once"]),
                                .object(["optionId": "deny", "name": "Decline", "kind": "reject_once"])])),
    ])
    var req = URLRequest(url: opts.url.appendingPathComponent("v0/events").appending(queryItems: [URLQueryItem(name: "project", value: "deals")]))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("Bearer \(opts.token)", forHTTPHeaderField: "Authorization")
    req.httpBody = Data(events.jsonText().utf8)
    let status = ((try? await URLSession.shared.data(for: req))?.1 as? HTTPURLResponse)?.statusCode
    Harness.equal(status, 200, "requests opened through the engine's log")
    func item(_ id: String) -> PendingItem? { store.pendingItem(id) }
    guard await until("the opened requests reach the inbox", 20, { item("chk_q") != nil && item("chk_gate") != nil && item("chk_ok") != nil }) else { return }

    // Return on a question with choices answers nothing.
    let none = await store.answerWithReturnKey(item("chk_q")!.request)
    Harness.check(none == nil, "Return on a question's choices sends nothing")

    // Reply with text.
    let reply = await store.submitText(item("chk_q")!.request, text: "Only if sold by the shop itself.")
    Harness.check(reply != nil, "reply sent")
    _ = await until("reply receipt applied", 20, { store.answerReceipt(for: "chk_q")?.state == .applied })
    Harness.check(store.isAnswerLocked("chk_q"), "the card takes no other answer after it applied")
    _ = await until("the question is resolved with the text", 20, {
        store.arrangedInbox.recent.contains { $0.requestId == "chk_q" && Supervision.outcomeText($0) == "Replied: \"Only if sold by the shop itself.\"" }
    })

    // Checkpoint: send back with a note (through Revise); empty notes send nothing.
    let empty = await store.submitText(item("chk_gate")!.request, text: "   ")
    Harness.check(empty == nil, "an empty note sends nothing")
    let back = await store.submitText(item("chk_gate")!.request, text: "Add Richer Sounds first.")
    Harness.check(back != nil, "send back sent")
    _ = await until("send back applied and resolved as Revise with the note", 20, {
        store.answerReceipt(for: "chk_gate")?.state == .applied
            && store.arrangedInbox.recent.contains { $0.requestId == "chk_gate" && $0.optionId == "revise" && $0.payloadText == "Add Richer Sounds first." }
    })

    // D on a simple approval.
    let deny = await store.quickAnswer(item("chk_ok")!.request, allow: false)
    Harness.check(deny != nil, "D sent")
    _ = await until("D declined the approval", 20, { store.arrangedInbox.recent.contains { $0.requestId == "chk_ok" && $0.optionId == "deny" } })
    Harness.equal(store.localCommands[deny ?? ""]?.text, "Decline", "the receipt is labelled with the option chosen")
    let late = await store.quickAnswer(store.arrangedInbox.recent.first { $0.requestId == "chk_ok" }!, allow: true)
    Harness.check(late == nil, "a settled card takes no second answer")

    // Steer without a runtime: accepted, left for the assistant.
    let steer = await store.sendMessage(to: "retail-finder", text: "Prefer shops with free delivery.", delivery: .steer)
    _ = await until("steer receipt accepted", 20, { steer.flatMap(store.receipt(for:))?.state == .accepted })
    Harness.note("steer: " + (steer.flatMap(store.receipt(for:))?.text ?? ""))
}

@MainActor
private func scriptedPart(_ store: OfficeStore) async {
    let started = await store.startRun(task: "Find the best price for Sony WH-1000XM6 headphones in the UK")
    Harness.check(started != nil, "run started (\(store.lastError ?? "ok"))")
    guard await until("finder-b's approval reaches the inbox", 30, { store.arrangedInbox.human.contains { $0.request.agentId == "finder-b" } }),
          let item = store.arrangedInbox.human.first(where: { $0.request.agentId == "finder-b" }) else { return }

    // Notification admission on the live inbox (delivery needs the bundled app).
    let live = store.attentionPlan(enabled: true, permitted: true, hidden: true, notified: [], delivered: [:])
    Harness.check(live.post.isEmpty, "no notification in the first 30 s")
    let later = AttentionPlan.make(human: store.arrangedInbox.human, now: (item.since ?? Date()).addingTimeInterval(31), enabled: true, permitted: true,
                                   hidden: true, notified: [], delivered: [:], nameOf: store.displayName)
    Harness.equal(later.post.map(\.agentId), ["finder-b"], "after 30 s in the background: one notification for finder-b")
    Harness.equal(later.post.first?.allowOptionId, "allow", "with Allow once")
    Harness.equal(later.post.first?.rejectOptionId, "deny", "and Deny")
    Harness.check(store.attentionPlan(enabled: true, permitted: true, hidden: false, notified: [], delivered: [:]).post.isEmpty, "none while frontmost")

    // Return on the focused card: Allow once.
    let answered = await store.answerWithReturnKey(item.request)
    Harness.check(answered != nil, "Return answered")
    Harness.check(store.isAnswerLocked(item.request.requestId), "the card locks while the answer is on its way")
    guard await until("answer applied", 20, { store.answerReceipt(for: item.request.requestId)?.state == .applied }) else { return }
    let again = await store.answerWithReturnKey(item.request)
    Harness.check(again == nil, "a second Return sends nothing")
    _ = await until("the inbox is empty", 20, { store.needsYouCount == 0 })
    Harness.equal(store.attentionPlan(enabled: true, permitted: true, hidden: true, notified: [], delivered: ["finder-b": item.request.requestId]).remove,
                  ["finder-b"], "the delivered notification goes once the request is answered")

    // Stop finder-b while it waits for a steer: requested until its status changes, then stopped.
    guard await until("finder-b takes interrupts and is working", 20, {
        store.accepts("finder-b", "interrupt") && store.status(of: "finder-b")?.state == .working
    }) else { return }
    let stop = await store.requestStop("finder-b")
    Harness.check(stop != nil, "Stop sent")
    Harness.equal(store.stopState(for: "finder-b")?.phase, .requested, "Stop requested at first (\(store.stopState(for: "finder-b")?.text ?? ""))")
    _ = await until("Stop → Stopped when the status changes", 20, { store.stopState(for: "finder-b")?.phase == .stopped })
    Harness.note("stop: " + (store.stopState(for: "finder-b")?.text ?? ""))
    store.forgetStop("finder-b")
    Harness.check(store.stopState(for: "finder-b") == nil, "the Stopped line clears")

    // Steer with a receipt.
    let steer = await store.sendMessage(to: "finder-b", text: "Only new units, please.", delivery: .steer)
    _ = await until("steer receipt final and ok", 20, { steer.flatMap(store.receipt(for:)).map { $0.isFinal && $0.ok } ?? false })
    Harness.note("steer: " + (steer.flatMap(store.receipt(for:))?.text ?? ""))
}

/// Wait (bounded) for a condition on the main actor; a check fails when it does not hold in time.
@MainActor
private func until(_ what: String, _ timeout: Double, _ condition: () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(50))
    }
    let ok = condition()
    Harness.check(ok, "\(what) (within \(Int(timeout)) s)")
    return ok
}
