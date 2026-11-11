import AppKit
import MASOfficeKit
import SwiftUI
import WebKit

/// `--self-check <file.json>`: run for a while, write what can be checked without screen access (windows,
/// store connection, web view load), then quit. The report never contains the token.
@MainActor
enum SelfCheck {
    static func run(path: String, seconds: Double) async {
        try? await Task.sleep(for: .seconds(seconds))
        let app = Shared.app, store = app.store, web = Shared.web
        let windows = NSApp.windows.filter { !($0 is NSPanel) && $0.className != "NSStatusBarWindow" }
        let main = windows.filter { $0.identifier?.rawValue.hasPrefix("main") == true }
        var report: [String: Any] = [
            "uptimeSeconds": Date().timeIntervalSince(app.launchedAt),
            "windowCount": windows.count,
            "visibleWindowCount": windows.filter(\.isVisible).count,
            "mainWindowVisible": main.contains(where: \.isVisible),
            "mainWindowTitle": main.first?.title ?? NSNull(),
            "daemon": app.daemonState.line,
            "attached": app.isAttached,
            "connection": store.connection.key,
            "connectionLine": store.connection.line,
            "sessionToken": store.session?.tokenValid ?? NSNull(),
            "runtime": store.session?.runtime ?? NSNull(),
            "projects": store.projects?.projects.map(\.folder) ?? [],
            "currentProject": store.currentProject ?? NSNull(),
            "team": store.structure?.memberIds ?? [],
            "needsYou": store.needsYouCount,
            "webView": [
                "loaded": web.loaded,
                "ready": web.ready,
                "error": web.error ?? NSNull(),
                "address": web.address ?? NSNull(),
                "addressHasToken": web.address?.contains(app.daemonState.info?.token ?? "\u{0}") ?? false,
            ] as [String: Any],
        ]
        if let pid = await app.daemonPID() { report["daemonPid"] = Int(pid) }
        report["notifications"] = AttentionNotifier.shared.selfCheckInfo
        if let view = Renderer.findWebView(in: NSApp.windows.compactMap(\.contentView)) {
            // Did the token reach the panel's sessionStorage (without being in the address)?
            let handedOver = try? await view.callAsyncJavaScript("return sessionStorage.getItem('mas-office-token') === t && !location.href.includes(t)",
                                                                 arguments: ["t": app.daemonState.info?.token ?? ""], in: nil, contentWorld: .page)
            let embed = try? await view.callAsyncJavaScript("return document.body.classList.contains('embed') && typeof window.MASEmbed === 'object'",
                                                            arguments: [:], in: nil, contentWorld: .page)
            report["webViewState"] = ["isLoading": view.isLoading, "progress": view.estimatedProgress, "url": view.url?.absoluteString ?? NSNull(),
                                      "title": view.title ?? NSNull(), "frame": NSStringFromRect(view.frame),
                                      "tokenHandedOver": (handedOver as? Bool) ?? false, "embedMode": (embed as? Bool) ?? false] as [String: Any]
        } else {
            report["webViewState"] = "no WKWebView in the window"
        }
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
        }
        NSApp.terminate(nil)
    }
}

/// `--render <dir>`: write PNG renders of the main window and the main views, then quit, so layout can be
/// reviewed without screen-recording permission.
///
/// SwiftUI's `ImageRenderer` draws placeholders for AppKit-backed controls (lists, scroll views, text fields,
/// segmented pickers) on macOS, which is most of these views, so each view is hosted in an off-screen window
/// and its layer tree is rendered into a bitmap instead. The office web view is captured with
/// `WKWebView.takeSnapshot` and composited into the window render.
@MainActor
enum Renderer {
    static func run(directory: String) async {
        let dir = URL(fileURLWithPath: (directory as NSString).expandingTildeInPath, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let app = Shared.app, store = app.store
        // Wait for data and the office drawing (bounded).
        for _ in 0..<200 where store.structure == nil { try? await Task.sleep(for: .milliseconds(100)) }
        for _ in 0..<100 where !Shared.web.ready { try? await Task.sleep(for: .milliseconds(100)) }
        try? await Task.sleep(for: .seconds(2.5)) // the drawing prints itself in
        var written: [String] = []

        Shared.ui.show(.inbox)
        try? await Task.sleep(for: .milliseconds(400))
        if let window = NSApp.windows.first(where: { $0.identifier?.rawValue.hasPrefix("main") == true && $0.isVisible }),
           let data = await windowPNG(window) {
            try? data.write(to: dir.appendingPathComponent("main-window.png"))
            written.append("main-window.png")
        }
        if let web = findWebView(in: NSApp.windows.compactMap(\.contentView)), let data = await webPNG(web) {
            try? data.write(to: dir.appendingPathComponent("office.png"))
            written.append("office.png")
        }

        // An agent to show: the first that waits on you, else the Lead.
        let agent = store.waitingAgents.first?.id ?? "lead"
        store.selectAgent(agent)
        for _ in 0..<30 where store.transcripts[agent]?.status == .loading || store.transcripts[agent] == nil {
            try? await Task.sleep(for: .milliseconds(100))
        }

        let views: [(String, CGSize, AnyView)] = [
            ("sidebar.png", CGSize(width: 260, height: 620), AnyView(SidebarView())),
            ("inbox.png", CGSize(width: 380, height: 900), AnyView(InboxView())),
            ("agent.png", CGSize(width: 380, height: 760), AnyView(AgentDetailView())),
            ("result.png", CGSize(width: 420, height: 820), AnyView(ResultView())),
            ("run-controls.png", CGSize(width: 400, height: 260), AnyView(RunControlsView().padding())),
            ("settings.png", CGSize(width: 520, height: 520), AnyView(SettingsView())),
            ("onboarding.png", CGSize(width: 640, height: 420), AnyView(OnboardingView())),
            ("engine-failed.png", CGSize(width: 640, height: 420), AnyView(EngineFailurePreview())),
        ]
        for (name, size, view) in views {
            let hosted = view
                .environment(app)
                .environment(store)
                .environment(Shared.ui)
                .frame(width: size.width, height: size.height)
                .background(Color(nsColor: .windowBackgroundColor))
            if let data = await offscreenPNG(hosted, size: size) {
                try? data.write(to: dir.appendingPathComponent(name))
                written.append(name)
            }
        }
        written += await SupervisionRenders.run(directory: dir, app: app, store: store)
        written += await ChromeRenders.run(directory: dir, app: app, store: store)
        let index = ["files": written, "agent": agent, "project": store.currentProject ?? ""] as [String: Any]
        if let data = try? JSONSerialization.data(withJSONObject: index, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: dir.appendingPathComponent("renders.json"))
        }
        NSApp.terminate(nil)
    }

    static func findWebView(in views: [NSView]) -> WKWebView? {
        for v in views {
            if let w = v as? WKWebView { return w }
            if let w = findWebView(in: v.subviews) { return w }
        }
        return nil
    }

    private static func webPNG(_ web: WKWebView) async -> Data? {
        let image: NSImage? = await withCheckedContinuation { c in
            web.takeSnapshot(with: nil) { image, _ in c.resume(returning: image) }
        }
        guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }

    /// The window's content, with the office web view's snapshot drawn where it sits.
    private static func windowPNG(_ window: NSWindow) async -> Data? {
        guard let content = window.contentView?.superview ?? window.contentView else { return nil }
        let web = findWebView(in: [content])
        let webImage: NSImage? = await {
            guard let web else { return nil }
            return await withCheckedContinuation { c in web.takeSnapshot(with: nil) { image, _ in c.resume(returning: image) } }
        }()
        return png(of: content) { _ in
            guard let web, let webImage else { return }
            let r = web.convert(web.bounds, to: content)
            let rect = content.isFlipped ? NSRect(x: r.minX, y: content.bounds.height - r.maxY, width: r.width, height: r.height) : r
            webImage.draw(in: rect)
        }
    }

    private static func offscreenPNG<V: View>(_ view: V, size: CGSize) async -> Data? {
        let host = NSHostingView(rootView: view)
        host.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
        window.orderFrontRegardless()
        try? await Task.sleep(for: .milliseconds(600))
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        let data = png(of: host, overlay: nil)
        window.orderOut(nil)
        window.close()
        return data
    }

    /// Render a view's layer tree (and its subviews) into a 2× PNG.
    private static func png(of view: NSView, overlay: ((NSRect) -> Void)?) -> Data? {
        let size = view.bounds.size
        let scale: CGFloat = 2
        guard size.width > 0, size.height > 0,
              let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        rep.size = size
        guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        NSColor.windowBackgroundColor.setFill()
        NSRect(origin: .zero, size: size).fill()
        if let layer = view.layer {
            let cg = ctx.cgContext
            cg.saveGState()
            // A flipped hosting view's root layer is geometry-flipped; `render(in:)` draws it bottom-up.
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

/// The engine-failure screen with a sample failure, for the render.
private struct EngineFailurePreview: View {
    var body: some View {
        let f = DaemonFailure.nodeNotFound
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 34)).foregroundStyle(Palette.ochre)
            Text(f.reason).font(.title3.weight(.semibold))
            Text(f.hint ?? "").multilineTextAlignment(.center).foregroundStyle(.secondary).frame(maxWidth: 460)
            HStack {
                Button("Try Again") {}
                Button("Choose Workspace…") {}
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
