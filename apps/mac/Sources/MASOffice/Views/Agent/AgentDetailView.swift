import MASOfficeKit
import SwiftUI

/// The selected agent (inspector page): who it is and what it costs, its own requests answerable here, the
/// three layers (doing / why / next & confidence), then Transcript, Outputs or Terminal, and a composer
/// pinned at the bottom to steer, queue or interrupt it, with receipts and Stop.
struct AgentDetailView: View {
    @Environment(OfficeStore.self) private var store

    var body: some View {
        if let id = store.selectedAgentId {
            AgentPage(agentId: id)
                .id(id)
        } else {
            ContentUnavailableView {
                Label("No Agent Selected", systemImage: "person.crop.circle")
            } description: {
                Text("Select someone in the office or the sidebar.")
            }
        }
    }
}

private struct AgentPage: View {
    @Environment(OfficeStore.self) private var store
    @Environment(WindowState.self) private var ui
    var agentId: String
    @FocusState private var focus: String?
    @ViewState private var limit = 80
    @ViewState private var expanded: Set<String> = []
    @ViewState private var atBottom = false
    @ViewState private var cache = TranscriptRowsCache()
    private var sui: SupervisionUI { .shared }

    var body: some View {
        @Bindable var shared = SupervisionUI.shared
        let rows = cache.rows(agentId: agentId, state: store.transcripts[agentId])
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                        AgentHeader(agentId: agentId)
                            .padding(12)
                        waiting
                        StripView(strip: store.strip(for: agentId))
                            .padding(.horizontal, 12)
                            .padding(.bottom, 12)
                        Section {
                            switch sui.agentSegment {
                            case .transcript:
                                TranscriptRows(agentId: agentId, rows: rows, limit: $limit, expanded: $expanded)
                            case .outputs:
                                AgentOutputs(agentId: agentId)
                            case .terminal:
                                TerminalNote()
                            }
                            Color.clear
                                .frame(height: 1)
                                .id("agent-bottom")
                                .onAppear { atBottom = true }
                                .onDisappear { atBottom = false }
                        } header: {
                            segmentBar($shared.agentSegment)
                        }
                    }
                }
                .onChange(of: rows.count) { _, _ in
                    if atBottom && sui.agentSegment == .transcript { proxy.scrollTo("agent-bottom", anchor: .bottom) }
                }
            }
            Divider()
            AgentComposer(agentId: agentId)
        }
        .task(id: agentId) { await keepFresh() }
    }

    @ViewBuilder
    private var waiting: some View {
        let mine = store.pendingItems(of: agentId)
        let order = mine.human.map(\.id) + mine.withLead.map(\.id)
        if !order.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                InspectorHeading(title: "Waiting on you", count: order.count)
                if let why = store.actReason { ReadOnlyNote(reason: why) }
                ForEach(mine.human) { card($0, dimmed: false, order: order) }
                ForEach(mine.withLead) { card($0, dimmed: true, order: order) }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 12)
        }
    }

    private func card(_ item: PendingItem, dimmed: Bool, order: [String]) -> some View {
        RequestCard(item: item, dimmed: dimmed, showsAgent: false, isFocused: focus == item.id)
            .focusable()
            .focusEffectDisabled()
            .focused($focus, equals: item.id)
            .modifier(CardKeys(request: item.request) { step in
                guard let i = order.firstIndex(of: item.id) else { return }
                focus = order[max(0, min(order.count - 1, i + step))]
            })
            .simultaneousGesture(TapGesture().onEnded { focus = item.id })
    }

    private func segmentBar(_ selection: Binding<AgentSegment>) -> some View {
        VStack(spacing: 0) {
            Picker("Show", selection: selection) {
                ForEach(AgentSegment.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            Divider()
        }
        .background(.bar)
    }

    /// The event stream re-reads the transcript and work files as they change; this is a safety net while
    /// the page is open (every 10 s), for the segment on screen.
    private func keepFresh() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled else { return }
            switch sui.agentSegment {
            case .transcript: await store.loadTranscript(agentId)
            case .outputs: await store.loadWorkFiles(agentId)
            case .terminal: break
            }
        }
    }
}

// MARK: - Header

private struct AgentHeader: View {
    @Environment(OfficeStore.self) private var store
    var agentId: String

    var body: some View {
        let s = store.structure
        let status = store.status(of: agentId)
        let job = agentId == "lead" ? s?.lead.job : s?.role(agentId)?.job
        let info = store.snapshot.board?.agents[agentId]
        let backend = info?.backend ?? (agentId == "lead" ? s?.lead.backend : s?.role(agentId)?.backend)
        let model = info?.model ?? (agentId == "lead" ? s?.lead.model : s?.role(agentId)?.model)
        let task = AgentStrip.lastTask(agentId, board: store.snapshot.board)
        let usage = store.usage(of: agentId)
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                ZStack {
                    Circle().fill(Color.primary.opacity(0.06))
                    if let e = s?.emoji(of: agentId) {
                        Text(verbatim: String(e.prefix(2))).font(.title2)
                    } else {
                        Image(systemName: "person.fill").foregroundStyle(.secondary)
                    }
                }
                .frame(width: 38, height: 38)
                .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: store.displayName(agentId))
                        .font(.title3.weight(.semibold))
                        .lineLimit(2)
                    if let job, !job.isEmpty {
                        Text(verbatim: job)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 6)
                StatePill(status: status)
            }
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 5) {
                if let backend {
                    row("Runs on", BackendStatus.label(backend) + (model.map { " · " + $0 } ?? ""))
                }
                if let task {
                    let words = [task.state, task.attempt > 1 ? "attempt \(task.attempt)" : "", task.round > 1 ? "round \(task.round)" : ""]
                        .filter { !$0.isEmpty }.joined(separator: " · ")
                    GridRow {
                        Text("Task").foregroundStyle(.secondary).gridColumnAlignment(.trailing)
                        (Text(verbatim: task.title) + Text(verbatim: words.isEmpty ? "" : "  " + words).foregroundStyle(.secondary))
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                }
                if let usage, !usage.text.isEmpty {
                    row("Usage", usage.text)
                }
            }
            .font(.callout)
            if let warn = usage?.warning {
                Label(warn, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(Tone.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func row(_ k: String, _ v: String) -> some View {
        GridRow {
            Text(verbatim: k).foregroundStyle(.secondary).gridColumnAlignment(.trailing)
            Text(verbatim: v).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        }
    }
}

/// State dot and word: "working", "needs you", "done".
private struct StatePill: View {
    var status: AgentStatus?

    var body: some View {
        let needs = status?.needsYou == true
        HStack(spacing: 5) {
            StateDot(status: status, size: 8)
            Text(verbatim: status?.stateLabel ?? "idle")
                .font(.caption.weight(.medium))
                .foregroundStyle(needs ? Tone.needsYou : .secondary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Capsule().fill(needs ? Tone.needsYou.opacity(0.12) : Color.primary.opacity(0.06)))
        .fixedSize()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("State: \(status?.stateLabel ?? "idle")")
    }
}

/// Doing / Why / Next & confidence.
private struct StripView: View {
    var strip: AgentStrip

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            layer("Doing", strip.doing)
            Divider()
            layer("Why", strip.why)
            Divider()
            layer("Next & confidence", strip.next)
        }
        .cardStyle()
    }

    private func layer(_ title: String, _ lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(verbatim: title.uppercased())
                .font(.caption2.weight(.semibold))
                .tracking(0.5)
                .foregroundStyle(.secondary)
            if lines.isEmpty {
                Text(verbatim: "—").foregroundStyle(.tertiary)
            }
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                Text(verbatim: line)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .font(.callout)
        .padding(.horizontal, 11)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Outputs

private struct AgentOutputs: View {
    @Environment(OfficeStore.self) private var store
    var agentId: String
    @ViewState private var full: Set<String> = []

    private static let cap = 60_000

    var body: some View {
        let state = store.workFiles[agentId]
        VStack(alignment: .leading, spacing: 12) {
            if state == nil || (state?.loading == true && state?.files.isEmpty == true) {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading this agent’s files…").foregroundStyle(.secondary)
                }
                .font(.callout)
            } else if let files = state?.files, !files.isEmpty {
                ForEach(files) { f in file(f) }
            } else if let error = state?.error {
                Text(verbatim: "The files could not be read: \(error)").font(.callout).foregroundStyle(.secondary)
            } else {
                Text(verbatim: "No work files yet (outputs/work/\(agentId).md).").font(.callout).foregroundStyle(.secondary)
            }
            sources
        }
        .padding(12)
    }

    private func file(_ f: WorkFile) -> some View {
        let long = f.text.count > Self.cap && !full.contains(f.name)
        return VStack(alignment: .leading, spacing: 8) {
            Label {
                Text(verbatim: "outputs/work/" + f.name)
            } icon: {
                Image(systemName: "doc.text")
            }
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
            B_MarkdownView(markdown: long ? String(f.text.prefix(Self.cap)) : f.text,
                           claims: store.snapshot.verification?.statusByClaim ?? [:])
            if long {
                Button("Show the whole file (\(f.text.count.formatted()) characters)") { full.insert(f.name) }
                    .buttonStyle(.borderless)
                    .font(.caption)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
    }

    @ViewBuilder
    private var sources: some View {
        let list = (store.snapshot.result?.sources ?? []).filter { $0.foundBy == agentId }
        if !list.isEmpty {
            InspectorHeading(title: "Sources", count: list.count)
                .padding(.top, 4)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(list.enumerated()), id: \.offset) { i, s in
                    if i > 0 { Divider() }
                    SourceRow(source: s, evidence: store.snapshot.verification?.evidence(for: s.id))
                        .padding(.vertical, 7)
                        .padding(.horizontal, 10)
                }
            }
            .cardStyle()
        }
    }
}

/// A source with its evidence grade (what kind of source) and its link health (whether the link works).
private struct SourceRow: View {
    var source: ResultDoc.Source
    var evidence: Verification.Evidence?

    var body: some View {
        let health = evidence?.urlHealth
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            TagBadge(text: source.evidence.rawValue, color: gradeColor(source.evidence))
                .help("Evidence grade \(source.evidence.rawValue): \(source.evidence.meaning)")
                .accessibilityLabel("Grade \(source.evidence.rawValue), \(source.evidence.meaning)")
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: source.title ?? source.id)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    if let s = source.url, let url = URL(string: s), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                        Link(destination: url) {
                            Text(verbatim: url.host ?? s).lineLimit(1).truncationMode(.middle)
                        }
                        .help(s)
                    } else if let s = source.url {
                        Text(verbatim: s).lineLimit(1).truncationMode(.middle).foregroundStyle(.secondary)
                    }
                    if let health {
                        Text(verbatim: health.word + (evidence?.httpStatus.map { " · \($0)" } ?? ""))
                            .foregroundStyle(healthColor(health))
                    }
                }
                .font(.caption)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func gradeColor(_ g: EvidenceGrade) -> Color {
        switch g {
        case .A: return Tone.good
        case .B: return Tone.question
        case .C: return Tone.warning
        case .D: return .secondary
        }
    }

    private func healthColor(_ h: URLHealth) -> Color {
        switch h {
        case .live: return Tone.good
        case .stale: return Tone.warning
        case .hallucinated: return Tone.bad
        case .blocked, .unknown: return .secondary
        }
    }
}

private struct TerminalNote: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Raw terminal", systemImage: "terminal")
                .font(.headline)
            Text("The raw terminal needs the optional terminal package (mas-office-terminal), which this app does not include. The transcript shows what the session did.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
    }
}
