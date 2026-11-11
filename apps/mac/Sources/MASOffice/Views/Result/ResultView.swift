import MASOfficeKit
import SwiftUI
import UniformTypeIdentifiers

/// The answer with every claim checked: rounds, the credibility summary, the answer with interactive claims,
/// what the checkers caught, flags, sources with evidence grades and link health, and each role's work.
/// Shown in the inspector and, larger, in its own window (View ▸ Open Result in Window).
struct ResultView: View {
    enum Presentation { case inspector, window }
    var presentation: Presentation = .inspector

    @Environment(OfficeStore.self) private var store
    @Environment(WindowState.self) private var ui
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if let result = store.snapshot.result {
            ResultContent(result: result, presentation: presentation)
        } else if store.snapshot.state?.phase == "failed" {
            ContentUnavailableView {
                Label("The run failed", systemImage: "exclamationmark.triangle")
            } description: {
                Text(store.snapshot.state?.next ?? "The team stopped before writing an answer. The Lead's transcript says why.")
            } actions: {
                Button("Show the Lead") {
                    store.selectAgent("lead")
                    ui.show(.agent)
                }
                Button("New Run…") { ui.runSheet = .newRun }
            }
        } else if store.isRunActive {
            ContentUnavailableView {
                Label("The team is working", systemImage: "hourglass")
            } description: {
                Text("The answer appears here when the Lead writes it, with every claim checked against its sources.")
            }
        } else {
            ContentUnavailableView {
                Label("No result yet", systemImage: "doc.text.magnifyingglass")
            } description: {
                Text("Give the team a task. Its answer appears here with each claim, the evidence behind it, and what the checkers caught.")
            } actions: {
                Button("New Run…") { ui.runSheet = .newRun }
                    .disabled(store.structure?.locked != true)
            }
        }
    }
}

/// The result once there is one.
private struct ResultContent: View {
    var result: ResultDoc
    var presentation: ResultView.Presentation

    @Environment(OfficeStore.self) private var store
    @Environment(WindowState.self) private var ui
    @Environment(\.openWindow) private var openWindow

    private var big: Bool { presentation == .window }

    var body: some View {
        let rounds = result.rounds
        let selected = rounds.first { $0.round == ui.resultRound } ?? rounds.last!
        ScrollView {
            VStack(alignment: .leading, spacing: big ? 22 : 18) {
                header(rounds: rounds, selected: selected)
                if !selected.question.isEmpty {
                    QuestionBox(question: selected.question)
                }
                if let c = store.credibility {
                    CredibilitySection(credibility: c)
                }
                if !selected.title.isEmpty, selected.title != result.title {
                    Text(selected.title).font(.title3.weight(.semibold)).textSelection(.enabled)
                }
                B_MarkdownView(markdown: selected.markdown, claims: store.snapshot.verification?.statusByClaim ?? [:],
                               textSize: big ? 14 : NSFont.systemFontSize) { id in
                    AnyView(ClaimPopoverContent(claimId: id).environment(store))
                }
                .accessibilityLabel("Answer")
                if selected.markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("This round has no text.").foregroundStyle(.secondary)
                }
                CaughtSection()
                FlagsSection(flags: result.flags)
                SourcesSection(result: result)
                WorkSection(work: result.work)
            }
            .padding(.horizontal, big ? 32 : 16)
            .padding(.vertical, big ? 26 : 14)
            .frame(maxWidth: big ? 780 : .infinity, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder
    private func header(rounds: [ResultDoc.Round], selected: ResultDoc.Round) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(result.title ?? "Result")
                    .font(big ? .largeTitle.weight(.semibold) : .title2.weight(.semibold))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if presentation == .inspector {
                    ResultActions(result: result, compact: true)
                }
            }
            Text(subtitle(selected)).font(.callout).foregroundStyle(.secondary)
            if rounds.count > 1 {
                let picker = Picker("Round", selection: Binding(get: { selected.round }, set: { r in ui.resultRound = r == rounds.last?.round ? nil : r })) {
                    ForEach(rounds) { r in
                        Text(r.round == 1 && r.question.isEmpty ? "Answer" : "Follow-up \(r.round - 1)").tag(r.round)
                    }
                }
                .labelsHidden()
                .help("Earlier rounds stay as they were; the latest round is shown when it arrives.")
                if rounds.count <= 4 {
                    picker.pickerStyle(.segmented)
                } else {
                    picker.pickerStyle(.menu).fixedSize()
                }
            }
        }
    }

    private func subtitle(_ r: ResultDoc.Round) -> String {
        var parts: [String] = []
        if let run = result.run { parts.append("Run \(run)") }
        if result.rounds.count > 1 { parts.append("round \(r.round) of \(result.rounds.count)" + (r.latest ? " (latest)" : "")) }
        if let d = Self.date(r.updated.isEmpty ? result.updated : r.updated) {
            parts.append("updated " + d.formatted(date: .abbreviated, time: .shortened))
        }
        return parts.joined(separator: " · ")
    }

    static func date(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }
}

/// Share, copy as Markdown, export, open in window.
struct ResultActions: View {
    var result: ResultDoc
    var compact: Bool

    @Environment(OfficeStore.self) private var store
    @Environment(WindowState.self) private var ui
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let text = ResultExport.markdown(result, verification: store.snapshot.verification, nameOf: store.displayName)
        HStack(spacing: 2) {
            ShareLink(item: text, subject: Text(result.title ?? "Result"), preview: SharePreview(result.title ?? "Result")) {
                Image(systemName: "square.and.arrow.up")
            }
            .help("Share the result as Markdown")
            Menu {
                Button("Copy as Markdown") { B_Pasteboard.copy(text) }
                Button("Export…") { ui.exportResult = true }
                if compact {
                    Divider()
                    Button("Open in Window") { openWindow(id: "result") }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuIndicator(.hidden)
            .fixedSize()
            .help("More: copy, export, open in a window")
            .accessibilityLabel("More result actions")
        }
        .buttonStyle(.borderless)
        .controlSize(.large)
    }
}

private struct QuestionBox: View {
    var question: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "text.bubble").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text("You asked").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text(question).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .quaternaryLabelColor).opacity(0.18)))
        .accessibilityElement(children: .combine)
    }
}

/// "6 claims · 1 supported · …" over the proportional bar, with the underline key.
struct CredibilitySection: View {
    var credibility: Credibility

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("Checked claims").font(.subheadline.weight(.semibold))
            if credibility.total > 0 { B_CredibilityBar(credibility: credibility) }
            Text(credibility.text).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { legend }
                VStack(alignment: .leading, spacing: 3) { legend }
            }
            .font(.caption)
            Text("Hover, click or Tab to an underlined statement to see who checked it and against which sources.")
                .font(.caption).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .quaternaryLabelColor).opacity(0.14)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(nsColor: .separatorColor).opacity(0.6)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("How the claims were checked")
    }

    @ViewBuilder
    private var legend: some View {
        ForEach([ClaimStatus.supported, .partial, .contradicted, .unknown], id: \.self) { s in
            Text(s.word)
                .underline(true, pattern: s == .partial ? .dash : s == .unknown ? .dot : .solid, color: B_ClaimStyle.color(s))
                .foregroundStyle(.secondary)
                .accessibilityLabel("\(s.word): \(s == .partial ? "dashed" : s == .unknown ? "dotted" : "solid") underline")
        }
    }
}

/// What the checkers caught: contradicted and unknown claims, reviews that sent work back or up.
private struct CaughtSection: View {
    @Environment(OfficeStore.self) private var store

    var body: some View {
        let caught = CheckersCaught(verification: store.snapshot.verification, board: store.snapshot.board, nameOf: store.displayName)
        if !caught.items.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                B_SectionHeader(title: "What the checkers caught", count: caught.items.count, systemImage: "checkmark.shield")
                ForEach(caught.items) { item in
                    HStack(alignment: .firstTextBaseline, spacing: 0) {
                        VStack(alignment: .leading, spacing: 3) {
                            chip(item)
                            Text(item.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                            ForEach(item.notes, id: \.self) { n in
                                Text(n).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    @ViewBuilder
    private func chip(_ item: CheckersCaught.Item) -> some View {
        switch item.kind {
        case .contradicted: B_VerdictChip(status: .contradicted, compact: true)
        case .unknown: B_VerdictChip(status: .unknown, compact: true)
        case .sentBack, .escalated:
            let c = item.kind == .escalated ? B_ClaimStyle.color(.contradicted) : B_ClaimStyle.color(.partial)
            Label(item.word, systemImage: item.kind == .escalated ? "arrow.up.forward.circle" : "arrow.uturn.backward.circle")
                .font(.caption.weight(.medium))
                .foregroundStyle(c)
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(Capsule().fill(c.opacity(0.13)))
                .fixedSize()
        }
    }
}

private struct FlagsSection: View {
    var flags: [ResultDoc.Flag]
    @Environment(OfficeStore.self) private var store

    var body: some View {
        if !flags.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                B_SectionHeader(title: "Flags", count: flags.count, systemImage: "flag")
                ForEach(Array(flags.enumerated()), id: \.offset) { _, f in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: f.kind == "error" ? "xmark.octagon" : f.kind == "needs_input" ? "questionmark.bubble" : "exclamationmark.triangle")
                            .foregroundStyle(Color(nsColor: B_ClaimStyle.ochre))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(f.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                            if let by = f.by { Text(store.displayName(by)).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}

private struct SourcesSection: View {
    var result: ResultDoc
    @Environment(OfficeStore.self) private var store

    var body: some View {
        let rows = SourceRow.rows(result: result, verification: store.snapshot.verification, nameOf: store.displayName)
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 9) {
                B_SectionHeader(title: "Sources", count: rows.count, systemImage: "books.vertical")
                ForEach(rows) { s in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        B_GradeBadge(grade: s.grade)
                        VStack(alignment: .leading, spacing: 2) {
                            if let url = s.url {
                                Link(s.title, destination: url).help(url.absoluteString)
                            } else {
                                Text(s.title).textSelection(.enabled)
                            }
                            HStack(spacing: 8) {
                                if let f = s.foundBy { Text("found by \(f)").font(.caption).foregroundStyle(.secondary) }
                                B_HealthLabel(health: s.health, httpStatus: s.httpStatus)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .accessibilityElement(children: .combine)
                }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) { gradeKey }
                    VStack(alignment: .leading, spacing: 3) { gradeKey }
                }
                .padding(.top, 2)
            }
        }
    }

    @ViewBuilder
    private var gradeKey: some View {
        ForEach(EvidenceGrade.allCases, id: \.self) { g in
            HStack(spacing: 4) {
                B_GradeBadge(grade: g)
                Text(g.meaning).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

private struct WorkSection: View {
    var work: [ResultDoc.Work]
    @Environment(OfficeStore.self) private var store

    var body: some View {
        if !work.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                B_SectionHeader(title: "What each role did", count: nil, systemImage: "person.3")
                ForEach(Array(work.enumerated()), id: \.offset) { _, w in
                    DisclosureGroup {
                        B_MarkdownView(markdown: w.summary).padding(.top, 4).padding(.leading, 4)
                    } label: {
                        HStack(spacing: 6) {
                            if let e = store.structure?.emoji(of: w.by) { Text(e) }
                            Text(store.displayName(w.by)).font(.callout.weight(.medium))
                        }
                    }
                }
            }
        }
    }
}

/// The result in its own window, with Share / Copy / Export in the toolbar.
struct ResultWindow: View {
    @Environment(OfficeStore.self) private var store
    @Environment(WindowState.self) private var ui
    @ViewState private var exporting = false
    @ViewState private var exportError: String?

    var body: some View {
        ResultView(presentation: .window)
            .frame(minWidth: 520, minHeight: 420)
            .navigationTitle(store.snapshot.result?.title ?? "Result")
            .navigationSubtitle(store.structure?.title ?? "")
            .toolbar {
                if let r = store.snapshot.result {
                    let text = ResultExport.markdown(r, verification: store.snapshot.verification, nameOf: store.displayName)
                    ToolbarItemGroup(placement: .primaryAction) {
                        Button {
                            B_Pasteboard.copy(text)
                        } label: {
                            Label("Copy as Markdown", systemImage: "doc.on.doc")
                        }
                        .help("Copy the result as Markdown (claim tags removed)")
                        Button {
                            exporting = true
                        } label: {
                            Label("Export…", systemImage: "arrow.down.doc")
                        }
                        .help("Save the result as a Markdown file")
                        ShareLink(item: text, subject: Text(r.title ?? "Result"), preview: SharePreview(r.title ?? "Result"))
                            .help("Share the result")
                    }
                }
            }
            .fileExporter(isPresented: $exporting, document: B_MarkdownFile(text: exportText), contentType: B_MarkdownFile.type,
                          defaultFilename: ResultExport.fileName(store.snapshot.result?.title)) { r in
                if case .failure(let e) = r { exportError = e.localizedDescription }
            }
            .alert("The result could not be saved", isPresented: Binding(get: { exportError != nil }, set: { if !$0 { exportError = nil } })) {
                Button("OK") { exportError = nil }
            } message: {
                Text((exportError ?? "") + " Choose another folder and try again.")
            }
    }

    private var exportText: String {
        store.snapshot.result.map { ResultExport.markdown($0, verification: store.snapshot.verification, nameOf: store.displayName) } ?? ""
    }
}

/// A Markdown file for `fileExporter`.
struct B_MarkdownFile: FileDocument {
    static let type = UTType("net.daringfireball.markdown") ?? .plainText
    static let readableContentTypes: [UTType] = [type, .plainText]
    var text: String

    init(text: String) { self.text = text }

    init(configuration: ReadConfiguration) throws {
        text = configuration.file.regularFileContents.map { String(decoding: $0, as: UTF8.self) } ?? ""
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}
