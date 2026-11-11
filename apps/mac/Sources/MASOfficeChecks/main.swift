// MASOfficeChecks: `swift run MASOfficeChecks` runs every unit check (needs `node` on PATH for the JS parity
// expectations). `--integration` drives a scripted daemon (see apps/mac/scripts/integration-check.sh).
import Foundation
import MASOfficeKit

let arguments = CommandLine.arguments
if let i = arguments.firstIndex(of: "--spawn-and-die"), i + 1 < arguments.count {
    await spawnAndDie(arguments[i + 1])
}
if arguments.contains("--integration") {
    await integrationCheck()
    Harness.finish()
}
if arguments.contains("--supervision") {
    await supervisionIntegration(fixture: arguments.contains("--fixture"))
    Harness.finish()
}
decodingChecks()
sseChecks()
claimChecks()
await shellChecks()
await parityChecks()
await daemonChecks()
markdownChecks()
resultChecks()
await teamChecks()
setupChecks()
await supervisionChecks()
Harness.finish()
