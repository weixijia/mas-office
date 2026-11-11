import Foundation

/// Launch arguments and environment the app understands.
///
///   --attach-url <url> --attach-token <token>   use a running daemon instead of starting one
///                                               (or MAS_OFFICE_ATTACH_URL / MAS_OFFICE_ATTACH_TOKEN)
///   --workspace <path>                          use this workspace (not remembered)
///   --self-check <file.json>                    run for `--self-check-seconds` (default 10), write a report, quit
///   --render <dir>                              write PNG renders of the main views to <dir>, then quit
///
/// The token is only ever held in memory; `description` hides it.
public struct LaunchOptions: Sendable, Equatable, CustomStringConvertible {
    public var attachURL: URL?
    public var attachToken: String?
    public var workspace: String?
    public var selfCheckPath: String?
    public var selfCheckSeconds: Double = 10
    public var renderDirectory: String?

    public init() {}

    /// Attach to an existing daemon: both URL and token given, URL on loopback.
    public var attach: DaemonInfo? {
        guard let attachURL, let attachToken, !attachToken.isEmpty,
              let host = attachURL.host, ["127.0.0.1", "localhost", "::1", "[::1]"].contains(host) else { return nil }
        return DaemonInfo(url: attachURL, port: attachURL.port ?? 0, token: attachToken)
    }

    /// A run that checks or renders and quits by itself (no confirmations, no onboarding prompts).
    public var isAutomated: Bool { selfCheckPath != nil || renderDirectory != nil }

    public var description: String {
        "LaunchOptions(attach: \(attachURL?.absoluteString ?? "no"), token: \(attachToken == nil ? "none" : "<redacted>"), "
            + "workspace: \(workspace ?? "default"), selfCheck: \(selfCheckPath ?? "no"), render: \(renderDirectory ?? "no"))"
    }

    /// Parse. Arguments win over environment variables. Unknown arguments (AppKit's own) are ignored.
    public static func parse(arguments: [String], environment: [String: String]) -> LaunchOptions {
        var o = LaunchOptions()
        o.attachURL = environment["MAS_OFFICE_ATTACH_URL"].flatMap(URL.init(string:))
        o.attachToken = environment["MAS_OFFICE_ATTACH_TOKEN"]
        var i = 0
        func value() -> String? {
            guard i + 1 < arguments.count else { return nil }
            i += 1
            return arguments[i]
        }
        while i < arguments.count {
            let a = arguments[i]
            let (name, inline): (String, String?) = {
                guard a.hasPrefix("--"), let eq = a.firstIndex(of: "=") else { return (a, nil) }
                return (String(a[..<eq]), String(a[a.index(after: eq)...]))
            }()
            switch name {
            case "--attach-url": if let v = inline ?? value() { o.attachURL = URL(string: v) }
            case "--attach-token": if let v = inline ?? value() { o.attachToken = v }
            case "--workspace": o.workspace = inline ?? value()
            case "--self-check": o.selfCheckPath = inline ?? value()
            case "--self-check-seconds": if let v = (inline ?? value()).flatMap(Double.init), v > 0 { o.selfCheckSeconds = v }
            case "--render": o.renderDirectory = inline ?? value()
            default: break
            }
            i += 1
        }
        return o
    }
}
