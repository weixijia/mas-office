import MASOfficeKit
import SwiftUI

/// Projects of the workspace and the team roster grouped by stage: state dot, name, what each agent is doing, and
/// a raised hand with the wait time for an agent blocked on you. The team header opens the team design; the run
/// controls sit at the bottom.
struct SidebarView: View {
    @Environment(OfficeStore.self) private var store
    @Environment(WindowState.self) private var ui
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        List(selection: Binding(get: { store.selectedAgentId }, set: { store.selectAgent($0) })) {
            if store.needsYouCount > 0 {
                Section {
                    Button {
                        ui.show(.inbox)
                        store.selectNextNeedingYou()
                    } label: {
                        HStack {
                            Label("Needs you", systemImage: "hand.raised.fill")
                                .foregroundStyle(Palette.verm)
                            Spacer()
                            CountBadge(count: store.needsYouCount)
                        }
                    }
                    .buttonStyle(.plain)
                    .help("Show the inbox and the next agent waiting on you (⌘J)")
                }
            }
            if let projects = store.projects, !projects.projects.isEmpty {
                Section("Projects") {
                    ForEach(projects.projects) { p in
                        Button {
                            store.selectProject(p.folder)
                        } label: {
                            HStack {
                                Label {
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(p.title).lineLimit(1)
                                        if let phase = p.phase { Text(phase).font(.caption).foregroundStyle(.secondary) }
                                    }
                                } icon: {
                                    Image(systemName: p.folder == store.currentProject ? "folder.fill" : "folder")
                                }
                                Spacer()
                                if p.folder == store.currentProject {
                                    Image(systemName: "checkmark").font(.caption).foregroundStyle(.secondary).accessibilityLabel("Current")
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            if let s = store.structure {
                Section {
                    AgentRow(id: "lead").tag(Optional("lead"))
                } header: {
                    TeamHeader(structure: s)
                }
                ForEach(Array(s.orderedGroups.enumerated()), id: \.element.id) { k, g in
                    let members = s.members(ofGroup: g.id)
                    if !members.isEmpty {
                        Section("\(k + 1) · \(g.label?.isEmpty == false ? g.label! : "Stage \(k + 1)")") {
                            ForEach(members) { r in AgentRow(id: r.id).tag(Optional(r.id)) }
                        }
                    }
                }
                let loose = s.roles.filter { r in !s.groups.contains { $0.id == r.group } }
                if !loose.isEmpty {
                    Section("Others") {
                        ForEach(loose) { r in AgentRow(id: r.id).tag(Optional(r.id)) }
                    }
                }
            } else if store.connection.isUsable {
                Section("Team") {
                    Text(store.currentProject == nil ? "No project yet." : "No team design in this project yet.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if store.connection.isUsable, store.currentProject != nil {
                VStack(spacing: 0) {
                    Divider()
                    RunCompactView()
                }
                .background(.bar)
            }
        }
    }
}

/// The team header: its name and lock state; opens the team design.
private struct TeamHeader: View {
    var structure: Structure
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button {
            openWindow(id: "team")
        } label: {
            HStack(spacing: 5) {
                Text(structure.locked ? "Team" : "Team (draft)")
                Image(systemName: structure.locked ? "lock.fill" : "lock.open")
                    .imageScale(.small)
                Spacer()
                Image(systemName: "info.circle").imageScale(.medium)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Team Design (⌘T): who does what, with which tools")
        .accessibilityLabel("Team \(structure.locked ? "locked" : "draft"). Open the team design")
    }
}

/// One member: state dot, name, what it is doing; a raised hand and the wait time when it waits on you.
struct AgentRow: View {
    @Environment(OfficeStore.self) private var store
    @Environment(WindowState.self) private var ui
    var id: String

    var body: some View {
        let status = store.status(of: id)
        let waiting = store.waitingAgents.first { $0.id == id }
        HStack(spacing: 8) {
            StateDot(status: status)
            if let emoji = store.structure?.emoji(of: id) {
                Text(emoji).font(.callout).accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(store.displayName(id)).lineLimit(1)
                Text(status.map { $0.flag ?? $0.say ?? $0.stateLabel } ?? "idle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            if let waiting {
                HStack(spacing: 3) {
                    Image(systemName: "hand.raised.fill")
                    B_Ticking { now in Text(Supervision.waited(since: waiting.since, now: now)).monospacedDigit() }
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(Palette.verm)
                .help("Waiting on you" + (waiting.count > 1 ? " (\(waiting.count) requests)" : ""))
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(store.displayName(id)), \(status?.stateLabel ?? "idle")" + (waiting != nil ? ", waiting on you" : ""))
        .contextMenu {
            Button("Message…") { ui.messageTarget = id }
                .disabled(!store.accepts(id, "message"))
            Button("Stop") { Task { await store.requestStop(id) } }
                .disabled(!store.accepts(id, "interrupt") || status?.state.isBusy != true)
            Divider()
            Button("Show Transcript") {
                store.selectAgent(id)
                ui.show(.agent)
            }
        }
    }
}
