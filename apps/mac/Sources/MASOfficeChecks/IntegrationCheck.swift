import Foundation
import MASOfficeKit

/// `--integration`: drive a REAL server with SCRIPTED backends (apps/mac/scripts/scripted-daemon.mjs) through
/// `OfficeStore` and `OfficeClient`: start a run, see the approval arrive over the stream, answer it, steer an
/// agent and read the receipt, read a transcript, see the result with its claims. Reads the daemon from
/// MAS_OFFICE_ATTACH_URL / MAS_OFFICE_ATTACH_TOKEN.
@MainActor
func integrationCheck() async {
    Harness.section("Integration: OfficeStore against the scripted daemon")
    let env = ProcessInfo.processInfo.environment
    guard let opts = LaunchOptions.parse(arguments: [], environment: env).attach else {
        Harness.check(false, "MAS_OFFICE_ATTACH_URL and MAS_OFFICE_ATTACH_TOKEN are set (loopback)")
        return
    }
    let store = OfficeStore()

    func until(_ what: String, timeout: Double = 20, _ condition: () -> Bool) async -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(50))
        }
        let ok = condition()
        Harness.check(ok, "\(what) (within \(Int(timeout)) s)")
        return ok
    }
    func step(_ s: String) { Harness.note(s) }

    store.connect(to: opts)
    guard await until("connected, project and locked team read", { store.connection.isUsable && store.structure?.locked == true }) else { return }
    Harness.equal(store.currentProject, "deals", "current project from home/projects")
    Harness.equal(store.session?.tokenValid, true, "the token is valid")
    Harness.equal(store.session?.runtime, true, "a runtime is attached")
    guard await until("event stream live", { store.connection == .live }) else { return }
    step("connected: \(store.structure?.memberIds.joined(separator: ", ") ?? "")")

    // Errors are typed.
    let bad = OfficeClient(baseURL: opts.url, token: "wrong-token")
    do {
        _ = try await bad.message(project: "deals", agentId: "lead", text: "hi")
        Harness.check(false, "a wrong token is refused")
    } catch let e as OfficeError {
        Harness.equal(e, .unauthorized, "wrong token → .unauthorized")
    } catch {
        Harness.check(false, "typed error")
    }
    let client = OfficeClient(baseURL: opts.url, token: opts.token)
    do {
        _ = try await client.snapshot(project: "../etc")
        Harness.check(false, "invalid project refused")
    } catch let e as OfficeError {
        Harness.equal(e, .invalidProject("../etc"), "invalid project name refused before any request")
    } catch {
        Harness.check(false, "typed error")
    }

    // 1. Start a run.
    let started = await store.startRun(task: "Find the best price for Sony WH-1000XM6 headphones in the UK")
    Harness.check(started?.runId != nil, "run started (\(started?.runId ?? "none"))")
    step("run \(started?.runId ?? "?") started")
    let doubleStart = await store.startRun(task: "again")
    Harness.check(doubleStart == nil && store.lastError != nil, "a second run while one is going is refused with a sentence (\(store.lastError ?? ""))")
    store.dismissError()

    // 2. The approval arrives over the stream.
    guard await until("finder-b's approval reaches the inbox", { store.arrangedInbox.human.contains { $0.request.agentId == "finder-b" } }) else { return }
    Harness.check(store.recentEvents.contains { $0.type == "request.opened" }, "request.opened arrived on the event stream")
    Harness.equal(store.connection, .live, "still live")
    let item = store.arrangedInbox.human.first { $0.request.agentId == "finder-b" }!
    Harness.equal(item.request.kind, "approval", "kind")
    Harness.check(!item.holds.isEmpty, "holds up: \(store.holdsUpText(item))")
    Harness.equal(store.needsYouCount, 1, "needs-you count")
    Harness.equal(store.waitingAgents.map(\.id), ["finder-b"], "waiting agents")
    Harness.equal(store.selectNextNeedingYou(), "finder-b", "next-up selects the waiting agent")
    step("pending: \(item.request.title) — \(store.holdsUpText(item))")

    // 3. Answer it.
    guard let allow = item.request.options.first(where: { $0.isAllow }) else {
        Harness.check(false, "an allow option")
        return
    }
    let answerCmd = await store.answer(item.request, option: allow)
    Harness.check(answerCmd != nil, "answer sent")
    guard await until("answer receipt applied", { store.answerReceipt(for: item.request.requestId)?.state == .applied }) else { return }
    step("answer: \(store.answerReceipt(for: item.request.requestId)?.text ?? "")")
    do {
        try await client.respond(project: "deals", requestId: item.request.requestId, agentId: "finder-b", answer: .option(allow.optionId, text: nil))
        Harness.check(false, "a second answer is refused")
    } catch let e as OfficeError {
        Harness.equal(e, .alreadyAnswered, "answering again → .alreadyAnswered (409)")
    } catch {
        Harness.check(false, "typed error")
    }
    _ = await until("the inbox is empty again", { store.needsYouCount == 0 })

    // 4. Steer finder-b; the scripted session waits for this message before it finishes.
    guard await until("finder-b accepts messages", { store.accepts("finder-b", "message") }) else { return }
    let steer = await store.sendMessage(to: "finder-b", text: "Only new units, please.", delivery: .steer)
    guard let steer else {
        Harness.check(false, "message sent")
        return
    }
    guard await until("steer receipt applied", { store.receipt(for: steer)?.state == .applied }) else { return }
    step("steer: \(store.receipt(for: steer)?.text ?? "")")
    Harness.equal(store.sentCommands(to: "finder-b").map(\.cmdId).contains(steer), true, "sentCommands lists it")
    let duplicate = try? await client.message(project: "deals", agentId: "finder-b", text: "Only new units, please.", cmdId: steer)
    Harness.equal(duplicate?.duplicate, true, "the same cmdId again is one command (duplicate)")

    // 5. Transcript.
    await store.loadTranscript("finder-b")
    guard await until("finder-b transcript has the request, the answer and the message", {
        let kinds = Set(store.transcripts["finder-b"]?.entries.map(\.kind) ?? [])
        return kinds.isSuperset(of: ["user", "request", "resolved", "command"])
    }) else { return }
    let tx = store.transcripts["finder-b"]!
    Harness.check(tx.cursor.consumed > 0, "transcript cursor advanced (\(tx.cursor.consumed) bytes)")
    let more = try? await client.transcript(project: "deals", agentId: "finder-b", from: tx.cursor)
    Harness.check(more.map { !$0.reset } ?? false, "incremental read continues from the cursor")
    Harness.check(tx.rows.contains { if case .tools = $0 { return true }; return false }, "tool call and result grouped")
    step("transcript: " + tx.entries.map(\.kind).joined(separator: " "))

    // 6. The result with claims.
    guard await until("the run finishes with a result", timeout: 30, { store.snapshot.state?.phase == "done" && store.snapshot.result != nil }) else { return }
    let result = store.snapshot.result!
    Harness.equal(ClaimTags.claimIds(result.markdown), ["c1", "c2"], "claims parsed from the result")
    Harness.equal(result.sources.map(\.id), ["currys-xm6", "ebay-xm6"], "sources")
    guard await until("verification read", { store.snapshot.verification?.summary.claims == 2 }) else { return }
    Harness.equal(store.snapshot.verification?.summary.supported, 2, "both claims supported")
    Harness.equal(store.credibility?.text.hasPrefix("2 claims · 2 supported"), true, "credibility: \(store.credibility?.text ?? "")")
    Harness.check(!store.isRunActive, "no run active")
    await store.loadWorkFiles("finder-b")
    Harness.equal(store.workFiles["finder-b"]?.files.first?.name, "finder-b.md", "work files")
    step("result: \(result.title ?? "") — \(store.credibility?.text ?? "")")

    // 7. A follow-up round.
    let follow = await store.followUp(question: "Is Currys still the best?")
    Harness.check(follow != nil, "follow-up accepted (\(store.lastError ?? "ok"))")
    store.disconnect()
    Harness.equal(store.connection, .disconnected, "disconnect")
}
