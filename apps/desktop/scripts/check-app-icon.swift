// Diagnostic for app switchers (AltTab, ⌘Tab, Dock): prints what macOS reports for running
// Glade processes, i.e. the data `NSRunningApplication.icon` hands to AltTab.
// Usage: swift apps/desktop/scripts/check-app-icon.swift [name-substring]   (default "Glade")
import AppKit

let needle = CommandLine.arguments.dropFirst().first ?? "Glade"
let generic = NSWorkspace.shared.icon(for: .unixExecutable)
let genericTiff = generic.tiffRepresentation ?? Data()

func describe(_ image: NSImage?) -> String {
    guard let image else { return "nil" }
    let reps = image.representations.map { "\(Int($0.pixelsWide))px" }.joined(separator: ",")
    let tiff = image.tiffRepresentation ?? Data()
    return "\(tiff == genericTiff ? "GENERIC exec icon" : "custom icon") (reps: \(reps))"
}

var found = 0
for app in NSWorkspace.shared.runningApplications {
    let name = app.localizedName ?? ""
    let exe = app.executableURL?.path ?? ""
    // Regular apps only: skips WebKit helper processes named "Glade Web Content" etc.
    guard app.activationPolicy == .regular, name.contains(needle) || exe.contains(needle) else { continue }
    found += 1
    print("pid \(app.processIdentifier)  name: \(name)")
    print("  bundleIdentifier: \(app.bundleIdentifier ?? "nil")")
    print("  bundleURL:        \(app.bundleURL?.path ?? "nil")")
    print("  executableURL:    \(exe)")
    print("  activationPolicy: \(app.activationPolicy.rawValue) (0 = regular)")
    print("  icon:             \(describe(app.icon))")
    if let url = app.bundleURL {
        print("  icon(forFile:):   \(describe(NSWorkspace.shared.icon(forFile: url.path)))")
    }
}
if found == 0 { print("no running app matching \"\(needle)\"") }
