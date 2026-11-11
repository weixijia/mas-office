// swift-tools-version: 6.0
// MAS Office for macOS: a native shell around the `mas-office up` daemon.
//
//   MASOfficeKit     models, API client, event stream, daemon control, environment discovery, pure logic
//   MASOffice        the SwiftUI app
//   MASOfficeChecks  checks (`swift run MASOfficeChecks`); `swift test` needs Xcode, which this project does not
import PackageDescription

let package = Package(
    name: "MASOffice",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "MASOfficeKit", targets: ["MASOfficeKit"]),
        .executable(name: "MASOffice", targets: ["MASOffice"]),
        .executable(name: "MASOfficeChecks", targets: ["MASOfficeChecks"]),
    ],
    targets: [
        .target(name: "MASOfficeKit"),
        .executableTarget(name: "MASOffice", dependencies: ["MASOfficeKit"]),
        .executableTarget(name: "MASOfficeChecks", dependencies: ["MASOfficeKit"]),
    ],
    swiftLanguageModes: [.v6]
)
