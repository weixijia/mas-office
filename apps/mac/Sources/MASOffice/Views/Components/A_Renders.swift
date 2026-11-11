import AppKit
import MASOfficeKit
import SwiftUI

/// `--render` pictures of the supervision views: the inbox, the agent page (each segment) and the menu bar
/// menu's content, in light and dark, at inspector widths 320 and 420. Called by `Renderer.run` after the
/// store has data and an agent is selected.
@MainActor
enum SupervisionRenders {
    static func run(directory dir: URL, app: AppController, store: OfficeStore) async -> [String] {
        var written: [String] = []
        let sui = SupervisionUI.shared
        let savedSegment = sui.agentSegment
        // The agent page of someone with a transcript: who waits on you first, then the team in order.
        let candidates = store.waitingAgents.map(\.id) + (store.structure?.memberIds ?? [])
        for id in candidates {
            await store.loadTranscript(id)
            if store.transcripts[id]?.status == .ok, store.transcripts[id]?.entries.isEmpty == false {
                store.selectAgent(id)
                break
            }
        }
        if let id = store.selectedAgentId {
            await store.loadTranscript(id)
            await store.loadWorkFiles(id)
        }
        for (mode, name) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
            guard let appearance = NSAppearance(named: name) else { continue }
            for width in [320, 420] {
                let inbox = "inbox-\(mode)-\(width).png"
                if await render(InboxView(), size: CGSize(width: width, height: 1500), appearance: appearance, app: app, store: store, to: dir, name: inbox) {
                    written.append(inbox)
                }
                for segment in AgentSegment.allCases {
                    sui.agentSegment = segment
                    let file = "agent-\(segment.rawValue.lowercased())-\(mode)-\(width).png"
                    if await render(AgentDetailView(), size: CGSize(width: width, height: segment == .terminal ? 1500 : 2600), appearance: appearance, app: app, store: store, to: dir, name: file) {
                        written.append(file)
                    }
                }
            }
            let menu = "menubar-menu-\(mode).png"
            if await render(MenuBarMenuPreview().padding(12), size: CGSize(width: 444, height: 420), appearance: appearance, app: app, store: store,
                            to: dir, name: menu) {
                written.append(menu)
            }
        }
        sui.agentSegment = savedSegment
        return written
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
        try? await Task.sleep(for: .milliseconds(700))
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        var data: Data?
        appearance.performAsCurrentDrawingAppearance { data = png(of: host) }
        window.orderOut(nil)
        window.close()
        guard let data else { return false }
        return (try? data.write(to: dir.appendingPathComponent(name))) != nil
    }

    /// The view's layer tree in a 2× PNG.
    private static func png(of view: NSView) -> Data? {
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
            // The bitmap context starts in pixels: draw points at 2×.
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
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])
    }
}
