import AppKit
import MASOfficeKit
import SwiftUI

/// The locked team design, read-only: the Lead and roles grouped by stage with backend, tools in words, reviewer
/// relations, gates, delegation rules as sentences, budget, lock state and signature. "Check Design" and "Lock…"
/// run the real `mas-office team check|lock` through the engine's Node; this view never compiles anything itself.
struct TeamInspectorView: View {
    @Environment(AppController.self) private var app
    @Environment(OfficeStore.self) private var store
    @ViewState private var outcome: TeamCLI.Outcome?
    @ViewState private var running: TeamCLI.Action?
    @ViewState private var confirmLock = false

    var body: some View {
        Group {
            if let s = store.structure {
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        header(s)
                        if let outcome { CheckOutcomeView(outcome: outcome, structure: s) { self.outcome = nil } }
                        LeadSection(structure: s)
                        ForEach(Array(s.orderedGroups.enumerated()), id: \.element.id) { k, g in
                            StageSection(structure: s, group: g, number: k + 1)
                        }
                        let loose = s.roles.filter { r in !s.groups.contains { $0.id == r.group } }
                        if !loose.isEmpty {
                            StageSection(structure: s, group: nil, number: s.groups.count + 1, roles: loose)
                        }
                        RulesSection(structure: s)
                        if let why = s.rationale, !why.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                B_SectionHeader(title: "Why this design", count: nil, systemImage: "text.quote")
                                Text(why).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .padding(24)
                    .frame(maxWidth: 760, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
            } else {
                ContentUnavailableView {
                    Label("No team design", systemImage: "person.3")
                } description: {
                    Text(store.currentProject == nil ? "Choose or create a project first." : "This project has no team design yet. Start from the example team in Help ▸ Setup Check.")
                }
            }
        }
        .frame(minWidth: 520, minHeight: 420)
        .navigationTitle(store.structure?.title ?? "Team Design")
        .navigationSubtitle(store.structure.map { $0.locked ? "Locked" : "Draft" } ?? "")
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    run(.check)
                } label: {
                    Label("Check Design", systemImage: "checklist")
                }
                .disabled(!canRunCLI || running != nil)
                .help(cliReason ?? "Check the design against the team rules (mas-office team check)")
                Button {
                    confirmLock = true
                } label: {
                    Label("Lock…", systemImage: "lock")
                }
                .disabled(!canRunCLI || running != nil || store.isRunActive)
                .help(store.isRunActive ? "Not while a run is in progress" : cliReason ?? "Lock the design so each role gets exactly these tools")
                Button {
                    revealStructure()
                } label: {
                    Label("Reveal in Finder", systemImage: "folder")
                }
                .disabled(structureFile == nil)
                .help(structureFile == nil ? "The design file is not on this Mac's known workspace" : "Show the design file in Finder")
            }
        }
        .confirmationDialog("Lock this team design?", isPresented: $confirmLock) {
            Button("Lock Design") { run(.lock) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Locking checks the design, then compiles it into enforced per-role tools and permissions and signs it. "
                 + "Roles get exactly the tools shown here; anything else asks you first or is refused. "
                 + "To change the design later, edit it and lock it again.")
        }
    }

    private var canRunCLI: Bool { cliReason == nil }

    private var cliReason: String? {
        if store.currentProject == nil { return "No project is selected." }
        if app.workspace == nil { return "The workspace folder of the attached engine is not known here." }
        return nil
    }

    private var structureFile: URL? {
        guard let w = app.workspace, let p = store.currentProject else { return nil }
        let base = w.appendingPathComponent(p).appendingPathComponent("mas/structure")
        for ext in ["json", "js"] where FileManager.default.fileExists(atPath: base.appendingPathExtension(ext).path) {
            return base.appendingPathExtension(ext)
        }
        return nil
    }

    private func revealStructure() {
        if let f = structureFile { NSWorkspace.shared.activateFileViewerSelecting([f]) }
    }

    private func run(_ action: TeamCLI.Action) {
        guard let p = store.currentProject else { return }
        running = action
        Task {
            let o = await app.runTeamCommand(action, project: p)
            outcome = o
            running = nil
            await store.refresh()
        }
    }

    @ViewBuilder
    private func header(_ s: Structure) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(s.title ?? "Team").font(.largeTitle.weight(.semibold)).textSelection(.enabled)
            HStack(spacing: 10) {
                if s.locked {
                    Label("Locked", systemImage: "lock.fill").foregroundStyle(B_ClaimStyle.color(.supported))
                    if let sig = TeamDesignText.signaturePrefix(s.signature) {
                        Text(sig).font(.callout.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                            .help("Signature of the locked design: \(s.signature ?? "")")
                    }
                } else {
                    Label("Draft: not locked", systemImage: "lock.open").foregroundStyle(Color(nsColor: B_ClaimStyle.ochre))
                }
                if let v = s.version { Text("version \(v)").foregroundStyle(.secondary) }
                Text("\(s.roles.count + 1) members · \(s.orderedGroups.count) " + (s.orderedGroups.count == 1 ? "stage" : "stages")).foregroundStyle(.secondary)
                if running != nil {
                    ProgressView().controlSize(.small)
                    Text(running == .lock ? "Locking…" : "Checking…").foregroundStyle(.secondary)
                }
            }
            .font(.callout)
            Text("Read-only: the design is the contract the engine enforces. Edit the design file and lock it again to change it.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The result of Check Design or Lock: problems grouped by severity, or the CLI's own success line.
private struct CheckOutcomeView: View {
    var outcome: TeamCLI.Outcome
    var structure: Structure
    var dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Image(systemName: outcome.ok ? "checkmark.seal.fill" : "xmark.octagon.fill")
                    .foregroundStyle(outcome.ok ? B_ClaimStyle.color(.supported) : Color(nsColor: .systemRed))
                Text(outcome.summary).font(.headline).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button("Dismiss", action: dismiss).buttonStyle(.borderless).controlSize(.small)
            }
            ForEach(outcome.problems) { p in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: p.level == .error ? "xmark.circle" : "exclamationmark.triangle")
                        .foregroundStyle(p.level == .error ? Color(nsColor: .systemRed) : Color(nsColor: B_ClaimStyle.ochre))
                        .accessibilityLabel(p.level == .error ? "Error" : "Warning")
                    VStack(alignment: .leading, spacing: 1) {
                        Text(p.message).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        Text(p.place(in: structure)).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if outcome.problems.isEmpty, !outcome.ok, !outcome.output.isEmpty {
                Text(outcome.output).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .quaternaryLabelColor).opacity(0.15)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(nsColor: .separatorColor)))
    }
}

/// A labelled detail row ("Backend   Codex").
private struct DetailRow<Content: View>: View {
    var label: String
    @ViewBuilder var content: Content

    var body: some View {
        GridRow(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(.secondary).gridColumnAlignment(.trailing)
            content.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct MemberCard: View {
    var structure: Structure
    var id: String

    var body: some View {
        let isLead = id == "lead"
        let r = structure.role(id)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if let e = structure.emoji(of: id) { Text(e).font(.title2) }
                VStack(alignment: .leading, spacing: 1) {
                    Text(structure.name(of: id)).font(.title3.weight(.semibold))
                    if let job = isLead ? structure.lead.job : r?.job, !job.isEmpty {
                        Text(job).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                let backend = (isLead ? structure.lead.backend : r?.backend) ?? "claude-code"
                let model = isLead ? structure.lead.model : r?.model
                DetailRow(label: "Runs on") {
                    Text(BackendStatus.label(backend) + (model.map { " · \($0)" } ?? "") + " (your own sign-in)")
                }
                if let r {
                    DetailRow(label: "Tools") {
                        VStack(alignment: .leading, spacing: 3) {
                            ForEach(Array(TeamDesignText.toolSentences(r.tools).enumerated()), id: \.offset) { _, t in
                                Label(t.text, systemImage: t.effect == .allow ? "checkmark.circle" : t.effect == .ask ? "hand.raised" : "nosign")
                                    .foregroundStyle(t.effect == .deny ? .secondary : .primary)
                            }
                        }
                    }
                    DetailRow(label: "Works with") {
                        VStack(alignment: .leading, spacing: 3) {
                            ForEach(TeamDesignText.relationSentences(r, structure: structure), id: \.self) { Text($0) }
                        }
                    }
                    if let out = r.output, !out.isEmpty { DetailRow(label: "Delivers") { Text(out).fixedSize(horizontal: false, vertical: true) } }
                    if let why = r.why, !why.isEmpty { DetailRow(label: "Why") { Text(why).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) } }
                }
                let serves = isLead ? structure.lead.serves : r?.serves ?? []
                if !serves.isEmpty { DetailRow(label: "Serves") { Text(serves.joined(separator: ", ")).monospaced() } }
            }
            .font(.callout)
            .textSelection(.enabled)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(nsColor: .separatorColor)))
        .accessibilityElement(children: .contain)
    }
}

private struct LeadSection: View {
    var structure: Structure

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            B_SectionHeader(title: "Lead", count: nil, systemImage: "person.crop.circle.badge.checkmark")
            MemberCard(structure: structure, id: "lead")
            let rules = structure.delegate.map { TeamDesignText.delegationSentence($0, structure: structure) }
            VStack(alignment: .leading, spacing: 4) {
                Text("Delegated approvals").font(.subheadline.weight(.semibold))
                if rules.isEmpty {
                    Text("None: every approval comes to you.").font(.callout).foregroundStyle(.secondary)
                }
                ForEach(rules, id: \.self) { Label($0, systemImage: "arrow.turn.down.right").font(.callout) }
                Text("Gates and flags always come to you, whatever these rules say.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

private struct StageSection: View {
    var structure: Structure
    var group: TeamGroup?
    var number: Int
    var roles: [TeamRole]?

    var body: some View {
        let members = roles ?? group.map { structure.members(ofGroup: $0.id) } ?? []
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                B_SectionHeader(title: "Stage \(number)" + (group?.label.map { " · \($0)" } ?? ""), count: nil, systemImage: "\(min(number, 50)).circle")
            }
            Text(members.count > 1 ? "These roles work at the same time." : group == nil ? "Roles without a stage." : "One role.")
                .font(.callout).foregroundStyle(.secondary)
            ForEach(members) { r in MemberCard(structure: structure, id: r.id) }
            ForEach(structure.gates.filter { $0.after == group?.id && group != nil }) { g in
                Label(TeamDesignText.gateSentence(g, structure: structure), systemImage: "hand.raised.square")
                    .font(.callout)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 3])).foregroundStyle(Color(nsColor: .separatorColor)))
            }
        }
    }
}

private struct RulesSection: View {
    var structure: Structure

    var body: some View {
        let finalGates = structure.gates.filter { gate in gate.after == nil || !structure.groups.contains(where: { $0.id == gate.after }) }
        let budget = TeamDesignText.budgetSentences(structure.budget)
        let verify = TeamDesignText.verifySentences(structure.verify)
        if !finalGates.isEmpty || !budget.isEmpty || !verify.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                B_SectionHeader(title: "Rules", count: nil, systemImage: "list.bullet.rectangle")
                ForEach(finalGates) { Label(TeamDesignText.gateSentence($0, structure: structure), systemImage: "hand.raised.square") }
                ForEach(verify, id: \.self) { Label($0, systemImage: "checkmark.shield") }
                ForEach(budget, id: \.self) { Label($0, systemImage: "gauge.with.dots.needle.33percent") }
            }
            .font(.callout)
        }
    }
}
