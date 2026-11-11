import Foundation
import MASOfficeKit

// MARK: - Markdown block parser (cases from panel/tests/model.test.js where they apply)

@MainActor
func markdownChecks() {
    Harness.section("Markdown: blocks, inline, claims, hostile input")
    func paragraph(_ b: [MarkdownBlock]) -> MarkdownInline? {
        if b.count == 1, case .paragraph(let t) = b[0] { return t }
        return nil
    }

    // 'markdown renderer escapes HTML': nothing but text and one bold run; the javascript: link stays a label.
    let hostile = Markdown.parse("Hi <script>alert(1)</script> **b** [x](javascript:alert(1)) <img src=x onerror=alert(1)>")
    let hp = paragraph(hostile)
    Harness.check(hp != nil, "hostile: one paragraph")
    Harness.equal(hp?.plainText, "Hi <script>alert(1)</script> b x) <img src=x onerror=alert(1)>", "hostile: text kept as text (the URL ends at the first `)`, as in the panel)")
    Harness.equal(hp?.spans.filter(\.strong).map(\.text), ["b"], "hostile: bold")
    Harness.check(hp?.spans.allSatisfy { $0.link == nil } == true, "hostile: javascript: is not a link")

    // 'table, headings, lists, links'
    let md = "## Shortlist\n| Shop | Total |\n|---|---:|\n| Currys | **£279** |\n| eBay \"X\" | `£264` |\n\n- one *it*\n- [card](../sources/a.md)\n\n1. first\n2. second"
    let b = Markdown.parse(md)
    Harness.equal(b.count, 4, "blocks: heading, table, list, list")
    if case .heading(let level, let t)? = b.first { Harness.equal("\(level) \(t.plainText)", "2 Shortlist", "heading") } else { Harness.check(false, "heading first") }
    if b.count > 1, case .table(let t) = b[1] {
        Harness.equal(t.header.map(\.plainText), ["Shop", "Total"], "table header")
        Harness.equal(t.alignments, [.leading, .trailing], "table alignment ---:")
        Harness.equal(t.rows.map { $0.map(\.plainText) }, [["Currys", "£279"], ["eBay \"X\"", "£264"]], "table rows")
        Harness.equal(t.rows[0][1].spans.first?.strong, true, "bold in a cell")
        Harness.equal(t.rows[1][1].spans.first?.code, true, "code in a cell")
    } else { Harness.check(false, "table second") }
    if b.count > 2, case .list(let l) = b[2] {
        Harness.check(!l.ordered, "unordered list")
        Harness.equal(l.items.map(\.content.plainText), ["one it", "card"], "list items")
        Harness.equal(l.items[0].content.spans.last?.emphasis, true, "italic in an item")
        Harness.check(l.items[1].content.spans.allSatisfy { $0.link == nil }, "relative link: label only (http/https links only)")
    } else { Harness.check(false, "list third") }
    if b.count > 3, case .list(let l) = b[3] {
        Harness.check(l.ordered, "ordered list")
        Harness.equal(l.items.map(\.content.plainText), ["first", "second"], "ordered items")
    } else { Harness.check(false, "ordered list fourth") }

    // Links
    let link = paragraph(Markdown.parse("See [the **page**](https://example.com/a \"title\") now"))
    Harness.equal(link?.spans.filter { $0.link != nil }.map(\.text), ["the ", "page"], "link label runs")
    Harness.equal(link?.spans.first { $0.link != nil }?.link?.absoluteString, "https://example.com/a", "https link kept")
    for bad in ["[x](file:///etc/passwd)", "[x](//evil.com)", "[x](data:text/html,hi)", "[x](mailto:a@b.c)"] {
        Harness.check(paragraph(Markdown.parse(bad))?.spans.allSatisfy { $0.link == nil } == true, "not a link: \(bad)")
    }
    Harness.equal(paragraph(Markdown.parse("![alt](https://example.com/i.png)"))?.plainText, "!alt", "no images: alt text only")

    // Nested lists and fenced code
    let nested = Markdown.parse("- a\n  - a1\n  - a2\n    1. deep\n- b\n  continued")
    if case .list(let l)? = nested.first, nested.count == 1 {
        Harness.equal(l.items.map(\.content.plainText), ["a", "b continued"], "nested: top level")
        Harness.equal(l.items[0].children.first?.items.map(\.content.plainText), ["a1", "a2"], "nested: second level")
        Harness.equal(l.items[0].children.first?.items[1].children.first?.ordered, true, "nested: ordered third level")
    } else { Harness.check(false, "nested list parses as one list") }
    let fence = Markdown.parse("Text\n```swift\nlet a = \"<b>\" // **not bold**\n\n```\nAfter")
    Harness.equal(fence.count, 3, "fence: paragraph, code, paragraph")
    if fence.count == 3, case .code(let lang, let text) = fence[1] {
        Harness.equal(lang, "swift", "fence language")
        Harness.equal(text, "let a = \"<b>\" // **not bold**\n", "fence text verbatim")
    }
    if case .code(_, let text)? = Markdown.parse("~~~\nunclosed").first { Harness.equal(text, "unclosed", "unclosed fence runs to the end") }
    Harness.equal(Markdown.parse("a\n\n---\n\n> quoted\n> more").count, 3, "rule and quote")

    // Claims (the panel's claim-tag cases)
    let claim = paragraph(Markdown.parse("A <claim id=\"c1\" src=\"a,b\">**new** at £279</claim> deal."))
    Harness.equal(claim?.spans.map(\.text), ["A ", "new", " at £279", " deal."], "claim: runs")
    Harness.equal(claim?.spans.map { $0.claim?.id ?? "-" }, ["-", "c1", "c1", "-"], "claim: span ids")
    Harness.equal(claim?.spans[1].strong, true, "claim: markdown inside still works")
    Harness.equal(claim?.claims.first?.src, ["a", "b"], "claim: cited sources")
    if case .table(let t)? = Markdown.parse("| a | b |\n|---|---|\n| <claim id=\"c2\">cell</claim> | y |").first {
        Harness.equal(t.rows[0][0].spans.first?.claim?.id, "c2", "claim in a table cell")
    }
    Harness.equal(paragraph(Markdown.parse("<CLAIM ID=\"c3\">upper</CLAIM>"))?.spans.first?.claim?.id, "c3", "claim tags are case-insensitive")
    let cases: [(String, String, [String])] = [
        ("<claim id='x\" onmouseover=\"alert(1)'>t</claim>", "<claim id='x\" onmouseover=\"alert(1)'>t</claim>", []),
        ("<claim id=x><script>alert(1)</script>", "<claim id=x><script>alert(1)</script>", []),
        ("<claim id=a>outer <claim id=b>inner</claim> tail</claim>", "<claim id=a>outer inner tail</claim>", ["b"]),
        ("</claim> stray", "</claim> stray", []),
        ("<claim>no id</claim>", "<claim>no id</claim>", []),
        ("<claim id=\"ok\" onclick=\"x()\">t</claim>", "t", ["ok"]),
        ("<claim id=\"a<b\">t</claim>", "<claim id=\"a<b\">t</claim>", []),
        ("<claimx id=a>t</claim>", "<claimx id=a>t</claim>", []),
    ]
    for (src, text, ids) in cases {
        let p = paragraph(Markdown.parse(src))
        Harness.equal(p?.plainText, text, "hostile claim text: \(src)")
        Harness.equal(p?.claims.map(\.id), ids, "hostile claim ids: \(src)")
    }

    // The fixture result and the examples parse
    let fx = Harness.twin(Harness.repo.appendingPathComponent("panel/tests/fixtures/mock-supervise/deals/outputs/result.js")).globals["MAS_RESULT"]
    let r = ResultDoc(json: fx ?? .null)
    let blocks = Markdown.parse(r.markdown)
    let all = blocks.flatMap { b -> [MarkdownInline] in
        switch b {
        case .paragraph(let t), .heading(_, let t), .quote(let t): return [t]
        case .table(let t): return t.header + t.rows.flatMap { $0 }
        default: return []
        }
    }
    Harness.equal(all.flatMap(\.claims).map(\.id), ["c1", "c2", "c3", "c4", "c5", "c6"], "fixture: claims in table cells and notes")
    Harness.check(Markdown.plainText(blocks).contains("<img src=x onerror=alert(1)>"), "fixture: hostile tail stays text")
    for ex in ["price-compare", "trip-planning"] {
        let f = Harness.repo.appendingPathComponent("examples/\(ex)/outputs/result.js")
        guard FileManager.default.fileExists(atPath: f.path) else { continue }
        let doc = ResultDoc(json: Harness.twin(f).globals["MAS_RESULT"] ?? .null)
        Harness.check(Markdown.plainText(Markdown.parse(doc.markdown)).count > 100, "example \(ex) renders")
    }

    // Table columns: natural when they fit, shrink toward the longest word, else scroll.
    Harness.equal(MarkdownTableLayout.fit(natural: [100, 200], minimum: [50, 60], available: 400), MarkdownTableLayout(widths: [100, 200], scrolls: false), "table fits")
    let shrunk = MarkdownTableLayout.fit(natural: [100, 300], minimum: [50, 60], available: 250)
    Harness.check(!shrunk.scrolls && shrunk.widths.reduce(0, +) <= 250 && shrunk.widths[0] >= 50 && shrunk.widths[1] >= 60, "table wraps: \(shrunk.widths)")
    Harness.equal(MarkdownTableLayout.fit(natural: [300, 300, 300], minimum: [120, 120, 120], available: 300).scrolls, true, "table scrolls")

    // Linear time on 500 KB of hostile input (claims and markdown)
    var deep = ""
    for k in 0..<700 { deep += String(repeating: " ", count: k * 2) + "- x\n" }
    let inputs: [(String, String)] = [
        ("<claim ", String(repeating: "<claim ", count: 75000)),
        ("<claim id=a>", String(repeating: "<claim id=a>", count: 45000)),
        ("claims", String(repeating: "<claim id=\"c1\">x</claim> ", count: 20000)),
        ("<", String(repeating: "<", count: 500_000)),
        ("long id", String(repeating: "<claim id=\"" + String(repeating: "a", count: 280), count: 1700)),
        ("**", String(repeating: "**a", count: 160_000)),
        ("*", String(repeating: "*", count: 500_000)),
        ("_a", String(repeating: "_a ", count: 160_000)),
        ("[", String(repeating: "[", count: 500_000)),
        ("[a](", String(repeating: "[a](x", count: 100_000)),
        ("[[[...](", String(repeating: "[", count: 250_000) + "](" + String(repeating: "u", count: 250_000)),
        ("`", String(repeating: "`a", count: 250_000)),
        ("| table", "| a | b |\n|---|---|\n" + String(repeating: "| x | y |\n", count: 50_000)),
        ("lists", String(repeating: "- a\n  - b\n", count: 25_000)),
        ("deep list", deep),
        ("fences", String(repeating: "```\n", count: 100_000)),
    ]
    for (name, s) in inputs {
        let t = Date()
        _ = Markdown.parse(s)
        let ms = Date().timeIntervalSince(t) * 1000
        Harness.check(ms < 3000, "linear: \(name) took \(Int(ms)) ms")
    }
}

// MARK: - Claim underline segmentation, credibility, export

@MainActor
func resultChecks() {
    Harness.section("Result: claim spans, popover detail, caught, sources, export")
    let deals = Harness.repo.appendingPathComponent("panel/tests/fixtures/mock-supervise/deals")
    func doc(_ rel: String, _ global: String) -> JSONValue? { Harness.twin(deals.appendingPathComponent(rel)).globals[global] }
    let r = ResultDoc(json: doc("outputs/result.js", "MAS_RESULT") ?? .null)
    let v = Verification(json: doc("outputs/verification.js", "MAS_VERIFICATION") ?? .null)
    let board = Board(json: doc("mas/board.js", "MAS_BOARD") ?? .null)
    let s = Structure(json: doc("mas/structure.js", "MAS_STRUCTURE") ?? .null)
    let nameOf = { (id: String) in s.name(of: id) }

    // Each claim span carries the claim's status (what the underline style is chosen from).
    let statuses = v.statusByClaim
    let spans = Markdown.parse(r.markdown).flatMap { b -> [MarkdownSpan] in
        switch b {
        case .paragraph(let t): return t.spans
        case .table(let t): return t.rows.flatMap { $0 }.flatMap(\.spans)
        default: return []
        }
    }
    let byId = Dictionary(spans.compactMap { sp in sp.claim.map { ($0.id, statuses[$0.id] ?? .unchecked) } }, uniquingKeysWith: { a, _ in a })
    Harness.equal(byId["c1"], .supported, "c1 underline: supported")
    Harness.equal(byId["c2"], .partial, "c2 underline: partial")
    Harness.equal(byId["c3"], .contradicted, "c3 underline: contradicted")
    Harness.equal(byId["c4"], .unknown, "c4 underline: unknown")
    Harness.equal(byId["c5"], .unchecked, "c5 underline: unchecked")
    Harness.equal(byId["x\" onmouseover=\"alert(1)"], nil, "hostile id is not a claim")

    let c3 = ClaimDetail(claimId: "c3", verification: v, result: r)
    Harness.equal(c3?.status, .contradicted, "detail status")
    Harness.equal(c3?.verdicts.map(\.status), [.contradicted, .supported], "detail verdicts")
    Harness.equal(c3?.sources.first?.grade, .A, "cited source grade")
    Harness.equal(c3?.sources.first?.url?.host, "www.ebay.co.uk", "cited source link")
    Harness.check(ClaimDetail(claimId: "nope", verification: v, result: r) == nil, "unknown claim: no detail")

    let cred = Credibility(v.summary)
    Harness.equal(cred.text, "6 claims · 1 supported · 1 partial · 1 contradicted · 1 unknown · 1 unchecked · links: 3 live, 1 dead, 1 blocked", "credibility line")

    let caught = CheckersCaught(verification: v, board: board, nameOf: nameOf)
    Harness.equal(caught.items.map(\.word), ["contradicted", "unknown", "sent back"], "what the checkers caught")
    Harness.check(caught.items[0].notes.first?.hasPrefix("Catch checker: ") == true, "caught: names resolved")

    let rows = SourceRow.rows(result: r, verification: v, nameOf: nameOf)
    Harness.equal(rows.map(\.grade), [.A, .A, .A, .C], "source grades")
    Harness.equal(rows.first?.foundBy, "Retail finder", "found by name")

    let md = ResultExport.markdown(r, verification: v, nameOf: nameOf)
    Harness.check(!md.contains("<claim id=\"c") && !md.contains("free delivery</claim>"), "export: claim tags stripped (malformed ones stay text, as shown)")
    Harness.check(md.hasPrefix("# Headphone deals — run 1\n"), "export: title")
    Harness.check(md.contains("_Checked claims: 6 claims"), "export: checked-claims line")
    Harness.check(md.contains("- [A] [Sony WH-1000XM6 — Currys](https://www.currys.co.uk/products/sony-wh1000xm6) — found by Retail finder"), "export: sources")
    Harness.equal(ResultExport.fileName("Deals: a/b \"x\""), "Deals- a-b -x.md", "export file name")
    Harness.equal(ResultExport.fileName("  "), "Result.md", "export file name fallback")

    // Run info
    Harness.equal(RunInfo.ledgerLine(board.ledger, nameOf: nameOf), "Progressing · next: Catch checker", "ledger line")
    let total = RunInfo.usageTotal(board.usage)
    Harness.check(total?.text.hasSuffix("across 4 agents") == true, "usage total: \(total?.text ?? "nil")")
    Harness.equal(RunInfo.compact(12345), "12k", "compact 12k")
    Harness.equal(RunInfo.compact(1234), "1.2k", "compact 1.2k")
    Harness.equal(RunInfo.elapsedText(3900), "1 h 05 min", "elapsed")
    Harness.equal(RunInfo.stages(s, statuses: [:]).map(\.label), ["Search", "Check"], "stages")
    Harness.equal(RunInfo.backendsUsed(s), ["claude-code", "codex"], "backends used")
    Harness.equal(RunInfo.sessionsText(s), "4 sessions: 2 on Claude Code, 2 on Codex, each on your own sign-in.", "sessions text")
    let ready = SessionInfo(json: ["token": true, "runtime": true, "backends": ["claude-code": ["available": true, "loggedIn": true],
                                                                                 "codex": ["available": true, "loggedIn": false]]])
    Harness.equal(RunInfo.startBlocker(session: ready, actReason: nil, structure: s, runActive: false),
                  "Codex is not signed in: run codex login in Terminal.", "start blocked: backend not signed in")
    var unlocked = s
    unlocked.locked = false
    Harness.equal(RunInfo.startBlocker(session: ready, actReason: nil, structure: unlocked, runActive: false), "Lock the team design before running it.", "start blocked: not locked")
    Harness.equal(RunInfo.startBlocker(session: ready, actReason: "No project is selected.", structure: s, runActive: false), "No project is selected.", "start blocked: read-only")
}

// MARK: - Team design text, CLI problems, example team

@MainActor
func teamChecks() async {
    Harness.section("Team: sentences, check output, example project, CLI")
    let ex = Harness.twin(Harness.repo.appendingPathComponent("examples/price-compare/mas/structure.js")).globals["MAS_STRUCTURE"] ?? .null
    let s = Structure(json: ex)
    Harness.equal(s.delegate.map { TeamDesignText.delegationSentence($0, structure: s) }, ["Approve web search automatically."], "delegation sentence")
    let rule: JSONValue = ["effect": "lead", "kind": "approval", "tools": ["web search", "browse the web"], "roles": ["catch-checker"], "max": 3]
    Harness.equal(TeamDesignText.delegationSentence(rule, structure: s), "The Lead may approve web search and browse the web for Catch checker, up to 3 times.", "lead rule")
    Harness.equal(TeamDesignText.toolSentences([ToolGrant(name: "web search"), ToolGrant(name: "browse the web", effect: .ask), ToolGrant(name: "run commands", effect: .deny)]).map(\.text),
                  ["Uses web search.", "Asks you first: browse the web.", "Not allowed: run commands."], "tool sentences")
    Harness.equal(TeamDesignText.budgetSentences(s.budget), ["At most 2 roles work at once."], "budget")
    Harness.equal(TeamDesignText.gateSentence(s.gates[0], structure: s), "After Search in parallel: Look at the offers before they are checked. The team waits for you.", "gate")
    Harness.equal(TeamDesignText.signaturePrefix(s.signature), "sha256:f4a5b427a67a…", "signature prefix")
    Harness.equal(TeamDesignText.relationSentences(s.role("catch-checker")!, structure: s).last,
                  "Checks the work of Sony deal finder and Similar-model finder in a clean context (it does not see how the work was made).", "reviewer relation")

    let out = "✗ /roles/1/backend: backend must be one of claude-code, codex\n! /roles/2/backend: this reviewer uses the same backend\n\n1 error: the team cannot be locked yet."
    let problems = TeamProblem.parse(out)
    Harness.equal(problems.map(\.level), [.error, .warning], "problem levels")
    Harness.equal(problems.first?.path, "/roles/1/backend", "problem path")
    Harness.equal(problems.first?.place(in: s), "Similar-model finder · backend", "problem place")

    // The example becomes an unlocked project listed in home/projects.
    let ws = Harness.scratch("example-ws")
    try? FileManager.default.createDirectory(at: ws.appendingPathComponent("home"), withIntermediateDirectories: true)
    let src = Harness.repo.appendingPathComponent("examples/price-compare/mas/structure.js")
    do {
        let p1 = try ExampleTeam.create(in: ws, from: src)
        let p2 = try ExampleTeam.create(in: ws, from: src)
        Harness.equal([p1.lastPathComponent, p2.lastPathComponent], ["price-compare", "price-compare-2"], "example folders")
        let made = Structure(json: (try? JSONValue.parse(Data(contentsOf: p1.appendingPathComponent("mas/structure.json")))) ?? .null)
        Harness.check(!made.locked && made.signature == nil, "example is unlocked")
        Harness.equal(made.roles.count, 4, "example roles")
        let twin = Structure(json: Harness.twin(p1.appendingPathComponent("mas/structure.js")).globals["MAS_STRUCTURE"] ?? .null)
        Harness.equal(twin.title, made.title, "structure .js twin")
        let home = ProjectsIndex(json: Harness.twin(ws.appendingPathComponent("home/projects.js")).globals["MAS_HOME"] ?? .null)
        Harness.equal(home.projects.map(\.folder), ["price-compare", "price-compare-2"], "projects index")
        Harness.equal(home.current, "price-compare-2", "current project")

        // The real CLI through Node (no sessions): check, then lock, then check again.
        if let node = Harness.node {
            let script = Harness.repo.appendingPathComponent("packages/node/bin/mas-office.js")
            let env = ProcessInfo.processInfo.environment
            let check = await TeamCLI.run(.check, project: p1, workspace: ws, node: node, script: script, environment: env)
            Harness.check(check.ok, "team check passes: \(check.summary) \(check.output)")
            Harness.check(check.summary.contains("valid"), "check summary: \(check.summary)")
            let lock = await TeamCLI.run(.lock, project: p1, workspace: ws, node: node, script: script, environment: env)
            Harness.check(lock.ok && lock.summary.hasPrefix("Locked"), "team lock: \(lock.summary)")
            let locked = Structure(json: (try? JSONValue.parse(Data(contentsOf: p1.appendingPathComponent("mas/structure.json")))) ?? .null)
            Harness.check(locked.locked && locked.signature?.hasPrefix("sha256:") == true, "locked with a signature")
            // A broken design reports its problems as errors.
            var broken = (try? JSONValue.parse(Data(contentsOf: p2.appendingPathComponent("mas/structure.json")))) ?? .null
            if case .object(var o) = broken, case .array(var roles)? = o["roles"], case .object(var r0) = roles[0] {
                r0["backend"] = "gpt-9"
                roles[0] = .object(r0)
                o["roles"] = .array(roles)
                broken = .object(o)
            }
            try? Data(broken.jsonText(pretty: true).utf8).write(to: p2.appendingPathComponent("mas/structure.json"))
            let bad = await TeamCLI.run(.check, project: p2, workspace: ws, node: node, script: script, environment: env)
            Harness.check(!bad.ok && bad.errors.contains { $0.path == "/roles/0/backend" }, "broken design: error at /roles/0/backend (\(bad.output))")
            let missing = await TeamCLI.run(.check, project: ws.appendingPathComponent("nope"), workspace: ws, node: node, script: script, environment: env)
            Harness.check(!missing.ok && missing.summary.contains("No team design"), "no design: stderr kept (\(missing.summary))")
        } else {
            Harness.note("node not found: CLI checks skipped")
        }
    } catch {
        Harness.check(false, "example project: \(error)")
    }
}

// MARK: - Setup checklist, settings validation, engine log

@MainActor
func setupChecks() {
    Harness.section("Setup: checklist states, settings validation, redacted log")
    let ex = Structure(json: Harness.twin(Harness.repo.appendingPathComponent("examples/price-compare/mas/structure.js")).globals["MAS_STRUCTURE"] ?? .null)
    let node = NodeCheck.found(URL(fileURLWithPath: "/opt/homebrew/bin/node"), NodeVersion(22, 1, 0))
    let info = DaemonInfo(url: URL(string: "http://127.0.0.1:4747")!, port: 4747, token: "t")
    func backends(_ codexIn: Bool) -> [String: BackendStatus] {
        ["claude-code": BackendStatus(available: true, loggedIn: true, version: "2.1.0"), "codex": BackendStatus(available: true, loggedIn: codexIn)]
    }
    let base = SetupCheck.Input(nodeCheck: node, daemon: .running(info), runtime: true, backends: backends(true),
                                workspace: URL(fileURLWithPath: "/Users/x/MAS Office"), hasProject: true, structure: ex)
    let allReady = SetupCheck.items(base)
    Harness.check(SetupCheck.allReady(allReady), "all ready: \(allReady.filter { $0.state != .ready }.map(\.id))")
    Harness.equal(SetupCheck.summary(allReady), "Everything is ready.", "all ready summary")

    var noCodex = base
    noCodex.backends = backends(false)
    let nc = SetupCheck.items(noCodex)
    let codex = nc.first { $0.id == "codex" }
    Harness.equal(codex?.state, .missing, "Codex not signed in: the team uses it, so it is required")
    Harness.equal(codex?.action, .command("codex login"), "Codex: the vendor's own command")
    Harness.check(!SetupCheck.allReady(nc), "not all ready")
    var claudeOnly = ex
    claudeOnly.roles = claudeOnly.roles.map { var r = $0; r.backend = nil; return r }
    noCodex.structure = claudeOnly
    let unused = SetupCheck.items(noCodex).first { $0.id == "codex" }
    Harness.equal(unused?.state, .attention, "Codex not signed in but unused: attention, not blocking")
    Harness.check(SetupCheck.allReady(SetupCheck.items(noCodex)), "an unused backend does not block")

    var noNode = base
    noNode.nodeCheck = .missing
    noNode.daemon = .failed(.nodeNotFound)
    noNode.backends = nil
    noNode.runtime = nil
    let nn = SetupCheck.items(noNode)
    Harness.equal(nn.first { $0.id == "node" }?.action, .command("brew install node"), "Node missing: how to install")
    Harness.equal(nn.first { $0.id == "engine" }?.state, .missing, "engine failed")
    Harness.equal(nn.first { $0.id == "claude-code" }?.state, .pending, "backends wait for the engine")
    Harness.equal(SetupCheck.summary(nn), "2 things to do", "summary counts")

    var fresh = SetupCheck.Input()
    fresh.daemon = .notStarted
    let f = SetupCheck.items(fresh)
    Harness.equal(f.first?.action, .chooseWorkspace, "first launch: choose a workspace")
    Harness.equal(f.first { $0.id == "team" }?.action, .createExample, "first launch: create from example")
    var draft = base
    var d = ex
    d.locked = false
    draft.structure = d
    Harness.equal(SetupCheck.items(draft).first { $0.id == "team" }?.action, .lockTeam, "draft team: lock")
    Harness.check(SetupCheck.items(draft).allSatisfy { $0.title.range(of: "login", options: .caseInsensitive) == nil }, "no login rows")

    // Settings validation
    Harness.equal(SettingsValidation.clampSessions(0), 1, "sessions min")
    Harness.equal(SettingsValidation.clampSessions(40), 12, "sessions max")
    Harness.equal(SettingsValidation.nodePathProblem("node"), .notAbsolute, "node path: relative")
    Harness.equal(SettingsValidation.nodePathProblem("/nonexistent/node"), .missing, "node path: missing")
    Harness.equal(SettingsValidation.nodePathProblem("/usr/bin"), .isDirectory, "node path: folder")
    Harness.equal(SettingsValidation.nodePathProblem("/etc/hosts"), .notExecutable, "node path: not executable")
    Harness.equal(SettingsValidation.nodePathProblem("/bin/ls"), nil, "node path: executable")

    // The engine log never holds the token.
    let token = String(repeating: "ab12", count: 16)
    Harness.equal(DaemonLog.redact("open http://127.0.0.1:1/office/?token=\(token)", secret: nil), "open http://127.0.0.1:1/office/?token=<redacted>", "redact token=")
    Harness.equal(DaemonLog.redact("Authorization: Bearer \(token)", secret: nil), "Authorization: Bearer <redacted>", "redact bearer")
    Harness.equal(DaemonLog.redact("secret xyz-\("s3cr3t-value") end", secret: "s3cr3t-value"), "secret xyz-<redacted> end", "redact the known token")
    Harness.equal(DaemonLog.redact("raw \(token)", secret: nil), "raw <redacted>", "redact a hex run")
    Harness.equal(DaemonLog.redact("Claude Code 2.1.0: ready", secret: "t0k3n-abc"), "Claude Code 2.1.0: ready", "ordinary lines unchanged")
    let logURL = Harness.scratch("log").appendingPathComponent("engine.log")
    let log = DaemonLog(url: logURL)
    log.write("Panel: http://127.0.0.1:9/office/?token=\(token)")
    log.flush()
    let written = (try? String(contentsOf: logURL, encoding: .utf8)) ?? ""
    Harness.check(written.contains("token=<redacted>") && !written.contains(token), "log file is redacted")
}
