import AppKit
import MASOfficeKit
import SwiftUI

/// `--ui-behaviour <report.json>` (with `--workspace <dir>` of an attached scripted daemon): drives the run
/// controls' intents, the export, the team check and the setup checklist against a scripted daemon (fake backends,
/// no real sessions), writes what happened, then quits.
@MainActor
enum ChromeChecks {
    static var reportPath: String? {
        let a = CommandLine.arguments
        guard let i = a.firstIndex(of: "--ui-behaviour"), i + 1 < a.count else { return nil }
        return a[i + 1]
    }

    static func run(path: String) async {
        let app = Shared.app, store = app.store
        var report: [String: Any] = [:]
        func wait(_ seconds: Double, _ ok: () -> Bool) async -> Bool {
            let end = Date().addingTimeInterval(seconds)
            while Date() < end {
                if ok() { return true }
                try? await Task.sleep(for: .milliseconds(100))
            }
            return ok()
        }
        report["connected"] = await wait(20) { store.structure != nil && store.session != nil }
        report["project"] = store.currentProject ?? NSNull()

        // Setup checklist from the live engine.
        let live = SetupCheck.items(OnboardingView.input(app: app, store: store))
        report["setupLive"] = live.map { ["id": $0.id, "state": $0.state.rawValue] }
        report["setupLiveReady"] = SetupCheck.allReady(live)

        // Start a run through the run controls' intent.
        let blocker = RunInfo.startBlocker(session: store.session, actReason: store.actReason, structure: store.structure, runActive: store.isRunActive)
        report["startBlocker"] = blocker ?? NSNull()
        let started = await RunIntents.send(.newRun, text: "Find the best Sony XM6 offer", store: store)
        report["start"] = "\(started)"
        report["runActive"] = await wait(10) { store.isRunActive }

        // The scripted finder-b asks for web search, then waits for a steering message.
        var approved = false, steered = false
        let finished = await wait(90) {
            if !approved, let item = store.arrangedInbox.human.first(where: { $0.request.agentId == "finder-b" && $0.request.kind == "approval" }),
               let allow = item.request.options.first(where: \.isAllow) {
                approved = true
                Task { await store.answer(item.request, option: allow) }
            }
            if approved, !steered, store.accepts("finder-b", "message"), store.status(of: "finder-b")?.state.isBusy == true {
                steered = true
                Task { await store.sendMessage(to: "finder-b", text: "Prefer sellers with UK stock.") }
            }
            return store.snapshot.result != nil && !store.isRunActive
        }
        report["approved"] = approved
        report["steered"] = steered
        report["resultArrived"] = finished
        report["resultTitle"] = store.snapshot.result?.title ?? NSNull()
        report["credibility"] = store.credibility?.text ?? NSNull()

        // Follow-up after the result.
        let rounds = store.snapshot.result?.rounds.count ?? 0
        let follow = await RunIntents.send(.followUp, text: "Is Currys still the best offer?", store: store)
        report["followUp"] = "\(follow)"
        report["followUpRound"] = await wait(60) { (store.snapshot.result?.rounds.count ?? 0) > rounds && !store.isRunActive }
        report["rounds"] = store.snapshot.result?.rounds.count ?? 0

        // Export the result exactly as the file exporter writes it.
        if let r = store.snapshot.result {
            let doc = B_MarkdownFile(text: ResultExport.markdown(r, verification: store.snapshot.verification, nameOf: store.displayName))
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("mas-office-ui-check-\(ProcessInfo.processInfo.processIdentifier)")
                .appendingPathComponent(ResultExport.fileName(r.title))
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = Data(doc.text.utf8)
            do {
                try data.write(to: url)
                let back = try String(contentsOf: url, encoding: .utf8)
                report["exportPath"] = url.path
                report["exportBytes"] = data.count
                report["exportHasClaimTags"] = back.contains("<claim")
                report["exportHasRound2"] = back.contains("## Round 2")
                report["exportHead"] = String(back.prefix(160))
            } catch {
                report["exportError"] = error.localizedDescription
            }
        }

        // Team check on the scripted workspace.
        if let p = store.currentProject {
            let o = await app.runTeamCommand(.check, project: p)
            report["teamCheck"] = ["ok": o.ok, "summary": o.summary, "errors": o.errors.count, "warnings": o.warnings.count] as [String: Any]
        }
        report["stopRunTargetsAfter"] = store.stopRunTargets
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
        }
        NSApp.terminate(nil)
    }
}
