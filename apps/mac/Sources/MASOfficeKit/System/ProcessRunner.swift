import Foundation
import os

/// Runs a short-lived child process to completion with a deadline, collecting stdout. Never runs a shell
/// unless asked to (the executable is called directly), and never logs what it collects.
public enum ProcessRunner {
    public struct Output: Sendable {
        public var stdout: Data
        /// Exit status; nil when it was killed at the deadline or could not start.
        public var status: Int32?
        public var timedOut: Bool
        public var launchError: String?
    }

    /// Run `executable` with `arguments`. `stdin` is closed (EOF) so prompts read nothing. `done` may end the
    /// read early (e.g. at a closing delimiter): the process is then killed and the output returned.
    public static func run(_ executable: URL, arguments: [String], environment: [String: String]? = nil,
                           currentDirectory: URL? = nil, timeout: Duration,
                           done: (@Sendable (Data) -> Bool)? = nil) async -> Output {
        struct State: Sendable {
            var data = Data()
            var finished = false
            var continuation: CheckedContinuation<Output, Never>?
            var status: Int32?
            var timedOut = false
            var exited = false
            var eof = false
            var pid: Int32 = 0
        }
        let lock = OSAllocatedUnfairLock(initialState: State())
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        if let environment { process.environment = environment }
        if let currentDirectory { process.currentDirectoryURL = currentDirectory }
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice

        /// Resume once: when the process exited and stdout reached EOF, when `done` says so, or at the deadline.
        @Sendable func finish(_ mutate: @Sendable (inout State) -> Void, force: Bool) {
            let resume: (CheckedContinuation<Output, Never>, Output, Int32)? = lock.withLock { s in
                mutate(&s)
                guard !s.finished, force || (s.exited && s.eof), let c = s.continuation else { return nil }
                s.finished = true
                s.continuation = nil
                // Ended early (done or deadline): the child must not linger.
                let killPid: Int32 = s.exited ? 0 : s.pid
                return (c, Output(stdout: s.data, status: s.timedOut ? nil : s.status, timedOut: s.timedOut, launchError: nil), killPid)
            }
            if let (c, o, pid) = resume {
                if pid > 0 { kill(pid, SIGKILL) }
                c.resume(returning: o)
            }
        }

        return await withCheckedContinuation { (c: CheckedContinuation<Output, Never>) in
            lock.withLock { $0.continuation = c }
            out.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                if chunk.isEmpty {
                    handle.readabilityHandler = nil
                    finish({ $0.eof = true }, force: false)
                    return
                }
                let enough: Bool = lock.withLock { s in
                    s.data.append(chunk)
                    return done?(s.data) ?? false
                }
                if enough {
                    handle.readabilityHandler = nil
                    finish({ _ in }, force: true)
                }
            }
            process.terminationHandler = { p in
                let status = p.terminationStatus
                finish({ $0.status = status; $0.exited = true }, force: false)
            }
            do {
                try process.run()
            } catch {
                out.fileHandleForReading.readabilityHandler = nil
                let c: CheckedContinuation<Output, Never>? = lock.withLock { s in
                    s.finished = true
                    defer { s.continuation = nil }
                    return s.continuation
                }
                c?.resume(returning: Output(stdout: Data(), status: nil, timedOut: false, launchError: error.localizedDescription))
                return
            }
            let pid = process.processIdentifier
            let endedEarly: Bool = lock.withLock { s in
                s.pid = pid
                return s.finished && !s.exited
            }
            if endedEarly { kill(pid, SIGKILL) }
            Task.detached {
                try? await Task.sleep(for: timeout)
                finish({ $0.timedOut = true }, force: true)
            }
        }
    }
}
