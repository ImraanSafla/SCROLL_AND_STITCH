// Generates a synthetic "screen recording" of a tall page being scrolled,
// with a fixed header (status bar + nav bar) and footer (tab bar + home
// indicator), encoded like an iPhone recording (HEVC by default, 60 fps).
// Also writes <output>.json with the true scroll offset of every frame so
// the stitcher can be checked against ground truth.
//
// Also writes <output>.png: the perfect stitched result (clean header, the
// whole page, footer) for pixel comparison.
//
// Usage: swift scripts/make-sample-video.swift <out.mp4> [hevc|h264] [seed] [style] [junk]
//   style: "pauses" (default) – scroll a screenful, pause, repeat
//          "continuous" – one steady scroll with no pauses
//          "fast" – quick flicks with short pauses
//   junk:  "junk" adds a Control Centre swipe at the start, a dimmed
//          stop-recording prompt at the end, and the red recording pill
//          behind the clock in every frame.

import AVFoundation
import CoreGraphics
import CoreText
import CoreVideo
import Foundation
import ImageIO

let args = CommandLine.arguments
let outPath = args.count > 1 ? args[1] : "scroll-demo.mp4"
let codec: AVVideoCodecType = (args.count > 2 && args[2] == "h264") ? .h264 : .hevc
var seed: UInt64 = args.count > 3 ? UInt64(args[3]) ?? 7 : 7
let style = args.count > 4 ? args[4] : "pauses"
let junk = args.count > 5 && args[5] == "junk"

// 1178 rather than the iPhone's 1179: HEVC encoders round odd widths.
let W = 1178, H = 2556, FPS = 60
let pageH = 9000
let headerH = 162 + 132   // status bar + navigation bar
let footerH = 249         // tab bar + home indicator
let viewH = H - headerH - footerH
let maxOffset = Double(pageH - viewH)

func rnd() -> Double {
    seed = seed &* 6364136223846793005 &+ 1442695040888963407
    return Double(seed >> 11) / Double(UInt64(1) << 53)
}

let cs = CGColorSpace(name: CGColorSpace.sRGB)!
func makeContext(_ w: Int, _ h: Int) -> CGContext {
    CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
              bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
}
func color(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) -> CGColor {
    CGColor(colorSpace: cs, components: [r, g, b, a])!
}
/// Fill a rect given in top-left coordinates within a context of height `h`.
func fill(_ ctx: CGContext, _ h: Int, x: Double, top: Double, w: Double, hgt: Double, _ c: CGColor, radius: Double = 0) {
    let r = CGRect(x: x, y: Double(h) - top - hgt, width: w, height: hgt)
    ctx.setFillColor(c)
    if radius > 0 {
        ctx.addPath(CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil))
        ctx.fillPath()
    } else {
        ctx.fill(r)
    }
}
func text(_ ctx: CGContext, _ h: Int, _ s: String, x: Double, top: Double, size: Double, _ c: CGColor) {
    let font = CTFontCreateWithName("Helvetica-Bold" as CFString, size, nil)
    let attr = NSAttributedString(string: s, attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): c,
    ])
    let line = CTLineCreateWithAttributedString(attr)
    ctx.textPosition = CGPoint(x: x, y: Double(h) - top - size)
    CTLineDraw(line, ctx)
}

// ---- Page ----
let page = makeContext(W, pageH)
fill(page, pageH, x: 0, top: 0, w: Double(W), hgt: Double(pageH), color(1, 1, 1))
var y = 48.0
var section = 1
let margin = 60.0
let contentW = Double(W) - 2 * margin
while y < Double(pageH) - 300 {
    let kind = rnd()
    if kind < 0.18 {
        // Heading
        text(page, pageH, "Section \(section)", x: margin, top: y, size: 64, color(0.07, 0.07, 0.09))
        section += 1
        y += 110
    } else if kind < 0.42 {
        // Image block
        let hgt = 320 + rnd() * 420
        let c1 = color(rnd() * 0.8 + 0.1, rnd() * 0.8 + 0.1, rnd() * 0.8 + 0.1)
        fill(page, pageH, x: margin, top: y, w: contentW, hgt: hgt, c1, radius: 28)
        for _ in 0..<6 {
            let d = 60 + rnd() * 160
            fill(page, pageH, x: margin + rnd() * (contentW - d), top: y + rnd() * (hgt - d), w: d, hgt: d,
                 color(rnd(), rnd(), rnd(), 0.7), radius: d / 2)
        }
        y += hgt + 56
    } else if kind < 0.47 && y > 2000 && y < 6000 {
        // Large blank gap (hard case for matching)
        y += 500
    } else {
        // Paragraph: lines of "text"
        let lines = 3 + Int(rnd() * 6)
        for i in 0..<lines {
            let isLast = i == lines - 1
            let lw = contentW * (isLast ? 0.35 + rnd() * 0.4 : 0.82 + rnd() * 0.18)
            var x = margin
            while x < margin + lw - 30 {
                let ww = min(40 + rnd() * 150, margin + lw - x)
                fill(page, pageH, x: x, top: y, w: ww, hgt: 30, color(0.18, 0.18, 0.2), radius: 6)
                x += ww + 18
            }
            y += 54
        }
        y += 40
    }
}

// ---- Header & footer (fixed chrome) ----
func makeHeader(pill: Bool) -> CGImage {
    let header = makeContext(W, headerH)
    fill(header, headerH, x: 0, top: 0, w: Double(W), hgt: Double(headerH), color(0.97, 0.97, 0.98))
    if pill { fill(header, headerH, x: 66, top: 46, w: 200, hgt: 76, color(1, 0.231, 0.188), radius: 38) } // recording pill
    text(header, headerH, "9:41", x: 110, top: 64, size: 50, pill ? color(1, 1, 1) : color(0, 0, 0))
    fill(header, headerH, x: Double(W) / 2 - 190, top: 34, w: 380, hgt: 110, color(0, 0, 0), radius: 55) // island
    fill(header, headerH, x: Double(W) - 200, top: 72, w: 96, hgt: 44, color(0, 0, 0), radius: 12)       // battery
    text(header, headerH, "Example Page", x: Double(W) / 2 - 190, top: 162 + 34, size: 56, color(0, 0, 0))
    fill(header, headerH, x: 0, top: Double(headerH) - 2, w: Double(W), hgt: 2, color(0.8, 0.8, 0.82))
    return header.makeImage()!
}
let cleanHeaderImg = makeHeader(pill: false)
let headerImg = makeHeader(pill: junk)

let footer = makeContext(W, footerH)
fill(footer, footerH, x: 0, top: 0, w: Double(W), hgt: Double(footerH), color(0.97, 0.97, 0.98))
fill(footer, footerH, x: 0, top: 0, w: Double(W), hgt: 2, color(0.8, 0.8, 0.82))
for i in 0..<5 {
    let cx = Double(W) / 5 * (Double(i) + 0.5)
    fill(footer, footerH, x: cx - 36, top: 30, w: 72, hgt: 72, i == 0 ? color(0.04, 0.42, 1) : color(0.6, 0.6, 0.62), radius: 18)
}
fill(footer, footerH, x: Double(W) / 2 - 200, top: Double(footerH) - 36, w: 400, hgt: 15, color(0, 0, 0), radius: 7.5)
let footerImg = footer.makeImage()!
let pageImg = page.makeImage()!

// ---- Scroll schedule ----
struct Seg { let start: Double; let dur: Double; let from: Double; let to: Double }
var segs: [Seg] = []
var t = 0.0
var pos = 0.0
func ease(_ x: Double) -> Double { x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2 }
switch style {
case "continuous":
    t = 0.6
    segs.append(Seg(start: t, dur: 8.0, from: 0, to: maxOffset))
    t += 8.0 + 0.8
case "fast":
    t = 0.5
    while pos < maxOffset {
        let next = min(maxOffset, pos + Double(viewH) * (0.7 + rnd() * 0.25))
        segs.append(Seg(start: t, dur: 0.35, from: pos, to: next))
        t += 0.35 + 0.22
        pos = next
    }
    t += 0.6
default:
    t = 0.8
    while pos < maxOffset {
        let next = min(maxOffset, pos + Double(viewH) * (0.65 + rnd() * 0.25))
        let dur = 0.55 + rnd() * 0.25
        segs.append(Seg(start: t, dur: dur, from: pos, to: next))
        t += dur + 0.35 + rnd() * 0.3
        pos = next
    }
    t += 0.6
}
let totalSec = t
func offsetAt(_ time: Double) -> Double {
    var o = 0.0
    for s in segs {
        if time >= s.start + s.dur { o = s.to }
        else if time >= s.start { return s.from + (s.to - s.from) * ease((time - s.start) / s.dur) }
        else { break }
    }
    return o
}

// ---- Encode ----
let url = URL(fileURLWithPath: outPath)
try? FileManager.default.removeItem(at: url)
let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: codec,
    AVVideoWidthKey: W,
    AVVideoHeightKey: H,
    AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 10_000_000, AVVideoExpectedSourceFrameRateKey: FPS],
])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: W,
    kCVPixelBufferHeightKey as String: H,
])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)

let lead = junk ? 0.6 : 0.0   // Control Centre being swiped away
let tail = junk ? 0.5 : 0.0   // "Stop screen recording?" prompt
let frames = Int(((lead + totalSec + tail) * Double(FPS)).rounded())
var truth: [[String: Double]] = []
for f in 0..<frames {
    let time = Double(f) / Double(FPS)
    let scrollTime = min(totalSec, max(0, time - lead))
    let off = offsetAt(scrollTime).rounded()
    let inLead = time < lead
    let inTail = time >= lead + totalSec
    truth.append(["t": time, "offset": off, "junk": (inLead || inTail) ? 1 : 0])
    while !input.isReadyForMoreMediaData { usleep(2000) }
    var pb: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
    let buf = pb!
    CVPixelBufferLockBaseAddress(buf, [])
    let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buf), width: W, height: H, bitsPerComponent: 8,
                        bytesPerRow: CVPixelBufferGetBytesPerRow(buf), space: cs,
                        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    let crop = pageImg.cropping(to: CGRect(x: 0, y: Int(off), width: W, height: viewH))!
    ctx.draw(crop, in: CGRect(x: 0, y: footerH, width: W, height: viewH))
    ctx.draw(headerImg, in: CGRect(x: 0, y: H - headerH, width: W, height: headerH))
    ctx.draw(footerImg, in: CGRect(x: 0, y: 0, width: W, height: footerH))
    if inLead {
        // Control Centre: dark blur-like overlay with tiles, fading out at the end.
        let a = min(1, (lead - time) / 0.15)
        fill(ctx, H, x: 0, top: 0, w: Double(W), hgt: Double(H), color(0.08, 0.08, 0.1, 0.82 * a))
        for i in 0..<12 {
            let cx = 90 + Double(i % 4) * 260, cy = 360 + Double(i / 4) * 260
            fill(ctx, H, x: cx, top: cy, w: 220, hgt: 220, color(1, 1, 1, 0.28 * a), radius: 50)
        }
        fill(ctx, H, x: 90, top: 1200, w: 1000, hgt: 500, color(1, 1, 1, 0.22 * a), radius: 60)
    } else if inTail {
        // Dimmed screen with the stop-recording prompt.
        fill(ctx, H, x: 0, top: 0, w: Double(W), hgt: Double(H), color(0, 0, 0, 0.45))
        fill(ctx, H, x: 240, top: 1000, w: 700, hgt: 420, color(0.95, 0.95, 0.96), radius: 40)
        text(ctx, H, "Stop recording?", x: 340, top: 1080, size: 56, color(0, 0, 0))
        fill(ctx, H, x: 240, top: 1300, w: 700, hgt: 2, color(0.7, 0.7, 0.7))
    }
    CVPixelBufferUnlockBaseAddress(buf, [])
    adaptor.append(buf, withPresentationTime: CMTime(value: CMTimeValue(f), timescale: CMTimeScale(FPS)))
}
input.markAsFinished()
let sem = DispatchSemaphore(value: 0)
writer.finishWriting { sem.signal() }
sem.wait()
if writer.status != .completed { print("Failed: \(String(describing: writer.error))"); exit(1) }

// Perfect result: clean header, the whole page, footer.
let truthH = headerH + pageH + footerH
let tctx = makeContext(W, truthH)
tctx.draw(footerImg, in: CGRect(x: 0, y: 0, width: W, height: footerH))
tctx.draw(pageImg, in: CGRect(x: 0, y: footerH, width: W, height: pageH))
tctx.draw(cleanHeaderImg, in: CGRect(x: 0, y: footerH + pageH, width: W, height: headerH))
let pngURL = URL(fileURLWithPath: outPath.replacingOccurrences(of: ".mp4", with: ".png"))
let dest = CGImageDestinationCreateWithURL(pngURL as CFURL, "public.png" as CFString, 1, nil)!
CGImageDestinationAddImage(dest, tctx.makeImage()!, nil)
CGImageDestinationFinalize(dest)

let meta: [String: Any] = [
    "width": W, "height": H, "fps": FPS, "pageHeight": pageH,
    "headerHeight": headerH, "footerHeight": footerH, "style": style,
    "durationSec": lead + totalSec + tail, "junkLead": lead, "junkTail": tail,
    "pill": junk ? [66, 46, 200, 76] : [], "frames": truth,
]
let json = try JSONSerialization.data(withJSONObject: meta, options: [])
try json.write(to: URL(fileURLWithPath: outPath.replacingOccurrences(of: ".mp4", with: ".json")))
print("Wrote \(outPath): \(frames) frames, \(String(format: "%.2f", totalSec)) s, \(segs.count) scrolls")
