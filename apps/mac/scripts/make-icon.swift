// Draws the app icon set from docs/assets/logo.svg: the logo on a light "drawing sheet" tile, every size an
// .iconset needs. Build and run: swiftc -o make-icon make-icon.swift && ./make-icon <logo.svg> <out.iconset>
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let logo = NSImage(contentsOfFile: args[1]), logo.size.width > 0 else {
    FileHandle.standardError.write(Data("usage: make-icon <logo.svg> <out.iconset> (the SVG must load)\n".utf8))
    exit(2)
}
let out = URL(fileURLWithPath: args[2], isDirectory: true)
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

/// One square icon of `pixels` × `pixels`, drawn on the macOS icon grid (an 824/1024 tile with the logo inside).
func render(_ pixels: Int) -> Data? {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
                                     hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
    let s = CGFloat(pixels) / 1024
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ctx
    ctx.imageInterpolation = .high
    let tile = NSRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s)
    let path = NSBezierPath(roundedRect: tile, xRadius: 185 * s, yRadius: 185 * s)
    // The panel's sheet colour, with a hairline so the tile reads on light and dark backgrounds.
    NSColor(srgbRed: 0xF3 / 255, green: 0xF4 / 255, blue: 0xF1 / 255, alpha: 1).setFill()
    path.fill()
    NSColor(srgbRed: 0xB9 / 255, green: 0xC0 / 255, blue: 0xC6 / 255, alpha: 1).setStroke()
    path.lineWidth = max(1, 6 * s)
    path.stroke()
    let width = 600 * s
    let height = width * logo.size.height / logo.size.width
    let rect = NSRect(x: (CGFloat(pixels) - width) / 2, y: (CGFloat(pixels) - height) / 2 + 12 * s, width: width, height: height)
    logo.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
}

for base in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let name = scale == 1 ? "icon_\(base)x\(base).png" : "icon_\(base)x\(base)@2x.png"
        guard let data = render(base * scale) else { exit(1) }
        try data.write(to: out.appendingPathComponent(name))
    }
}
