import MASOfficeKit
import SwiftUI

/// Starting, following and stopping runs. The full form is the run sheet (File ▸ New Run… ⌘N, Ask Follow-up…
/// ⇧⌘N); a compact form sits at the bottom of the sidebar and a pill in the toolbar.
///
/// - No active run: the task editor, disabled with the reason when the team is read-only, not locked, or a
///   backend it uses is not ready.
/// - During a run: phase, stage progress, the Lead's ledger line, usage across agents, elapsed time, Stop Run.
/// - After a result: Ask a follow-up (or start a new run).
struct RunControlsView: View {
    /// What to show when there is a result and no run: a follow-up (default) or a new task.
    var mode: RunSheetMode?
    /// Set when shown in a sheet: Cancel and a successful start call it.
    var onDone: (() -> Void)?

    @Environment(OfficeStore.self) private var store

    var body: some View {
        if store.isRunActive {
            RunProgressView(onDone: onDone)
        } else if store.snapshot.result != nil, mode != .newRun {
            RunEditor(kind: .followUp, onDone: onDone)
        } else {
            RunEditor(kind: .newRun, onDone: onDone)
        }
    }
}

/// The run sheet.
struct RunSheet: View {
    var mode: RunSheetMode
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        RunControlsView(mode: mode, onDone: { dismiss() })
            .padding(20)
            .frame(width: 540)
    }
}

/// Start and follow-up intents with the panel's wording; the editor and the behaviour check use them.
@MainActor
enum RunIntents {
    enum Outcome: Equatable {
        case started(String)
        case failed(String)
    }

    static func send(_ kind: RunSheetMode, text: String, store: OfficeStore) async -> Outcome {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return .failed("Write something first.") }
        let r = kind == .followUp ? await store.followUp(question: t) : await store.startRun(task: t)
        if r != nil {
            store.dismissError()
            return .started(kind == .followUp ? "Asked. The Lead is reading your question." : "Started. The team is getting to work.")
        }
        let why = store.lastError ?? "no answer from the engine"
        store.dismissError()
        return .failed("Not started: " + why)
    }
}

extension OfficeStore {
    /// The agents Stop Run stops: the Lead (stopping it stops the run) and everyone busy, if they take it.
    var stopRunTargets: [String] {
        var seen = Set<String>()
        return (["lead"] + busyAgentIds).filter { seen.insert($0).inserted && accepts($0, "interrupt") }
    }

    /// Stop the run: ask the Lead and every busy agent to stop their current turn.
    func stopRun() async {
        for id in stopRunTargets { await interrupt(id) }
    }
}

/// The task or follow-up editor.
private struct RunEditor: View {
    var kind: RunSheetMode
    var onDone: (() -> Void)?

    @Environment(OfficeStore.self) private var store
    @Environment(WindowState.self) private var ui
    @ViewState private var text = ""
    @ViewState private var sending = false
    @ViewState private var outcome: RunIntents.Outcome?
    @FocusState private var focused: Bool

    private static let limit = 4000

    var body: some View {
        let blocker = kind == .followUp ? followUpBlocker : RunInfo.startBlocker(session: store.session, actReason: store.actReason,
                                                                                    structure: store.structure, runActive: store.isRunActive)
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(kind == .followUp ? "Ask a follow-up" : "Give the team a task")
                    .font(.title2.weight(.semibold))
                Text(subtitle).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            ZStack(alignment: .topLeading) {
                TextEditor(text: $text)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .focused($focused)
                    .disabled(blocker != nil || sending)
                    .accessibilityLabel(kind == .followUp ? "Follow-up question" : "Task for the team")
                if text.isEmpty {
                    Text(kind == .followUp ? "A question about the result, e.g. Which offer arrives soonest?"
                         : "What should the team find out? e.g. The three best UK offers for Sony WH-1000XM6, new, delivered within 3 days.")
                        .foregroundStyle(.tertiary)
                        .padding(.leading, 5)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .padding(8)
            .frame(minHeight: kind == .followUp ? 80 : 120)
            .background(RoundedRectangle(cornerRadius: 7).fill(Color(nsColor: .textBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(focused ? Color.accentColor.opacity(0.7) : Color(nsColor: .separatorColor),
                                                                    lineWidth: focused ? 2 : 1))
            .onChange(of: text) { _, t in if t.count > Self.limit { text = String(t.prefix(Self.limit)) } }

            if let blocker {
                Label(blocker, systemImage: "info.circle")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let outcome {
                switch outcome {
                case .started(let s): Label(s, systemImage: "checkmark.circle").foregroundStyle(B_ClaimStyle.color(.supported))
                case .failed(let s): Label(s, systemImage: "exclamationmark.triangle").foregroundStyle(Color(nsColor: B_ClaimStyle.ochre))
                }
            }
            HStack {
                if kind == .followUp {
                    Button("New Task Instead…") { ui.runSheet = .newRun }
                        .buttonStyle(.link)
                        .disabled(store.structure?.locked != true)
                }
                Spacer()
                if let onDone {
                    Button("Cancel", action: onDone).keyboardShortcut(.cancelAction)
                }
                Button {
                    send()
                } label: {
                    Text(kind == .followUp ? "Ask" : "Start Run").frame(minWidth: 70)
                }
                .keyboardShortcut(.return, modifiers: .command)
                .buttonStyle(.borderedProminent)
                .disabled(blocker != nil || empty || sending)
                .help(blocker ?? (empty ? "Write the task first" : "Start (⌘↩)"))
            }
        }
        .onAppear { focused = true }
    }

    private var subtitle: String {
        let s = store.structure
        let team = s?.title ?? "The team"
        if kind == .followUp {
            return "\(team) answers from the work it already did; the Lead reads your question first."
        }
        return [team, RunInfo.sessionsText(s)].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var followUpBlocker: String? {
        if let r = store.actReason { return r }
        if store.session?.runtime != true { return "This engine only shows the office; it cannot run the team." }
        if store.isRunActive { return "A run is in progress." }
        return nil
    }

    private func send() {
        let t = text
        sending = true
        outcome = nil
        Task {
            let o = await RunIntents.send(kind, text: t, store: store)
            sending = false
            outcome = o
            if case .started = o {
                text = ""
                if let onDone {
                    try? await Task.sleep(for: .milliseconds(700))
                    onDone()
                }
            }
        }
    }
}

/// What the run is doing: phase, stages, the Lead's ledger, usage, elapsed time, Stop Run.
private struct RunProgressView: View {
    var onDone: (() -> Void)?
    @Environment(OfficeStore.self) private var store
    @Environment(WindowState.self) private var ui

    var body: some View {
        let stages = RunInfo.stages(store.structure, statuses: store.statuses)
        let ledger = RunInfo.ledgerLine(store.snapshot.board?.ledger, nameOf: store.displayName)
        let usage = RunInfo.usageTotal(store.snapshot.board?.usage ?? [:])
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text("Run in progress").font(.title2.weight(.semibold))
                Spacer()
                RunElapsed().font(.callout.monospacedDigit()).foregroundStyle(.secondary)
            }
            if let task = store.snapshot.task?.title ?? store.snapshot.task?.summary {
                Text(task).font(.callout).foregroundStyle(.secondary).lineLimit(3)
            }
            if !stages.isEmpty {
                VStack(alignment: .leading, spacing: 9) {
                    ForEach(stages) { s in StageRow(stage: s) }
                }
            }
            if !ledger.isEmpty {
                LabeledContent("Lead") { Text(ledger).textSelection(.enabled) }
            }
            if let usage {
                LabeledContent("Usage") { Text(usage.text).monospacedDigit() }
                ForEach(usage.warnings, id: \.agentId) { w in
                    Label("\(store.displayName(w.agentId)): \(w.text)", systemImage: "exclamationmark.triangle")
                        .font(.callout)
                        .foregroundStyle(Color(nsColor: B_ClaimStyle.ochre))
                }
                Text("Usage is what your own plans report; MAS Office never pays for or pools it.")
                    .font(.caption).foregroundStyle(.tertiary)
            }
            HStack {
                Spacer()
                if let onDone { Button("Close", action: onDone).keyboardShortcut(.cancelAction) }
                Button("Stop Run…", role: .destructive) { ui.confirmStopRun = true }
                    .disabled(store.stopRunTargets.isEmpty)
                    .help(store.stopRunTargets.isEmpty ? "This engine cannot stop the run from here." : "Stop the Lead and every working role (⌘.)")
            }
        }
    }
}

/// One stage: number, label, how many roles are done, a bar.
private struct StageRow: View {
    var stage: RunInfo.Stage

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle().strokeBorder(Color(nsColor: .separatorColor), lineWidth: 1)
                if stage.isComplete {
                    Image(systemName: "checkmark").font(.caption2.weight(.bold)).foregroundStyle(B_ClaimStyle.color(.supported))
                } else {
                    Text("\(stage.number)").font(.caption2.weight(.semibold).monospacedDigit())
                        .foregroundStyle(stage.busy > 0 ? Color.accentColor : .secondary)
                }
            }
            .frame(width: 20, height: 20)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(stage.label).font(.callout.weight(stage.busy > 0 ? .semibold : .regular))
                    if stage.needsYou > 0 {
                        Image(systemName: "hand.raised.fill").foregroundStyle(Palette.verm).font(.caption)
                            .accessibilityLabel("\(stage.needsYou) waiting on you")
                    }
                    Spacer()
                    Text("\(stage.done) of \(stage.memberIds.count) done").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                ProgressView(value: Double(stage.done), total: Double(max(1, stage.memberIds.count)))
                    .progressViewStyle(.linear)
                    .tint(stage.isComplete ? B_ClaimStyle.color(.supported) : .accentColor)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Stage \(stage.number), \(stage.label): \(stage.done) of \(stage.memberIds.count) done" + (stage.busy > 0 ? ", working" : ""))
    }
}

/// Elapsed time of the current run, ticking on its own.
struct RunElapsed: View {
    @Environment(OfficeStore.self) private var store

    var body: some View {
        if let start = RunInfo.startedAt(store.snapshot.board) {
            B_Ticking { now in Text(RunInfo.elapsedText(now.timeIntervalSince(start))) }
                .accessibilityLabel("Elapsed time")
        }
    }
}

/// The compact run controls at the bottom of the sidebar.
struct RunCompactView: View {
    @Environment(OfficeStore.self) private var store
    @Environment(WindowState.self) private var ui

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if store.isRunActive {
                let stages = RunInfo.stages(store.structure, statuses: store.statuses)
                let current = stages.first { !$0.isComplete }
                HStack(spacing: 6) {
                    Circle().fill(Palette.cobalt).frame(width: 7, height: 7).accessibilityHidden(true)
                    Text(current.map { "Running · \($0.label)" } ?? "Running").font(.callout.weight(.medium)).lineLimit(1)
                    Spacer(minLength: 4)
                    RunElapsed().font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                if !stages.isEmpty {
                    let done = stages.filter(\.isComplete).count
                    ProgressView(value: Double(done), total: Double(stages.count))
                        .accessibilityLabel("\(done) of \(stages.count) stages done")
                }
                let ledger = RunInfo.ledgerLine(store.snapshot.board?.ledger, nameOf: store.displayName)
                if !ledger.isEmpty {
                    Text(ledger).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                HStack {
                    Button("Details…") { ui.runSheet = .newRun }
                    Spacer()
                    Button("Stop…", role: .destructive) { ui.confirmStopRun = true }
                        .disabled(store.stopRunTargets.isEmpty)
                }
                .controlSize(.small)
            } else {
                let blocker = RunInfo.startBlocker(session: store.session, actReason: store.actReason, structure: store.structure, runActive: false)
                HStack {
                    if store.snapshot.result != nil {
                        Button("Ask Follow-up…") { ui.runSheet = .followUp }
                            .disabled(store.actReason != nil || store.session?.runtime != true)
                    }
                    Button("New Run…") { ui.runSheet = .newRun }
                        .buttonStyle(.borderedProminent)
                        .disabled(blocker != nil)
                }
                .controlSize(.regular)
                if let blocker {
                    Text(blocker).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The run state in the toolbar: a dot and a word, with the stage and elapsed time during a run.
struct RunStatePill: View {
    @Environment(OfficeStore.self) private var store
    @Environment(AppController.self) private var app

    var body: some View {
        let (word, color) = state
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(word).font(.callout.weight(.medium)).lineLimit(1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 3)
        .background(Capsule().fill(Color(nsColor: .quaternaryLabelColor).opacity(0.25)))
        .fixedSize()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Run state: \(word)")
        .help(store.snapshot.state?.next ?? word)
    }

    private var state: (String, Color) {
        if app.daemonState.info == nil { return (app.daemonState.failure == nil ? "Engine starting" : "Engine stopped", Palette.hair) }
        if store.isRunActive {
            let stage = RunInfo.stages(store.structure, statuses: store.statuses).first { !$0.isComplete }
            return ("Running" + (stage.map { " · \($0.label)" } ?? ""), store.needsYouCount > 0 ? Palette.verm : Palette.cobalt)
        }
        switch store.snapshot.state?.phase {
        case "done": return ("Done", Palette.sage)
        case "failed": return ("Failed", Palette.vermInk)
        default: break
        }
        guard let s = store.structure else { return (store.currentProject == nil ? "No project" : "No team", Palette.hair) }
        return s.locked ? ("Ready", Palette.sage) : ("Draft team", Palette.ochre)
    }
}
