import Foundation
import MASOfficeKit

/// A tiny check harness: `swift test` needs Xcode, so checks are a program that exits non-zero on failure.
@MainActor
enum Harness {
    static var passed = 0
    static var failed = 0
    static var failures: [String] = []

    static func section(_ name: String) {
        print("\n== \(name)")
    }

    static func check(_ ok: Bool, _ what: @autoclosure () -> String, file: StaticString = #fileID, line: UInt = #line) {
        if ok {
            passed += 1
        } else {
            failed += 1
            let msg = "\(file):\(line) \(what())"
            failures.append(msg)
            print("  FAIL \(msg)")
        }
    }

    static func equal<T: Equatable>(_ a: T, _ b: T, _ what: @autoclosure () -> String, file: StaticString = #fileID, line: UInt = #line) {
        check(a == b, "\(what()): got \(a), expected \(b)", file: file, line: line)
    }

    static func note(_ s: String) {
        print("  · \(s)")
    }

    /// The repository root (this file is apps/mac/Sources/MASOfficeChecks/Harness.swift).
    static let repo: URL = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    static func scratch(_ name: String) -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("mas-office-checks-\(ProcessInfo.processInfo.processIdentifier)/\(name)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Read a `.js` twin file.
    static func twin(_ url: URL) -> JSTwin.Document {
        JSTwin.parse((try? String(contentsOf: url, encoding: .utf8)) ?? "")
    }

    /// `node` from PATH or the usual places.
    static var node: URL? {
        ShellEnvironment(variables: ProcessInfo.processInfo.environment, source: .fallback("checks")).locate("node")
    }

    static func finish() -> Never {
        print("\n\(passed) passed, \(failed) failed")
        if failed > 0 {
            print("Failures:")
            failures.forEach { print("  - \($0)") }
        }
        exit(failed > 0 ? 1 : 0)
    }
}

func ms(_ d: Date?) -> Double? { d.map { ($0.timeIntervalSince1970 * 1000).rounded() } }
func date(ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }
