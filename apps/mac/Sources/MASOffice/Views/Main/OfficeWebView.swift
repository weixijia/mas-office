import AppKit
import MASOfficeKit
import SwiftUI
import WebKit

/// The isometric office: the existing web panel in embed mode (`/office/?view=office&project=…`) inside a
/// WKWebView. Everything else is native.
///
/// - The token is handed over without putting it in the address: a document-start user script stores it in
///   `sessionStorage` under the key the panel reads (`mas-office-token`), only on the daemon's origin.
/// - Clicking an agent posts `{type: 'select', agentId}` to the `masOffice` handler, which selects it in the
///   store; a native selection is shown in the drawing through `window.MASEmbed.select(id)`.
/// - Only the daemon's origin loads here. Links elsewhere open in the default browser; nothing else loads.
/// - No file access; developer extras only in debug builds.
struct OfficeWebView: NSViewRepresentable {
    var daemonURL: URL
    var token: String
    var project: String?
    /// The store's selection, passed in so a change re-runs `updateNSView`.
    var selection: String?
    var store: OfficeStore
    var web: OfficeWebState

    /// `<daemon>/office/?view=office&project=<p>`. Never carries the token.
    static func address(daemonURL: URL, project: String?) -> URL? {
        guard var c = URLComponents(url: daemonURL, resolvingAgainstBaseURL: false) else { return nil }
        c.path = "/office/"
        c.queryItems = [URLQueryItem(name: "view", value: "office")] + (project.map { [URLQueryItem(name: "project", value: $0)] } ?? [])
        return c.url
    }

    static func origin(of url: URL) -> String {
        "\(url.scheme ?? "http")://\(url.host ?? "")" + (url.port.map { ":\($0)" } ?? "")
    }

    /// A JavaScript string literal for `s` (JSON-encoded).
    static func jsString(_ s: String) -> String {
        JSONValue.string(s).jsonText()
    }

    func makeCoordinator() -> Coordinator { Coordinator(store: store, web: web) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        let controller = WKUserContentController()
        let origin = Self.origin(of: daemonURL)
        let handover = """
        (function () {
          if (location.origin !== \(Self.jsString(origin))) return;
          try { sessionStorage.setItem('mas-office-token', \(Self.jsString(token))); } catch (e) { /* storage blocked */ }
        })();
        """
        controller.addUserScript(WKUserScript(source: handover, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(WeakScriptHandler(context.coordinator), name: "masOffice")
        config.userContentController = controller

        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = false
        view.allowsMagnification = false
        view.setValue(false, forKey: "drawsBackground")
        #if DEBUG
        view.isInspectable = true
        #endif
        context.coordinator.view = view
        context.coordinator.origin = origin
        load(view, context: context)
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        let c = context.coordinator
        c.store = store
        if c.loadedAddress != Self.address(daemonURL: daemonURL, project: project) {
            c.origin = Self.origin(of: daemonURL)
            load(view, context: context)
        }
        c.show(selection)
    }

    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "masOffice")
        view.stopLoading()
    }

    private func load(_ view: WKWebView, context: Context) {
        guard let url = Self.address(daemonURL: daemonURL, project: project) else { return }
        context.coordinator.loadedAddress = url
        context.coordinator.shownSelection = .some(nil)
        web.loaded = false
        web.ready = false
        web.error = nil
        web.address = url.absoluteString
        view.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var store: OfficeStore
        let web: OfficeWebState
        weak var view: WKWebView?
        var origin = ""
        var loadedAddress: URL?
        /// What the drawing shows as selected (`.some(nil)`: nothing; `nil`: unknown, push on ready).
        var shownSelection: String??

        init(store: OfficeStore, web: OfficeWebState) {
            self.store = store
            self.web = web
        }

        /// Show a native selection in the drawing (once the panel is ready).
        func show(_ id: String?) {
            guard web.ready, let view, shownSelection != .some(id) else { return }
            shownSelection = .some(id)
            view.callAsyncJavaScript("window.MASEmbed && window.MASEmbed.select(id)", arguments: ["id": id ?? NSNull()],
                                     in: nil, in: .page, completionHandler: nil)
        }

        func received(_ body: Any) {
            guard let msg = body as? [String: Any], let type = msg["type"] as? String else { return }
            switch type {
            case "ready":
                web.ready = true
                shownSelection = nil
                show(store.selectedAgentId)
            case "select":
                let id = msg["agentId"] as? String
                shownSelection = .some(id)
                store.selectAgent(id, origin: .office)
            default:
                break
            }
        }

        private func sameOrigin(_ url: URL) -> Bool { OfficeWebView.origin(of: url) == origin }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = navigationAction.request.url else { return .cancel }
            // The panel itself (and its own reloads) is the only page that loads here. (`URL.path` drops the
            // trailing slash, so read the path from the components.)
            let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.path ?? ""
            if sameOrigin(url), path.hasPrefix("/office/") { return .allow }
            // A link the person clicked (a source, a workspace file) opens in the default browser.
            if navigationAction.navigationType == .linkActivated, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                NSWorkspace.shared.open(url)
            }
            return .cancel
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                NSWorkspace.shared.open(url)
            }
            return nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            web.loaded = true
            web.error = nil
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            web.error = error.localizedDescription
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            web.error = error.localizedDescription
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            web.ready = false
            web.loaded = false
            webView.reload()
        }
    }
}

/// Forwards script messages without the user content controller keeping the coordinator alive.
@MainActor
final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: OfficeWebView.Coordinator?

    init(_ target: OfficeWebView.Coordinator) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.received(message.body)
    }
}
