import AppKit
import MASOfficeKit
import SwiftUI

/// `--render` pictures of the window chrome and the result, run, team, onboarding and settings views, in light and
/// dark. Called by `Renderer.run` once the store has data. States the fixture does not have (an idle team, a
/// finished run, a draft team, mixed setup rows) are drawn from preview stores built from the same snapshot.
@MainActor
enum ChromeRenders {
    static func run(directory dir: URL, app: AppController, store: OfficeStore) async -> [String] {
        var written: [String] = []
        let saved = NSApp.appearance
        let ui = Shared.ui
        for (mode, name) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
            guard let appearance = NSAppearance(named: name) else { continue }
            NSApp.appearance = appearance

            // The main window at two sizes (fresh off-screen windows with the toolbar bridged), with the result page
            // in the inspector for the smaller one.
            for (size, tab) in [(CGSize(width: 1280, height: 800), InspectorTab.inbox), (CGSize(width: 1024, height: 700), InspectorTab.result)] {
                ui.show(tab)
                let file = "main-\(Int(size.width))x\(Int(size.height))-\(mode).png"
                if let data = await mainWindowPNG(size: size, appearance: appearance, app: app, store: store) {
                    try? data.write(to: dir.appendingPathComponent(file))
                    written.append(file)
                }
            }
            ui.show(.inbox)

            func shot<V: View>(_ file: String, _ size: CGSize, store s: OfficeStore = store, _ view: V) async {
                if await render(view, size: size, appearance: appearance, app: app, store: s, to: dir, name: "\(file)-\(mode).png") {
                    written.append("\(file)-\(mode).png")
                }
            }

            await shot("sidebar-chrome", CGSize(width: 270, height: 760), SidebarView())
            await shot("result-page", CGSize(width: 400, height: 1700), ResultView())
            await shot("result-window", CGSize(width: 860, height: 1500), ResultView(presentation: .window))
            if let c3 = ClaimDetail(claimId: "c3", verification: store.snapshot.verification, result: store.snapshot.result) {
                await shot("claim-popover-contradicted", CGSize(width: 340, height: 420), ClaimDetailView(detail: c3, nameOf: store.displayName))
            }
            if let c1 = ClaimDetail(claimId: "c1", verification: store.snapshot.verification, result: store.snapshot.result) {
                await shot("claim-popover-supported", CGSize(width: 340, height: 330), ClaimDetailView(detail: c1, nameOf: store.displayName))
            }

            // The run sheet: during the run (fixture), idle with a locked team, after a result.
            await shot("run-sheet-running", CGSize(width: 540, height: 520), RunSheet(mode: .newRun))
            let idle = previewStore(from: store, phase: "locked", result: false)
            await shot("run-sheet-new", CGSize(width: 540, height: 360), store: idle, RunSheet(mode: .newRun))
            let done = previewStore(from: store, phase: "done", result: true)
            await shot("run-sheet-follow-up", CGSize(width: 540, height: 330), store: done, RunSheet(mode: .followUp))
            let blocked = previewStore(from: store, phase: "locked", result: false, codexSignedIn: false)
            await shot("run-sheet-blocked", CGSize(width: 540, height: 380), store: blocked, RunSheet(mode: .newRun))
            await shot("run-compact-idle", CGSize(width: 270, height: 110), store: done, RunCompactView())
            await shot("run-compact-running", CGSize(width: 270, height: 150), RunCompactView())

            await shot("team-design", CGSize(width: 780, height: 2300), TeamInspectorView())
            let draft = previewStore(from: store, phase: "design", result: false, locked: false)
            await shot("team-design-draft", CGSize(width: 780, height: 700), store: draft, TeamInspectorView())

            await shot("onboarding-mixed", CGSize(width: 680, height: 860), OnboardingView(onClose: {}, preview: mixedSetup(store.structure)))
            await shot("onboarding-first-launch", CGSize(width: 680, height: 860), OnboardingView(preview: SetupCheck.items(SetupCheck.Input())))

            for tab in [SettingsView.Tab.general, .notifications, .advanced, .about] {
                await shot("settings-\(tab.rawValue)", CGSize(width: 560, height: tab == .advanced ? 560 : 470), SettingsView(initialTab: tab))
            }
            await shot("message-sheet", CGSize(width: 460, height: 330), MessageAgentSheet(agentId: store.structure?.roles.first?.id ?? "lead"))
            await shot("status-bar", CGSize(width: 700, height: 24), StatusBar())
        }
        NSApp.appearance = saved
        return written
    }

    /// The fixture's snapshot in another state: phase, with or without a result, idle statuses, lock state, backends.
    static func previewStore(from store: OfficeStore, phase: String, result: Bool, locked: Bool = true, codexSignedIn: Bool = true) -> OfficeStore {
        var snap = store.snapshot
        snap.state?.phase = phase
        snap.statuses = snap.statuses.mapValues { _ in AgentStatus(state: phase == "done" ? .done : .idle) }
        snap.inbox = nil
        if !result {
            snap.result = nil
            snap.verification = nil
        }
        if !locked {
            snap.structure?.locked = false
            snap.structure?.signature = nil
        }
        let session = SessionInfo(json: ["token": true, "runtime": true, "spec": "0.2",
                                         "backends": ["claude-code": ["available": true, "loggedIn": true, "version": "2.1.3"],
                                                      "codex": ["available": true, "loggedIn": .bool(codexSignedIn), "version": "0.58.0"]]])
        return OfficeStore.preview(snapshot: snap, projects: store.projects, session: session, now: store.now)
    }

    /// Setup rows in mixed states: ready, Codex not signed in, the team a draft.
    static func mixedSetup(_ s: Structure?) -> [SetupCheck.Item] {
        var draft = s
        draft?.locked = false
        let backends = ["claude-code": BackendStatus(available: true, loggedIn: true, version: "2.1.3"),
                        "codex": BackendStatus(available: true, loggedIn: false, version: "0.58.0")]
        return SetupCheck.items(SetupCheck.Input(nodeCheck: .found(URL(fileURLWithPath: "/opt/homebrew/bin/node"), NodeVersion(22, 11, 0)),
                                                 daemon: .running(DaemonInfo(url: URL(string: "http://127.0.0.1:4747")!, port: 4747, token: "-")),
                                                 runtime: true, backends: backends, workspace: URL(fileURLWithPath: NSHomeDirectory() + "/MAS Office"),
                                                 hasProject: true, structure: draft))
    }

    private static func render<V: View>(_ view: V, size: CGSize, appearance: NSAppearance, app: AppController, store: OfficeStore,
                                        to dir: URL, name: String) async -> Bool {
        let root = view
            .environment(app)
            .environment(store)
            .environment(Shared.ui)
            .frame(width: size.width, height: size.height, alignment: .top)
            .background(Color(nsColor: .windowBackgroundColor))
        let host = NSHostingView(rootView: root)
        host.frame = NSRect(origin: .zero, size: size)
        host.appearance = appearance
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = appearance
        window.contentView = host
        window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
        window.orderFrontRegardless()
        try? await Task.sleep(for: .milliseconds(800))
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        var data: Data?
        appearance.performAsCurrentDrawingAppearance { data = png(of: host, overlay: nil) }
        window.orderOut(nil)
        window.close()
        guard let data else { return false }
        return (try? data.write(to: dir.appendingPathComponent(name))) != nil
    }

    /// A titled window hosting `MainWindow` with its toolbar and title bridged, rendered whole (title bar included).
    private static func mainWindowPNG(size: CGSize, appearance: NSAppearance, app: AppController, store: OfficeStore) async -> Data? {
        let root = MainWindow()
            .environment(app)
            .environment(store)
            .environment(Shared.ui)
        let host = NSHostingView(rootView: root)
        host.sceneBridgingOptions = [.toolbars, .title]
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.toolbarStyle = .unified
        window.appearance = appearance
        window.contentView = host
        window.setContentSize(size)
        window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
        window.orderFrontRegardless()
        try? await Task.sleep(for: .seconds(4))
        guard let frameView = window.contentView?.superview else { return nil }
        frameView.layoutSubtreeIfNeeded()
        frameView.displayIfNeeded()
        var data: Data?
        appearance.performAsCurrentDrawingAppearance { data = png(of: frameView, overlay: nil) }
        window.orderOut(nil)
        window.close()
        return data
    }

    private static func png(of view: NSView, overlay: ((NSRect) -> Void)?) -> Data? {
        let size = view.bounds.size
        let scale: CGFloat = 2
        guard size.width > 0, size.height > 0,
              let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        NSColor.windowBackgroundColor.setFill()
        NSRect(origin: .zero, size: size).fill()
        if let layer = view.layer {
            let cg = ctx.cgContext
            cg.saveGState()
            let current = cg.ctm.a
            if current < scale - 0.01 { cg.scaleBy(x: scale / max(current, 0.01), y: scale / max(current, 0.01)) }
            if layer.isGeometryFlipped || view.isFlipped {
                cg.translateBy(x: 0, y: size.height)
                cg.scaleBy(x: 1, y: -1)
            }
            layer.render(in: cg)
            cg.restoreGState()
        } else {
            view.cacheDisplay(in: view.bounds, to: rep)
        }
        overlay?(NSRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])
    }
}
