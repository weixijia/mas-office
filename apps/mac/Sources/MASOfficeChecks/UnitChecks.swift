import Foundation
import MASOfficeKit

// MARK: - Decoding fixtures and examples

@MainActor
func decodingChecks() {
    Harness.section("Decoding: panel/tests/fixtures/mock-supervise and examples/")
    let fx = Harness.repo.appendingPathComponent("panel/tests/fixtures/mock-supervise")
    let home = Harness.twin(fx.appendingPathComponent("home/projects.js")).globals["MAS_HOME"]
    Harness.check(home != nil, "home/projects.js parses")
    let index = ProjectsIndex(json: home ?? .null)
    Harness.equal(index.current, "deals", "projects.current")
    Harness.equal(index.projects.map(\.folder), ["deals"], "projects")
    Harness.equal(index.projects.first?.agents, 4, "projects[0].agents")

    let deals = fx.appendingPathComponent("deals")
    func doc(_ rel: String, _ global: String) -> JSONValue? { Harness.twin(deals.appendingPathComponent(rel)).globals[global] }
    let s = Structure(json: doc("mas/structure.js", "MAS_STRUCTURE") ?? .null)
    Harness.equal(s.title, "Headphone deals", "structure.title")
    Harness.check(s.locked, "structure.locked")
    Harness.equal(s.memberIds, ["lead", "retail-finder", "marketplace-finder", "catch-checker"], "members")
    Harness.equal(s.role("retail-finder")?.tools, [ToolGrant(name: "web search"), ToolGrant(name: "browse the web", effect: .ask)], "tools: string and {name, effect}")
    Harness.equal(s.role("retail-finder")?.tools.map(\.text), ["web search", "browse the web (asks first)"], "tool text")
    Harness.equal(s.role("catch-checker")?.reviewerOf, ["retail-finder", "marketplace-finder"], "reviewerOf")
    Harness.equal(s.role("catch-checker")?.cleanContext, true, "cleanContext")
    Harness.equal(s.role("marketplace-finder")?.backend, "codex", "backend")
    Harness.equal(s.orderedGroups.map(\.id), ["A", "B"], "group order")
    Harness.equal(s.name(of: "lead"), "Lead", "lead name")

    let state = ProjectState(json: doc("mas/state.js", "MAS_STATE") ?? .null)
    Harness.equal(state.mode, "sdk", "state.mode")
    Harness.equal(state.phase, "running", "state.phase")

    var statuses: [String: AgentStatus] = [:]
    for id in s.memberIds {
        let t = Harness.twin(deals.appendingPathComponent("mas/status/\(id).js"))
        Harness.check(t.statuses[id] != nil, "status twin for \(id)")
        statuses[id] = t.statuses[id].map(AgentStatus.init(json:))
    }
    Harness.equal(statuses["retail-finder"]?.state, .flagged, "status state")
    Harness.equal(statuses["retail-finder"]?.waitingOn, ["req_lead1", "req_browse"], "waitingOn")
    Harness.equal(statuses["retail-finder"]?.stateLabel, "needs you", "needs_approval reads 'needs you'")
    Harness.equal(statuses["retail-finder"]?.progress, 55, "progress")

    let inbox = Inbox(json: doc("mas/inbox.js", "MAS_INBOX") ?? .null)
    Harness.equal(inbox.pending.map(\.requestId), ["req_browse", "req_q", "req_gate", "req_flag", "req_cmd", "req_lead1"], "pending ids")
    Harness.equal(inbox.recent.count, 4, "recent")
    Harness.equal(inbox.commands.map(\.status), ["applied", "applied", "applied", "accepted"], "command statuses")
    Harness.equal(inbox.pending.first?.subject?.string("tool"), "browse the web", "subject kept as raw JSON")
    Harness.equal(inbox.pending.first?.options.map(\.kind), ["allow_once", "reject_once"], "options")
    Harness.equal(inbox.pending.first(where: { $0.requestId == "req_flag" })?.urgency, .high, "urgency")
    Harness.equal(inbox.recent.first?.by?.kind, "terminal", "by")

    let board = Board(json: doc("mas/board.js", "MAS_BOARD") ?? .null)
    Harness.equal(board.tasks.count, 3, "board.tasks")
    Harness.equal(board.reviews.count, 2, "board.reviews")
    Harness.equal(Set(board.usage.keys), Set(s.memberIds), "board.usage keys")
    Harness.check(board.accepts("retail-finder", "message"), "retail-finder accepts message")

    let ver = Verification(json: doc("outputs/verification.js", "MAS_VERIFICATION") ?? .null)
    Harness.equal(ver.claims.count, 6, "claims")
    Harness.equal(ver.evidence.count, 5, "evidence")
    Harness.equal(ver.summary.contradicted, 1, "summary.contradicted")
    Harness.equal(ver.summary.uncited, 1, "summary.uncited")
    Harness.check(ver.evidence.contains { $0.urlHealth == .hallucinated }, "urlHealth hallucinated")
    Harness.equal(URLHealth.hallucinated.word, "dead", "health word")

    let result = ResultDoc(json: doc("outputs/result.js", "MAS_RESULT") ?? .null)
    Harness.equal(result.sources.count, 4, "result.sources")
    Harness.equal(ClaimTags.claimIds(result.markdown), ["c1", "c2", "c3", "c4", "c5", "c6"], "well-formed claim tags in result.markdown")
    Harness.equal(result.rounds.count, 1, "a plain result is one round")
    let stripped = ClaimTags.stripped(result.markdown)
    Harness.check(!stripped.contains("<claim id=\"c1\"") && stripped.contains("onmouseover"), "well-formed tags stripped, the hostile ones stay text")

    let task = TaskDoc(json: doc("me/task.js", "MAS_TASK") ?? .null)
    Harness.check(task.title != nil, "task.title")

    // Transcripts (JSONL)
    for name in ["lead", "retail-finder"] {
        let data = (try? Data(contentsOf: deals.appendingPathComponent("mas/transcript/\(name).jsonl"))) ?? Data()
        let r = TranscriptCursor().append(data)
        Harness.check(!r.entries.isEmpty, "transcript \(name) has entries")
        Harness.equal(r.cursor.consumed, data.count, "transcript \(name) consumed all complete lines")
        let again = r.cursor.append(data)
        Harness.check(again.entries.isEmpty && !again.reset, "re-reading an unchanged transcript yields nothing new")
    }

    // The three examples (kit projects, .js twins only)
    let examples = Harness.repo.appendingPathComponent("examples")
    for project in ["price-compare", "thesis-feasibility", "trip-planning"] {
        let dir = examples.appendingPathComponent(project)
        let st = Structure(json: Harness.twin(dir.appendingPathComponent("mas/structure.js")).globals["MAS_STRUCTURE"] ?? .null)
        Harness.check(!st.roles.isEmpty, "\(project): roles decode")
        let ps = ProjectState(json: Harness.twin(dir.appendingPathComponent("mas/state.js")).globals["MAS_STATE"] ?? .null)
        Harness.check(ps.phase != nil, "\(project): state.phase")
        let res = Harness.twin(dir.appendingPathComponent("outputs/result.js")).globals["MAS_RESULT"]
        Harness.check(res.map { !ResultDoc(json: $0).markdown.isEmpty } ?? false, "\(project): result.markdown")
        for id in st.memberIds {
            let f = dir.appendingPathComponent("mas/status/\(id).js")
            guard FileManager.default.fileExists(atPath: f.path) else { continue }
            Harness.check(Harness.twin(f).statuses[id] != nil, "\(project): status \(id)")
        }
        let task = Harness.twin(dir.appendingPathComponent("me/task.js")).globals["MAS_TASK"]
        Harness.check(task.map { !TaskDoc(json: $0).requirements.isEmpty } ?? false, "\(project): task requirements")
    }

    // Tolerance: wrong types and unknown fields never fail a document.
    let weird = try? JSONValue.parse(#"{"title": 5, "locked": "yes", "roles": [null, 3, {"id": "x", "tools": [7, {"name": "web search", "effect": "nope"}], "reviewerOf": [1, "y"]}, {"id": "lead"}, {"id": "x"}], "groups": "A", "extra": {"a": [1]}}"#)
    let ws = Structure(json: weird ?? .null)
    Harness.equal(ws.title, nil, "wrong-typed title reads as missing")
    Harness.equal(ws.locked, false, "wrong-typed locked reads as false")
    Harness.equal(ws.roles.map(\.id), ["x"], "roles: non-objects, 'lead' and duplicates dropped")
    Harness.equal(ws.roles.first?.tools, [ToolGrant(name: "web search")], "unknown effect reads as allow")
    Harness.equal(ws.roles.first?.reviewerOf, ["y"], "non-string items dropped")
    let decoded = try? JSONDecoder().decode(Structure.self, from: Data(#"{"title":"T","roles":[{"id":"a"}]}"#.utf8))
    Harness.equal(decoded?.roles.map(\.id), ["a"], "Decodable via JSONDecoder")
    let encoded = (try? JSONEncoder().encode(inbox)).map { String(decoding: $0, as: UTF8.self) } ?? ""
    Harness.check(encoded.contains("req_browse"), "models encode")
    Harness.equal(try? JSONValue.parse("[1, true, null, \"x\", 1.5]"), .array([.number(1), .bool(true), .null, .string("x"), .number(1.5)]), "JSONValue keeps bools apart from numbers")
    Harness.equal(InboxRequest(json: .object(["requestId": "r", "seq": .number(41)]))?.title, "Untitled request", "request defaults")
    Harness.equal(InboxRequest(json: .object(["title": "no id"])) == nil, true, "a request without id is dropped")

    // JS twin edge cases
    let twin = JSTwin.parse("""
    // comment window.NOPE = 1
    window.MAS_STATUS = window.MAS_STATUS || {};
    window.MAS_STATUS["a-b"] = {"state":"working","say":"x; y = \\"z\\" }"};
    window.MAS_STATE = {"phase":"done"};window.MAS_X={"a":[1,{"b":"]"}]};
    window.MAS_BROKEN = {"a": ;
    """)
    Harness.equal(twin.statuses["a-b"]?.string("say"), "x; y = \"z\" }", "status twin with tricky string")
    Harness.equal(twin.globals["MAS_STATE"]?.string("phase"), "done", "global twin")
    Harness.equal(twin.globals["MAS_X"]?["a"]?.array?.count, 2, "brackets inside strings")
    Harness.equal(twin.globals["MAS_BROKEN"] == nil, true, "a broken value is skipped")
    Harness.equal(twin.globals["NOPE"], .number(1), "a twin inside a comment still reads (it is not executed; harmless)")
}

// MARK: - SSE parser

@MainActor
func sseChecks() {
    Harness.section("SSE parser")
    func parse(_ text: String, chunks: Int? = nil) -> [SSEMessage] {
        var p = SSEParser()
        let bytes = Array(text.utf8)
        guard let chunks else { return p.feed(bytes) }
        var out: [SSEMessage] = []
        var i = 0
        while i < bytes.count {
            let end = min(bytes.count, i + chunks)
            out += p.feed(bytes[i..<end])
            i = end
        }
        return out
    }
    let server = "retry: 2000\n\nevent: change\ndata: {\"path\":\"deals/mas/state.json\"}\n\n: ping\n\nevent: mas\nid: 7\ndata: {\"project\":\"deals\",\"event\":{\"seq\":7,\"type\":\"agent.status\",\"agentId\":\"lead\",\"data\":{\"state\":\"working\"}}}\n\n"
    let a = parse(server)
    Harness.equal(a.map(\.event), ["change", "mas"], "server stream: events (comments and retry-only blocks dispatch nothing)")
    Harness.equal(a.last?.id, "7", "id")
    let ev = a.last.flatMap { try? JSONValue.parse($0.data) }.flatMap(OfficeEvent.init(payload:))
    Harness.equal(ev?.seq, 7, "mas payload → OfficeEvent.seq")
    Harness.equal(ev?.agentId, "lead", "OfficeEvent.agentId")
    for n in [1, 2, 3, 7, 64] {
        Harness.equal(parse(server, chunks: n), a, "same events when fed in \(n)-byte chunks")
    }
    Harness.equal(parse("data: a\ndata: b\n\n").map(\.data), ["a\nb"], "multi-line data")
    Harness.equal(parse("data: a\r\ndata: b\r\n\r\n").map(\.data), ["a\nb"], "CRLF")
    Harness.equal(parse("data: a\rdata: b\r\r").map(\.data), ["a\nb"], "CR")
    Harness.equal(parse("data: a\r\ndata: b\r\n\r\n", chunks: 1).map(\.data), ["a\nb"], "CRLF split across chunks")
    Harness.equal(parse("data:no-space\n\ndata:  two\n\n").map(\.data), ["no-space", " two"], "one leading space removed")
    Harness.equal(parse("data\n\n").map(\.data), [""], "field without colon")
    Harness.equal(parse("event: x\n\ndata: y\n\n").map(\.event), ["message"], "an event without data is dropped and its type reset")
    Harness.equal(parse("id: 1\ndata: a\n\ndata: b\n\n").map(\.id), ["1", "1"], "last event id persists")
    Harness.equal(parse("id: a\u{0}b\ndata: a\n\n").first?.id, nil, "id with NUL ignored")
    Harness.equal(parse("retry: 3000\ndata: a\n\n").first?.retry, 3000, "retry")
    Harness.equal(parse("retry: 30x\ndata: a\n\n").first?.retry, nil, "bad retry ignored")
    Harness.equal(parse("data: tail without blank line").count, 0, "no dispatch without a blank line")
    Harness.equal(parse("\u{FEFF}data: bom\n\n").map(\.data), ["bom"], "leading BOM skipped")
    Harness.equal(parse("data: 中文 😀\n\n").map(\.data), ["中文 😀"], "UTF-8")
    Harness.equal(parse("data: 中文 😀\n\n", chunks: 1).map(\.data), ["中文 😀"], "UTF-8 split mid-character")
    Harness.equal(parse(":comment only\n\n").count, 0, "comment")
    Harness.equal(parse("unknown: x\ndata: y\n\n").map(\.data), ["y"], "unknown field ignored")
    Harness.equal(EventStream.backoff(0), 1, "backoff 0")
    Harness.equal((0..<8).map(EventStream.backoff), [1, 2, 4, 8, 16, 30, 30, 30], "backoff sequence")
}

// MARK: - Login shell, Node, launch options

@MainActor
func shellChecks() async {
    Harness.section("Login-shell environment, Node version, launch options")
    let delimiter = "_MAS_OFFICE_SHELL_ENV_DELIMITER_"
    var dump = Data("Welcome to zsh!\n".utf8)
    dump.append(0)
    dump.append(Data(delimiter.utf8))
    dump.append(0)
    for kv in ["PATH=/opt/homebrew/bin:/usr/bin", "HOME=/Users/x", "EQ=a=b=c", "SHLVL=2", "PWD=/tmp", "EMPTY=", "MULTI=line1\nline2", "=bad"] {
        dump.append(Data(kv.utf8))
        dump.append(0)
    }
    dump.append(Data(delimiter.utf8))
    dump.append(0)
    dump.append(Data("rc noise after".utf8))
    let vars = ShellEnvironment.parseDump(dump)
    Harness.equal(vars?["PATH"], "/opt/homebrew/bin:/usr/bin", "PATH")
    Harness.equal(vars?["EQ"], "a=b=c", "values keep '='")
    Harness.equal(vars?["MULTI"], "line1\nline2", "values keep newlines")
    Harness.equal(vars?["EMPTY"], "", "empty value")
    Harness.equal(vars?["SHLVL"], nil, "probe-session keys dropped")
    Harness.equal(vars?["PWD"], nil, "PWD dropped")
    Harness.equal(vars?.count, 5, "no entry for '=bad'")
    Harness.equal(ShellEnvironment.parseDump(Data("no delimiters".utf8)) == nil, true, "no delimiters → nil")
    var one = Data()
    one.append(0)
    one.append(Data(delimiter.utf8))
    one.append(0)
    one.append(Data("A=1".utf8))
    Harness.equal(ShellEnvironment.parseDump(one) == nil, true, "only one delimiter → nil")

    let minimal = ShellEnvironment.minimal(from: [
        "PATH": "p", "HOME": "h", "USER": "u", "LOGNAME": "l", "SHELL": "s", "LANG": "en", "LC_ALL": "C", "TMPDIR": "t", "TERM": "xterm",
        "https_proxy": "x", "NO_PROXY": "y", "XDG_CONFIG_HOME": "z", "CLAUDE_CONFIG_DIR": "c", "CODEX_HOME": "d",
        "ANTHROPIC_API_KEY": "secret", "OPENAI_API_KEY": "secret", "AWS_SECRET_ACCESS_KEY": "secret", "GITHUB_TOKEN": "secret",
        "SSH_AUTH_SOCK": "sock", "NODE_OPTIONS": "--require evil", "MAS_OFFICE_ATTACH_TOKEN": "t",
    ])
    Harness.equal(Set(minimal.keys), ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM", "https_proxy", "NO_PROXY",
                                      "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"], "daemon environment is the allow-list only")
    let env = ShellEnvironment(variables: ["PATH": "/a:/b", "HOME": "/h", "SECRET": "x"], source: .fallback("test"))
    Harness.check(!String(describing: env).contains("/a:/b") && !String(describing: env).contains("SECRET"), "description never shows variables")
    Harness.equal(Array(env.searchPath.prefix(4)), ["/a", "/b", "/opt/homebrew/bin", "/usr/local/bin"], "search path: PATH first, then fallbacks")
    Harness.check(env.searchPath.contains("/h/.volta/bin") && env.searchPath.contains("/h/.local/bin"), "fallbacks include Volta and ~/.local/bin")
    Harness.equal(env.daemonEnvironment()["SECRET"], nil, "daemonEnvironment drops the rest")

    Harness.equal(NodeVersion.parse("v20.11.1\n"), NodeVersion(20, 11, 1), "node version")
    Harness.equal(NodeVersion.parse("18.14.0"), NodeVersion(18, 14, 0), "without v")
    Harness.equal(NodeVersion.parse("v22.0.0-nightly2024"), NodeVersion(22, 0, 0), "prerelease")
    Harness.equal(NodeVersion.parse("node"), nil, "garbage")
    Harness.check(NodeVersion(18, 13, 9) < NodeVersion.minimum && NodeVersion(18, 14, 0) >= NodeVersion.minimum, "minimum 18.14")

    let captured = await ShellEnvironment.capture(timeout: .seconds(10))
    Harness.check(!(captured.variables["PATH"] ?? "").isEmpty, "login shell read gives a PATH")
    if case .loginShell(let sh) = captured.source { Harness.note("read from \(sh)") } else { Harness.note("fallback: \(captured.source)") }
    let check = await NodeCheck.run(in: captured)
    if case .found(let url, let v) = check { Harness.note("node \(v) at \(url.path)") }
    Harness.check(check.node != nil, "node ≥ 18.14 found through the login shell")

    let o = LaunchOptions.parse(arguments: ["MASOffice", "-NSDocumentRevisionsDebugMode", "YES", "--attach-url", "http://127.0.0.1:5000",
                                            "--attach-token=abc", "--self-check", "/tmp/r.json", "--render", "~/r"],
                                environment: ["MAS_OFFICE_ATTACH_TOKEN": "env-token"])
    Harness.equal(o.attach?.url.absoluteString, "http://127.0.0.1:5000", "attach url")
    Harness.equal(o.attach?.token, "abc", "arguments win over environment")
    Harness.equal(o.selfCheckPath, "/tmp/r.json", "self-check path")
    Harness.check(o.isAutomated, "automated")
    Harness.check(!o.description.contains("abc"), "launch options never print the token")
    Harness.equal(LaunchOptions.parse(arguments: [], environment: ["MAS_OFFICE_ATTACH_URL": "http://evil.example:1", "MAS_OFFICE_ATTACH_TOKEN": "t"]).attach == nil, true,
                  "attach only to loopback")
    let info = DaemonInfo(url: URL(string: "http://127.0.0.1:1")!, port: 1, token: "sekret")
    Harness.check(!String(describing: info).contains("sekret") && !String(reflecting: info).contains("sekret"), "DaemonInfo hides its token")
    Harness.equal((try? DaemonInfo.parseHandshake(#"{"url":"http://127.0.0.1:4800","port":4800,"token":"t","backends":{"codex":{"available":true,"loggedIn":false}},"maxParallel":2}"#))?.backends["codex"]?.summary,
                  "not signed in", "handshake backends")
    Harness.check((try? DaemonInfo.parseHandshake(#"{"url":"http://example.com","token":"t"}"#)) == nil, "handshake must be loopback")
    Harness.check((try? DaemonInfo.parseHandshake("Panel: http://127.0.0.1")) == nil, "handshake must be JSON")
}

// MARK: - Claim tags (standalone, hostile)

@MainActor
func claimChecks() {
    Harness.section("Claim tags")
    let segs = ClaimTags.segments("A <claim id=\"c1\" src=\"a,b\">**new** at £279</claim> deal.")
    Harness.equal(segs.map(\.text), ["A ", "**new** at £279", " deal."], "segments")
    Harness.equal(segs[1].claim, ClaimRef(id: "c1", src: ["a", "b"]), "claim ref")
    Harness.equal(ClaimTags.segments(""), [], "empty")
    Harness.equal(ClaimTags.stripped("x <claim id=a>y</claim> z"), "x y z", "stripped")
    // Hostile inputs: linear time, never a crash.
    let hostile = [
        String(repeating: "<", count: 200_000),
        String(repeating: "<claim id=a>", count: 20_000),
        String(repeating: "<claim ", count: 30_000),
        "<claim id=a>" + String(repeating: "x", count: 500_000),
        String(repeating: "</claim>", count: 50_000),
        String(repeating: "<claim id=\"" + String(repeating: "a", count: 250), count: 2_000),
    ]
    let start = Date()
    for h in hostile { _ = ClaimTags.segments(h) }
    let took = Date().timeIntervalSince(start)
    Harness.check(took < 5, "hostile inputs (~1.6 MB) parse in \(String(format: "%.2f", took)) s")
    let joined = ClaimTags.segments(hostile[1]).map(\.text).joined()
    Harness.check(joined.count <= hostile[1].count, "segments never invent text")
}
