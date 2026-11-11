import Foundation
import MASOfficeKit

/// The Swift ports against the panel's JS on the same inputs: expected values are computed at check time by
/// `apps/mac/scripts/js-expected.cjs` running panel/inbox.js and panel/model.js.
@MainActor
func parityChecks() async {
    Harness.section("Parity with panel/inbox.js and panel/model.js (expected values computed by node at check time)")
    guard let node = Harness.node else {
        Harness.check(false, "node is needed to compute the JS expectations")
        return
    }
    let fixture = Harness.repo.appendingPathComponent("panel/tests/fixtures/mock-supervise/deals")
    let nowMs = 1_794_303_600_000.0 // 2026-11-10T09:40:00Z
    let now = date(ms: nowMs)

    let claimCases: [String] = [
        "A <claim id=\"c1\" src=\"a,b\">**new** at £279</claim> deal.",
        "<claim id=c9>x</claim>",
        "<CLAIM ID='c2' SRC=' a , b ,bad id,c'>y</Claim>",
        "<claim id=\"c1\"><claim id=\"c2\">inner</claim>outer</claim>",
        "<claim id=\"c1\">unclosed",
        "</claim> closes nothing <claim id=x>ok</claim>",
        "<claim id=\"bad id\">x</claim>",
        "<claim>x</claim>",
        "<claimx id=a>x</claim>",
        "<claim id=a src=\"x\"y>z</claim>",
        "<claim id=a\n>multi\nline</claim>",
        "<claim id=\"" + String(repeating: "a", count: 400) + "\">long tag</claim>",
        "<claim id=\"" + String(repeating: "a", count: 64) + "\">64</claim><claim id=\"" + String(repeating: "a", count: 65) + "\">65</claim>",
        "<claim id=a>😀 emoji</claim> and 中文 <claim id=b src=c>文</claim>",
        "<<<<claim id=a>x</claim>",
        "<claim id=\"a\" id=\"b\">dup</claim>",
        "<claim id=a src=>x</claim>",
        "<claim\tid=a>tab</claim>",
        "<claim id=a/>x</claim>",
        "<claim id='a' src='p.q:r-s_t'>chars</claim>",
        "<claim id=a >space before gt</claim>",
        "| <claim id=\"c2\">cell</claim> | y |",
        "plain text only",
        "",
        String(repeating: "<claim id=a>", count: 300) + "x</claim>",
        "<claim id=a>" + String(repeating: "<", count: 1000) + "</claim>",
    ]
    let receiptCases: [(LocalCommand?, CommandRecord?)] = {
        func local(_ s: ReceiptState, _ e: String? = nil) -> LocalCommand { LocalCommand(state: s, error: e, type: "command.message", agentId: "a", at: now) }
        func cmd(_ status: String, _ reason: String? = nil) -> CommandRecord {
            var o: [String: JSONValue] = ["cmdId": "c", "status": .string(status)]
            if let reason { o["reason"] = .string(reason) }
            return CommandRecord(json: .object(o))!
        }
        return [(local(.sending), nil), (local(.sent), cmd("accepted", "queued_after_turn")), (local(.sent), cmd("applied")),
                (local(.conflict), cmd("applied")), (local(.failed, "no connection"), nil), (local(.accepted), cmd("sent")),
                (nil, cmd("rejected", "not_allowed")), (local(.sending), cmd("unsupported")), (local(.sent), cmd("expired")),
                (local(.applied), cmd("rejected")), (local(.sent), cmd("applied", "")), (nil, nil)]
    }()
    let durations: [Double] = [-1, 0, 999, 1000, 12_400, 59_999, 60_000, 100_000, 3_599_000, 3_600_000, 3_900_000, 86_400_000]
    let waits: [(Double?, Double)] = [(nil, nowMs), (nowMs - 59_000, nowMs), (nowMs - 60_000, nowMs), (nowMs - 4 * 60_000 - 30_000, nowMs),
                                      (nowMs - 59 * 60_000, nowMs), (nowMs - 65 * 60_000, nowMs), (nowMs + 120_000, nowMs), (nowMs - 25 * 3_600_000, nowMs)]
    let names: [[String]] = [[], ["A"], ["A", "B"], ["A", "B", "C"], ["A", "B", "C", "D"], ["A", "B", "C", "D", "E", "F"]]
    let subjectCases: [JSONValue] = [
        .object(["type": "command", "command": "ls -la"]),
        .object(["type": "file_change", "path": "a.md", "diff": "+x\n-y"]),
        .object(["type": "file_change", "paths": .array(["a", "b"])]),
        .object(["type": "plan", "steps": .array(["search", "check", "write"])]),
        .object(["type": "claim", "claimId": "c1", "text": "Currys sells it"]),
        .object(["type": "stage", "label": "Search", "summary": "5 offers"]),
        .object(["type": "stage", "after": "A", "files": .array(["x.md", "y.md", .number(3)])]),
        .object(["type": "tool_call", "tool": "Bash", "command": "echo hi"]),
        .object(["type": "tool_call", "tool": "Read", "input": "a string input"]),
        .object(["type": "command", "command": .string(String(repeating: "x", count: 700))]),
        .object(["type": "plan", "plan": .array(["1", "2", "3", "4", "5", "6", "7", "8", "9"])]),
    ]
    let roundCases: [JSONValue] = [
        .object(["title": "T", "run": 1, "markdown": "A"]),
        (try? JSONValue.parse(#"{"title":"T","run":2,"round":3,"question":"And Argos?","markdown":"C","previous":[{"round":1,"title":"T","markdown":"A"},{"round":2,"question":"Warranty?","markdown":"B"},null,{"round":9},"x"]}"#)) ?? .null,
        (try? JSONValue.parse(#"{"markdown":"B","previous":[{"markdown":"A"}]}"#)) ?? .null,
        (try? JSONValue.parse(#"{"markdown":"B","round":1,"previous":[{"round":4,"markdown":"A"}]}"#)) ?? .null,
        (try? JSONValue.parse(#"{"markdown":"C","previous":[{"markdown":"A"},{"round":1,"markdown":"B"}]}"#)) ?? .null,
        (try? JSONValue.parse(#"{"markdown":"B","round":"2","question":7}"#)) ?? .null,
    ]

    func encodeLocal(_ l: LocalCommand?) -> JSONValue {
        guard let l else { return .null }
        return .object(["state": .string(l.state.rawValue), "error": l.error.map(JSONValue.string) ?? .null])
    }
    func encodeCmd(_ c: CommandRecord?) -> JSONValue {
        guard let c else { return .null }
        return .object(["cmdId": .string(c.cmdId), "status": .string(c.status), "reason": c.reason.map(JSONValue.string) ?? .null])
    }
    let cases: JSONValue = .object([
        "fixture": .string(fixture.path),
        "now": .number(nowMs),
        "claims": .array(claimCases.map(JSONValue.string)),
        "receipts": .array(receiptCases.map { .object(["local": encodeLocal($0.0), "cmd": encodeCmd($0.1)]) }),
        "durations": .array(durations.map(JSONValue.number)),
        "waits": .array(waits.map { .array([$0.0.map(JSONValue.number) ?? .null, .number($0.1)]) }),
        "names": .array(names.map { .array($0.map(JSONValue.string)) }),
        "subjects": .array(subjectCases),
        "rounds": .array(roundCases),
    ])
    let casesFile = Harness.scratch("parity").appendingPathComponent("cases.json")
    try? Data(cases.jsonText().utf8).write(to: casesFile)
    let script = Harness.repo.appendingPathComponent("apps/mac/scripts/js-expected.cjs")
    let out = await ProcessRunner.run(node, arguments: [script.path, casesFile.path], timeout: .seconds(60))
    guard out.status == 0, let js = try? JSONValue.parse(out.stdout) else {
        Harness.check(false, "js-expected.cjs ran (status \(String(describing: out.status)))")
        return
    }

    // Swift side, same inputs.
    func doc(_ rel: String, _ g: String) -> JSONValue { Harness.twin(fixture.appendingPathComponent(rel)).globals[g] ?? .null }
    let s = Structure(json: doc("mas/structure.js", "MAS_STRUCTURE"))
    let inbox = Inbox(json: doc("mas/inbox.js", "MAS_INBOX"))
    var statuses: [String: AgentStatus] = [:]
    for id in s.memberIds {
        if let v = Harness.twin(fixture.appendingPathComponent("mas/status/\(id).js")).statuses[id] { statuses[id] = AgentStatus(json: v) }
    }
    let ar = Supervision.arrange(inbox, structure: s, statuses: statuses, firstSeen: [:], now: now)

    func items(_ v: JSONValue?) -> [[String]] {
        (v?.array ?? []).map { x in
            [x.string("id") ?? "", x.double("since").map { String(Int64($0)) } ?? "nil", x.strings("holds").joined(separator: ","), x.string("waited") ?? ""]
        }
    }
    func mine(_ list: [PendingItem]) -> [[String]] {
        list.map { [$0.id, ms($0.since).map { String(Int64($0)) } ?? "nil", $0.holds.joined(separator: ","), Supervision.waited(since: $0.since, now: now)] }
    }
    Harness.equal(mine(ar.human), items(js["human"]), "arrangeInbox.human: order, since, holds up, waited")
    Harness.equal(mine(ar.withLead), items(js["withLead"]), "arrangeInbox.withLead")
    Harness.note("needs-you order: " + ar.human.map(\.id).joined(separator: ", "))

    let recentJS = (js["recent"]?.array ?? []).map { [$0.string("id") ?? "", $0.string("outcome") ?? "", $0.string("by") ?? ""] }
    Harness.equal(ar.recent.map { [$0.requestId, Supervision.outcomeText($0), Supervision.byText($0.by, nameOf: { "N:" + $0 })] }, recentJS,
                  "outcomeText / byText")

    let waiting = Supervision.waitingAgents(ar.human)
    let waitingJS = (js["waiting"]?.array ?? []).map { [$0.string("id") ?? "", String($0.int("count") ?? -1), $0.strings("requestIds").joined(separator: ",")] }
    Harness.equal(waiting.map { [$0.id, String($0.count), $0.requestIds.joined(separator: ",")] }, waitingJS, "waitingAgents")

    var nu = NextUp()
    let seq = (0..<6).map { i in nu.next(NextUp.line(waiting), here: i == 3 ? "catch-checker" : nil) }
    Harness.equal(seq.map { $0 ?? "null" }, (js["nextUp"]?.array ?? []).map { $0.string ?? "null" }, "NextUp cycling")
    var nu2 = NextUp()
    let idleLine = Supervision.idleAgents(structure: s, statuses: statuses)
    let idle = (0..<3).map { _ in nu2.next(idleLine, here: nil) }
    Harness.equal(idle.map { $0 ?? "null" }, (js["idle"]?.array ?? []).map { $0.string ?? "null" }, "idle agents cycling")

    let answersJS = (js["answers"]?.array ?? []).map { a -> String in
        let opts = (a["options"]?.array ?? []).map { o in (o.array ?? []).map { $0.string ?? ($0.bool.map { $0 ? "true" : "false" } ?? "?") }.joined(separator: "/") }
        return (a.string("id") ?? "") + ":" + opts.joined(separator: ";") + ":" + (a.bool("quick") == true ? "quick" : "-")
    }
    let answersSwift = inbox.pending.map { r -> String in
        let opts = Supervision.answerOptions(r).map { [$0.option.optionId, $0.tone.rawValue, $0.needsText ? "true" : "false", $0.always ? "true" : "false"].joined(separator: "/") }
        return r.requestId + ":" + opts.joined(separator: ";") + ":" + (Supervision.quickPair(r) != nil ? "quick" : "-")
    }
    Harness.equal(answersSwift, answersJS, "answerOptions / quickPair")

    func subj(_ v: JSONValue?) -> String {
        guard let v, v.isObject else { return "null" }
        return [v.string("type") ?? "", v.string("label") ?? "", String(v.int("lines") ?? -1), v.bool("long") == true ? "long" : "short"].joined(separator: "|")
    }
    func subjSwift(_ v: SubjectView?) -> String {
        guard let v else { return "null" }
        return [v.type, v.label, String(v.lines), v.long ? "long" : "short"].joined(separator: "|")
    }
    Harness.equal(inbox.pending.map { subjSwift(Supervision.subjectView($0.subject)) }, (js["subjects"]?.array ?? []).map(subj), "subjectView of the fixture requests")
    let extra = js["extraSubjects"]?.array ?? []
    for (i, c) in subjectCases.enumerated() {
        let sw = Supervision.subjectView(c)
        Harness.equal(subjSwift(sw) + "|" + (sw?.text ?? ""), subj(extra[safe: i]) + "|" + (extra[safe: i]?.string("text") ?? ""), "subjectView case \(i)")
    }

    let receiptsJS = js["receipts"]?.array ?? []
    for (i, c) in receiptCases.enumerated() {
        let r = Supervision.receipt(local: c.0, command: c.1)
        let j = receiptsJS[safe: i]
        Harness.equal("\(r.state.rawValue)|\(r.isFinal)|\(r.ok)|\(r.text)",
                      "\(j?.string("state") ?? "")|\(j?.bool("final") ?? false)|\(j?.bool("ok") ?? false)|\(j?.string("text") ?? "")", "receipt case \(i)")
    }
    Harness.equal(durations.map { Supervision.durationText($0 / 1000) }, (js["durations"]?.array ?? []).map { $0.string ?? "" }, "durationText")
    Harness.equal(waits.map { Supervision.waited(since: $0.0.map(date(ms:)), now: date(ms: $0.1)) }, (js["waits"]?.array ?? []).map { $0.string ?? "" }, "waited")
    Harness.equal(names.map { [Supervision.namesText($0), Supervision.holdsUpText($0)] }, (js["names"]?.array ?? []).map { $0.array?.compactMap(\.string) ?? [] },
                  "namesText / holdsUpText")

    let claimsJS = js["claims"]?.array ?? []
    for (i, text) in claimCases.enumerated() {
        let mineSegs = ClaimTags.segments(text).map { seg -> String in
            guard let c = seg.claim else { return "T:" + seg.text }
            return "C:" + c.id + "[" + c.src.joined(separator: ",") + "]:" + seg.text
        }
        let theirs = (claimsJS[safe: i]?.array ?? []).map { seg -> String in
            guard let id = seg.string("id") else { return "T:" + (seg.string("text") ?? "") }
            return "C:" + id + "[" + seg.strings("src").joined(separator: ",") + "]:" + (seg.string("text") ?? "")
        }
        Harness.equal(mineSegs, theirs, "claimSegments case \(i)")
    }
    let roundsJS = js["rounds"]?.array ?? []
    for (i, r) in roundCases.enumerated() {
        let mineR = ResultDoc(json: r).rounds.map { "\($0.round)|\($0.question)|\($0.markdown)|\($0.latest)" }
        let theirs = (roundsJS[safe: i]?.array ?? []).map { x -> String in
            let a = x.array ?? []
            return "\(a[safe: 0]?.int ?? -1)|\(a[safe: 1]?.string ?? "")|\(a[safe: 2]?.string ?? "")|\(a[safe: 3]?.bool ?? false)"
        }
        Harness.equal(mineR, theirs, "resultRounds case \(i)")
    }
    let ver = Verification(json: doc("outputs/verification.js", "MAS_VERIFICATION"))
    Harness.equal(Credibility(ver.summary).text, js["credibility"]?.string ?? "", "credibility line")

    let tdir = fixture.appendingPathComponent("mas/transcript")
    for (name, expected) in (js["transcripts"]?.object ?? [:]).sorted(by: { $0.key < $1.key }) {
        let data = (try? Data(contentsOf: tdir.appendingPathComponent(name + ".jsonl"))) ?? Data()
        let entries = TranscriptCursor().append(data).entries
        Harness.equal(entries.count, expected.int("entries") ?? -1, "transcript \(name): entries")
        let rows = TranscriptRow.group(entries).map { row -> String in
            switch row {
            case .entry(let e): return "entry:" + e.kind
            case .tools(let t): return "tools:\(t.tool):\(t.count):\(t.failed):\(t.running)"
            }
        }
        Harness.equal(rows, expected.strings("rows"), "transcript \(name): groupTranscript")
        Harness.equal(TranscriptRow.currentTool(entries)?.tool ?? "null", expected.string("current") ?? "null", "transcript \(name): currentTool")
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
