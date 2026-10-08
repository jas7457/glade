// Encodes a folder of numbered JPEG/PNG frames into an H.264 MP4 with AVFoundation (built into
// macOS, so the captures need no ffmpeg with an H.264 encoder; I-209).
//
//   swift encode-mp4.swift <framesDir> <fps> <width> <height> <bitsPerSecond> <out.mp4> [cropX cropY cropW cropH]
//
// Frames are read in name order and scaled to width×height; with a crop (source pixels, from the
// top left), only that region, scaled to width×height (the website's focus videos).
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO

let args = CommandLine.arguments
guard args.count == 7 || args.count == 11, let fps = Int32(args[2]), let width = Int(args[3]), let height = Int(args[4]), let bitrate = Int(args[5]) else {
  FileHandle.standardError.write("usage: encode-mp4.swift <framesDir> <fps> <width> <height> <bitsPerSecond> <out.mp4>\n".data(using: .utf8)!)
  exit(2)
}
let crop: CGRect? = args.count == 11 ? CGRect(x: Double(args[7])!, y: Double(args[8])!, width: Double(args[9])!, height: Double(args[10])!) : nil
let dir = URL(fileURLWithPath: args[1])
let out = URL(fileURLWithPath: args[6])
try? FileManager.default.removeItem(at: out)
let frames = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".jpg") || $0.hasSuffix(".png") }.sorted()

let writer = try AVAssetWriter(outputURL: out, fileType: .mp4)
let settings: [String: Any] = [
  AVVideoCodecKey: AVVideoCodecType.h264,
  AVVideoWidthKey: width,
  AVVideoHeightKey: height,
  AVVideoCompressionPropertiesKey: [
    AVVideoAverageBitRateKey: bitrate,
    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
    AVVideoMaxKeyFrameIntervalKey: Int(fps) * 2,
    AVVideoAllowFrameReorderingKey: true,
  ],
]
let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
  kCVPixelBufferWidthKey as String: width,
  kCVPixelBufferHeightKey as String: height,
])
writer.add(input)
writer.movieFragmentInterval = .invalid
writer.shouldOptimizeForNetworkUse = true
guard writer.startWriting() else { fatalError("can't start: \(String(describing: writer.error))") }
writer.startSession(atSourceTime: .zero)

for (i, name) in frames.enumerated() {
  guard let src = CGImageSourceCreateWithURL(dir.appendingPathComponent(name) as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { continue }
  while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.005) }
  var buffer: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer)
  guard let pb = buffer else { fatalError("no pixel buffer") }
  CVPixelBufferLockBaseAddress(pb, [])
  let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb), width: width, height: height, bitsPerComponent: 8,
                      bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: CGColorSpace(name: CGColorSpace.sRGB)!,
                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
  ctx.interpolationQuality = .high
  if let c = crop {
    // Scale so the crop fills the output; CG's origin is bottom left.
    let s = Double(width) / c.width
    let h = Double(image.height)
    ctx.draw(image, in: CGRect(x: -c.minX * s, y: -(h - c.maxY) * s, width: Double(image.width) * s, height: h * s))
  } else {
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  }
  CVPixelBufferUnlockBaseAddress(pb, [])
  adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: fps))
}
input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
if writer.status != .completed { fatalError("failed: \(String(describing: writer.error))") }
print("wrote \(frames.count) frames to \(out.path)")
