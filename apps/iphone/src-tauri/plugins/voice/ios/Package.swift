// swift-tools-version:5.9
// Glade's conversation-mode plugin (I-180); built and linked by tauri-plugin's build script (swift-rs).

import PackageDescription

let package = Package(
  name: "tauri-plugin-voice",
  platforms: [.iOS(.v17)],
  products: [
    .library(name: "tauri-plugin-voice", type: .static, targets: ["tauri-plugin-voice"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(name: "tauri-plugin-voice", dependencies: [.byName(name: "Tauri")], path: "Sources")
  ]
)
