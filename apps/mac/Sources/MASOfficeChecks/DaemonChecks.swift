import Foundation
import MASOfficeKit

/// A fake `node`: a bash script that ignores its arguments and behaves as `$FAKE_DAEMON_DIR/mode` says.
private let fakeNode = #"""
#!/bin/bash
dir="$FAKE_DAEMON_DIR"
n=$(( $(cat "$dir/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$dir/count"
echo "$$" > "$dir/pid.$n"
echo "fake daemon start $n ($*)" >&2
mode=$(cat "$dir/mode" 2>/dev/null || echo ok)
hs() { printf '{"url":"http://127.0.0.1:%d","port":%d,"token":"tok-%d","backends":{"claude-code":{"available":true,"loggedIn":true}},"maxParallel":2}\n' $((5000+n)) $((5000+n)) "$n"; }
case "$mode" in
  crash) sleep 0.2; echo "✗ boom $n" >&2; exit 3 ;;
  crash-after-ready) hs; sleep 0.3; exit 4 ;;
  port) echo "✗ Port 0 is already in use. Try --port 1." >&2; exit 1 ;;
  silent) cat > /dev/null; exit 0 ;;
  stubborn) hs; trap '' TERM; exec 0<&-; while true; do sleep 0.2; done ;;
  *) hs; cat > /dev/null; echo stopped > "$dir/stopped.$n"; echo "stdin closed" >&2; exit 0 ;;
esac
"""#

@MainActor
private func makeFake(_ name: String, mode: String) -> (DaemonConfiguration, URL) {
    let dir = Harness.scratch("daemon-\(name)")
    try? FileManager.default.removeItem(at: dir)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let node = dir.appendingPathComponent("node")
    try? fakeNode.write(to: node, atomically: true, encoding: .utf8)
    try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
    let script = dir.appendingPathComponent("mas-office.js")
    try? "// stand-in".write(to: script, atomically: true, encoding: .utf8)
    try? mode.write(to: dir.appendingPathComponent("mode"), atomically: true, encoding: .utf8)
    var cfg = DaemonConfiguration(node: node, script: script, workspace: dir, maxParallel: 2,
                                  environment: ["PATH": "/usr/bin:/bin", "HOME": NSHomeDirectory(), "FAKE_DAEMON_DIR": dir.path])
    cfg.restartBaseDelay = .milliseconds(100)
    cfg.handshakeTimeout = .seconds(2)
    cfg.stopGrace = .milliseconds(500)
    return (cfg, dir)
}

private func alive(_ pid: Int32) -> Bool { kill(pid, 0) == 0 }

/// Wait until `predicate(state)` holds, at most `timeout` seconds; returns the states seen.
private func waitFor(_ d: DaemonController, timeout: Double, _ predicate: @escaping @Sendable (DaemonState) -> Bool) async -> (ok: Bool, seen: [DaemonState]) {
    let stream = await d.states()
    return await withTaskGroup(of: (Bool, [DaemonState]).self) { group in
        group.addTask {
            var seen: [DaemonState] = []
            for await s in stream {
                seen.append(s)
                if predicate(s) { return (true, seen) }
            }
            return (false, seen)
        }
        group.addTask {
            try? await Task.sleep(for: .seconds(timeout))
            return (false, [])
        }
        let first = await group.next() ?? (false, [])
        group.cancelAll()
        return first
    }
}

private func readInt(_ url: URL) -> Int32? {
    (try? String(contentsOf: url, encoding: .utf8)).flatMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
}

@MainActor
func daemonChecks() async {
    Harness.section("DaemonController against a fake node")

    // 1. Handshake, then stop by closing stdin.
    do {
        let (cfg, dir) = makeFake("ok", mode: "ok")
        let d = DaemonController(configuration: cfg)
        await d.start()
        let r = await waitFor(d, timeout: 5) { $0.info != nil }
        Harness.check(r.ok, "handshake → running")
        let info = await d.state.info
        Harness.equal(info?.token, "tok-1", "token from the handshake line")
        Harness.equal(info?.url.absoluteString, "http://127.0.0.1:5001", "url")
        Harness.equal(info?.backends["claude-code"]?.ready, true, "backends")
        let pid = await d.pid
        Harness.check(pid.map(alive) == true, "child alive")
        await d.stop()
        let stopped = await d.state
        Harness.equal(stopped, .notStarted, "stopped state")
        Harness.check(FileManager.default.fileExists(atPath: dir.appendingPathComponent("stopped.1").path), "the child saw stdin close and shut down by itself")
        Harness.check(pid.map(alive) == false, "child gone after stop")
    }

    // 2. Crash after ready → restart with backoff → give up after 3 restarts within a minute.
    do {
        let (cfg, dir) = makeFake("crash", mode: "crash-after-ready")
        let d = DaemonController(configuration: cfg)
        await d.start()
        let r = await waitFor(d, timeout: 15) { $0.failure != nil }
        Harness.check(r.ok, "crash loop ends in failed")
        let final = await d.state
        if case .crashLoop(let n, _)? = final.failure { Harness.equal(n, 4, "fails at the 4th exit within the window") } else {
            Harness.check(false, "crashLoop failure, got \(final)")
        }
        let starts = r.seen.compactMap { s -> Int? in if case .starting(let a) = s { return a }; return nil }
        Harness.check(starts.contains(1) && starts.contains(2) && starts.contains(3), "restart attempts 1, 2, 3 seen (\(starts))")
        Harness.equal(readInt(dir.appendingPathComponent("count")), 4, "started 4 times (1 + 3 restarts)")
        Harness.check(r.seen.contains { $0.info?.token == "tok-2" }, "a restart hands over a new handshake")
    }

    // 3. Crash before the handshake: the last message is kept as a hint (in memory only).
    do {
        let (cfg, _) = makeFake("early", mode: "crash")
        let d = DaemonController(configuration: cfg)
        await d.start()
        let r = await waitFor(d, timeout: 15) { $0.failure != nil }
        Harness.check(r.ok, "early crash loop ends in failed")
        let f = await d.state.failure
        Harness.check(f?.hint?.contains("boom") == true, "hint carries the last line (\(f?.hint ?? "nil"))")
    }

    // 4. Port in use: no restarts, a specific hint.
    do {
        let (cfg, dir) = makeFake("port", mode: "port")
        let d = DaemonController(configuration: cfg)
        await d.start()
        let r = await waitFor(d, timeout: 5) { $0.failure != nil }
        Harness.equal(r.seen.last?.failure, .portInUse, "port in use")
        Harness.check(DaemonFailure.portInUse.hint != nil, "port hint")
        Harness.equal(readInt(dir.appendingPathComponent("count")), 1, "no restart for port in use")
    }

    // 5. No handshake in time: fail and terminate the child.
    do {
        let (cfg, dir) = makeFake("silent", mode: "silent")
        let d = DaemonController(configuration: cfg)
        await d.start()
        let r = await waitFor(d, timeout: 6) { $0.failure != nil }
        Harness.equal(r.seen.last?.failure, .handshakeTimeout, "handshake timeout")
        try? await Task.sleep(for: .milliseconds(500))
        Harness.check(readInt(dir.appendingPathComponent("pid.1")).map(alive) == false, "silent child terminated")
    }

    // 6. A child that ignores stdin and SIGTERM is killed.
    do {
        let (cfg, dir) = makeFake("stubborn", mode: "stubborn")
        let d = DaemonController(configuration: cfg)
        await d.start()
        _ = await waitFor(d, timeout: 5) { $0.info != nil }
        let started = Date()
        await d.stop()
        let took = Date().timeIntervalSince(started)
        Harness.check(readInt(dir.appendingPathComponent("pid.1")).map(alive) == false, "stubborn child killed (SIGKILL after grace + SIGTERM wait, \(String(format: "%.1f", took)) s)")
    }

    // 6b. The synchronous lifeline the app uses at quit: stdin close for a healthy child, signals for a stuck one.
    do {
        let (cfg, dir) = makeFake("lifeline", mode: "ok")
        let d = DaemonController(configuration: cfg)
        await d.start()
        _ = await waitFor(d, timeout: 5) { $0.info != nil }
        let gone = d.lifeline.stopBlocking(grace: 3)
        Harness.check(gone && FileManager.default.fileExists(atPath: dir.appendingPathComponent("stopped.1").path), "lifeline: stdin closed, child shut down by itself")
        Harness.check(d.lifeline.stopBlocking(), "lifeline: nothing to stop afterwards")
        let (cfg2, dir2) = makeFake("lifeline-stubborn", mode: "stubborn")
        let d2 = DaemonController(configuration: cfg2)
        await d2.start()
        _ = await waitFor(d2, timeout: 5) { $0.info != nil }
        Harness.check(d2.lifeline.stopBlocking(grace: 0.3), "lifeline: a stuck child is killed")
        Harness.check(readInt(dir2.appendingPathComponent("pid.1")).map(alive) == false, "lifeline: stuck child gone")
    }

    // 7. Missing engine and workspace are explained.
    do {
        var (cfg, _) = makeFake("missing", mode: "ok")
        cfg.script = URL(fileURLWithPath: "/nonexistent/mas-office.js")
        let d = DaemonController(configuration: cfg)
        await d.start()
        if case .engineMissing? = await d.state.failure { Harness.check(true, "") } else { Harness.check(false, "engine missing reported") }
        Harness.check(DaemonFailure.nodeNotFound.hint?.contains("18.14") == true, "Node-not-found hint names the version")
        Harness.check(DaemonFailure.nodeTooOld(found: "16.0.0", path: "/usr/local/bin/node").hint?.contains("/usr/local/bin/node") == true, "Node-too-old hint")
    }

    // 8. No orphan when the app dies: a child process starts the daemon and exits without stopping it.
    do {
        let (cfg, dir) = makeFake("orphan", mode: "ok")
        _ = cfg
        let me = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        let out = await ProcessRunner.run(me, arguments: ["--spawn-and-die", dir.path], timeout: .seconds(20))
        Harness.equal(out.status, 7, "the helper died without stopping its daemon")
        let pid = readInt(dir.appendingPathComponent("pid.1"))
        var gone = false
        for _ in 0..<40 {
            if pid.map(alive) == false { gone = true; break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        Harness.check(pid != nil && gone, "the orphaned daemon exits by itself when its parent dies")
        Harness.check(FileManager.default.fileExists(atPath: dir.appendingPathComponent("stopped.1").path), "…through stdin closing (clean shutdown)")
    }
}

/// `--spawn-and-die <dir>`: start a fake daemon from `dir`, wait for it, then exit abruptly (status 7).
@MainActor
func spawnAndDie(_ dirPath: String) async -> Never {
    let dir = URL(fileURLWithPath: dirPath)
    var cfg = DaemonConfiguration(node: dir.appendingPathComponent("node"), script: dir.appendingPathComponent("mas-office.js"), workspace: dir,
                                  environment: ["PATH": "/usr/bin:/bin", "HOME": NSHomeDirectory(), "FAKE_DAEMON_DIR": dir.path])
    cfg.handshakeTimeout = .seconds(5)
    let d = DaemonController(configuration: cfg)
    await d.start()
    for _ in 0..<50 {
        if await d.state.info != nil { break }
        try? await Task.sleep(for: .milliseconds(100))
    }
    _exit(7)
}
