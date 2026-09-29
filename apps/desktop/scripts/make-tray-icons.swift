// Draws the menu bar (tray) icons, I-150: template images (black + alpha; macOS tints them).
//
//   swift apps/desktop/scripts/make-tray-icons.swift apps/desktop/src-tauri/icons/tray
//
// The leaf from icon/icon.svg (same path and tilt, midrib cut out), 36×36 px (shown at 18 pt, so
// crisp on Retina), with an optional badge at the bottom right (working: a ring; needs you: a
// filled dot) and "sharing" arcs at the top left. Files: tray-<state>.png with state in
// idle, working, needs, sharing, sharing-working, sharing-needs (see src-tauri/src/tray.rs).
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 36
let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."

enum Badge { case none, working, needs }

func draw(badge: Badge, sharing: Bool) -> CGImage {
    let ctx = CGContext(
        data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    // SVG-like coordinates: y down.
    ctx.translateBy(x: 0, y: CGFloat(size))
    ctx.scaleBy(x: 1, y: -1)
    ctx.setFillColor(CGColor(gray: 0, alpha: 1))
    ctx.setStrokeColor(CGColor(gray: 0, alpha: 1))

    // The leaf: icon.svg's path (a 1024 canvas, leaf ~600 tall), scaled to fit.
    ctx.saveGState()
    ctx.translateBy(x: 17.5, y: 18)
    ctx.rotate(by: 38 * .pi / 180)
    let k: CGFloat = 0.047
    ctx.scaleBy(x: k, y: k)
    let leaf = CGMutablePath()
    leaf.move(to: CGPoint(x: 0, y: -300))
    leaf.addCurve(to: CGPoint(x: 0, y: 262), control1: CGPoint(x: 205, y: -170), control2: CGPoint(x: 215, y: 130))
    leaf.addCurve(to: CGPoint(x: 0, y: -300), control1: CGPoint(x: -215, y: 130), control2: CGPoint(x: -205, y: -170))
    leaf.closeSubpath()
    ctx.addPath(leaf)
    ctx.fillPath()
    // Stem.
    ctx.setLineWidth(34)
    ctx.setLineCap(.round)
    ctx.move(to: CGPoint(x: 0, y: 250))
    ctx.addQuadCurve(to: CGPoint(x: -16, y: 344), control: CGPoint(x: 4, y: 300))
    ctx.strokePath()
    // Midrib, cut out.
    ctx.setBlendMode(.clear)
    ctx.setLineWidth(40)
    ctx.move(to: CGPoint(x: 0, y: -170))
    ctx.addLine(to: CGPoint(x: 0, y: 200))
    ctx.strokePath()
    ctx.restoreGState()

    func knockout(_ rect: CGRect) {
        ctx.saveGState()
        ctx.setBlendMode(.clear)
        ctx.fillEllipse(in: rect)
        ctx.restoreGState()
    }

    // Badge, bottom right, with a transparent gap around it.
    let badgeRect = CGRect(x: 23, y: 23, width: 12, height: 12)
    switch badge {
    case .none: break
    case .working:
        knockout(badgeRect.insetBy(dx: -2, dy: -2))
        ctx.setLineWidth(2.6)
        ctx.strokeEllipse(in: badgeRect.insetBy(dx: 1.3, dy: 1.3))
    case .needs:
        knockout(badgeRect.insetBy(dx: -2, dy: -2))
        ctx.fillEllipse(in: badgeRect)
    }

    // Sharing: two arcs radiating from the top-left corner.
    if sharing {
        ctx.saveGState()
        ctx.setBlendMode(.clear)
        ctx.fill(CGRect(x: 0, y: 0, width: 15, height: 15))
        ctx.restoreGState()
        ctx.setLineWidth(2.4)
        ctx.setLineCap(.round)
        let center = CGPoint(x: 1.5, y: 1.5)
        for r in [6.5, 12.0] as [CGFloat] {
            ctx.addArc(center: center, radius: r, startAngle: 0.08 * .pi, endAngle: 0.42 * .pi, clockwise: false)
            ctx.strokePath()
        }
        ctx.fillEllipse(in: CGRect(x: 0, y: 0, width: 4, height: 4))
    }
    return ctx.makeImage()!
}

func write(_ image: CGImage, _ name: String) {
    let url = URL(fileURLWithPath: outDir).appendingPathComponent("tray-\(name).png")
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    // 144 dpi: a 36 px image is 18 pt.
    CGImageDestinationAddImage(dest, image, [kCGImagePropertyDPIWidth: 144, kCGImagePropertyDPIHeight: 144] as CFDictionary)
    precondition(CGImageDestinationFinalize(dest), "couldn't write \(url.path)")
    print(url.path)
}

try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
// No sharing mark (the user found the arcs confusing): the leaf, plus the working / needs-you badges.
for (badge, name) in [(Badge.none, "idle"), (.working, "working"), (.needs, "needs")] {
    write(draw(badge: badge, sharing: false), name)
}
