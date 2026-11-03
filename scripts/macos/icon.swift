// Native, resolution-independent icon artwork for DSH SuperAgent.
import AppKit

let destination = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
func color(_ hex: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255,
            green: CGFloat((hex >> 8) & 255) / 255,
            blue: CGFloat(hex & 255) / 255, alpha: 1)
}
func rounded(_ rect: NSRect, _ radius: CGFloat, _ fill: UInt32) {
    color(fill).setFill()
    NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
}
func line(_ points: [NSPoint], _ width: CGFloat, _ stroke: UInt32) {
    let path = NSBezierPath(); path.move(to: points[0])
    for point in points.dropFirst() { path.line(to: point) }
    path.lineWidth = width; path.lineCapStyle = .round; path.lineJoinStyle = .round
    color(stroke).setStroke(); path.stroke()
}
func whale(_ ink: UInt32 = 0x174A7C) {
    let path = NSBezierPath()
    path.move(to: NSPoint(x: 878.11174, y: 741.66426))
    path.curve(to: NSPoint(x: 862.25715, y: 734.29299), controlPoint1: NSPoint(x: 870.24435, y: 745.59503), controlPoint2: NSPoint(x: 866.85440, y: 738.10227))
    path.curve(to: NSPoint(x: 858.01933, y: 729.99526), controlPoint1: NSPoint(x: 860.68275, y: 733.06266), controlPoint2: NSPoint(x: 859.35565, y: 731.46522))
    path.curve(to: NSPoint(x: 815.54739, y: 710.21005), controlPoint1: NSPoint(x: 846.53005, y: 717.45536), controlPoint2: NSPoint(x: 833.09773, y: 709.22701))
    path.curve(to: NSPoint(x: 748.63309, y: 683.42067), controlPoint1: NSPoint(x: 789.89773, y: 711.68000), controlPoint2: NSPoint(x: 767.98976, y: 703.45318))
    path.curve(to: NSPoint(x: 710.03034, y: 732.32691), controlPoint1: NSPoint(x: 744.51507, y: 708.11802), controlPoint2: NSPoint(x: 730.84314, y: 722.86208))
    path.curve(to: NSPoint(x: 680.50227, y: 752.84756), controlPoint1: NSPoint(x: 699.14010, y: 737.24058), controlPoint2: NSPoint(x: 688.13005, y: 742.16038))
    path.curve(to: NSPoint(x: 671.06816, y: 777.30499), controlPoint1: NSPoint(x: 675.17696, y: 760.46751), controlPoint2: NSPoint(x: 673.73005, y: 768.94254))
    path.curve(to: NSPoint(x: 661.99194, y: 788.36004), controlPoint1: NSPoint(x: 669.37242, y: 782.33754), controlPoint2: NSPoint(x: 667.67821, y: 787.49757))
    path.curve(to: NSPoint(x: 650.97574, y: 779.63756), controlPoint1: NSPoint(x: 655.82029, y: 789.34246), controlPoint2: NSPoint(x: 653.39802, y: 784.06246))
    path.curve(to: NSPoint(x: 637.91053, y: 721.51194), controlPoint1: NSPoint(x: 641.30048, y: 761.57005), controlPoint2: NSPoint(x: 637.54189, y: 741.66426))
    path.curve(to: NSPoint(x: 694.78246, y: 614.36058), controlPoint1: NSPoint(x: 638.75686, y: 676.16768), controlPoint2: NSPoint(x: 657.51450, y: 640.03942))
    path.curve(to: NSPoint(x: 698.77299, y: 604.16000), controlPoint1: NSPoint(x: 699.02029, y: 611.41299), controlPoint2: NSPoint(x: 700.10778, y: 608.46541))
    path.curve(to: NSPoint(x: 690.54464, y: 577.86522), controlPoint1: NSPoint(x: 696.23706, y: 595.31725), controlPoint2: NSPoint(x: 693.20806, y: 586.71565))
    path.curve(to: NSPoint(x: 680.38246, y: 573.44000), controlPoint1: NSPoint(x: 688.85043, y: 572.20966), controlPoint2: NSPoint(x: 686.31450, y: 570.98701))
    path.curve(to: NSPoint(x: 626.65318, y: 610.67725), controlPoint1: NSPoint(x: 659.93062, y: 582.16294), controlPoint2: NSPoint(x: 642.26816, y: 595.06995))
    path.curve(to: NSPoint(x: 546.30502, y: 688.33280), controlPoint1: NSPoint(x: 600.15565, y: 636.84454), controlPoint2: NSPoint(x: 576.19251, y: 665.72749))
    path.curve(to: NSPoint(x: 525.00531, y: 703.20435), controlPoint1: NSPoint(x: 539.28550, y: 693.61971), controlPoint2: NSPoint(x: 532.26445, y: 698.53184))
    path.curve(to: NSPoint(x: 536.99072, y: 761.20248), controlPoint1: NSPoint(x: 494.51725, y: 733.42976), controlPoint2: NSPoint(x: 529.00198, y: 758.25505))
    path.curve(to: NSPoint(x: 512.90778, y: 774.71744), controlPoint1: NSPoint(x: 545.33734, y: 764.27756), controlPoint2: NSPoint(x: 539.89222, y: 774.84493))
    path.curve(to: NSPoint(x: 429.77792, y: 753.09501), controlPoint1: NSPoint(x: 485.92179, y: 774.59748), controlPoint2: NSPoint(x: 461.23981, y: 765.37994))
    path.curve(to: NSPoint(x: 415.37792, y: 748.79007), controlPoint1: NSPoint(x: 425.18067, y: 751.24997), controlPoint2: NSPoint(x: 420.33459, y: 749.89998))
    path.curve(to: NSPoint(x: 326.19469, y: 751.98495), controlPoint1: NSPoint(x: 386.81754, y: 754.32504), controlPoint2: NSPoint(x: 357.16966, y: 755.55507))
    path.curve(to: NSPoint(x: 187.03247, y: 669.16198), controlPoint1: NSPoint(x: 267.86755, y: 745.35496), controlPoint2: NSPoint(x: 221.27744, y: 717.21574))
    path.curve(to: NSPoint(x: 148.06999, y: 477.34938), controlPoint1: NSPoint(x: 145.88749, y: 611.41299), controlPoint2: NSPoint(x: 136.20500, y: 545.79507))
    path.curve(to: NSPoint(x: 252.01249, y: 298.80474), controlPoint1: NSPoint(x: 160.52756, y: 405.21574), controlPoint2: NSPoint(x: 196.59500, y: 345.50067))
    path.curve(to: NSPoint(x: 451.18976, y: 231.21459), controlPoint1: NSPoint(x: 309.49222, y: 250.38541), controlPoint2: NSPoint(x: 375.68768, y: 226.66957))
    path.curve(to: NSPoint(x: 605.72058, y: 289.95430), controlPoint1: NSPoint(x: 497.05318, y: 233.92256), controlPoint2: NSPoint(x: 548.12058, y: 240.18483))
    path.curve(to: NSPoint(x: 660.77696, y: 277.42208), controlPoint1: NSPoint(x: 620.24038, y: 282.58304), controlPoint2: NSPoint(x: 635.48826, y: 279.63546))
    path.curve(to: NSPoint(x: 713.54010, y: 281.48019), controlPoint1: NSPoint(x: 680.26266, y: 275.57734), controlPoint2: NSPoint(x: 699.02029, y: 278.40512))
    path.curve(to: NSPoint(x: 726.48550, y: 311.82541), controlPoint1: NSPoint(x: 736.28826, y: 286.39232), controlPoint2: NSPoint(x: 734.71232, y: 307.89478))
    path.curve(to: NSPoint(x: 661.14560, y: 341.07546), controlPoint1: NSPoint(x: 659.80928, y: 343.53459), controlPoint2: NSPoint(x: 674.45043, y: 330.62758))
    path.curve(to: NSPoint(x: 766.05440, y: 562.25792), controlPoint1: NSPoint(x: 695.02208, y: 381.99450), controlPoint2: NSPoint(x: 746.08947, y: 424.51251))
    path.curve(to: NSPoint(x: 766.05440, y: 588.92749), controlPoint1: NSPoint(x: 767.63034, y: 573.19270), controlPoint2: NSPoint(x: 766.29555, y: 580.07706))
    path.curve(to: NSPoint(x: 773.19526, y: 597.03450), controlPoint1: NSPoint(x: 765.93459, y: 594.33574), controlPoint2: NSPoint(x: 767.14189, y: 596.42010))
    path.curve(to: NSPoint(x: 820.99251, y: 612.02739), controlPoint1: NSPoint(x: 789.89773, y: 599.00058), controlPoint2: NSPoint(x: 806.11174, y: 603.67309))
    path.curve(to: NSPoint(x: 885.73184, y: 723.10938), controlPoint1: NSPoint(x: 864.19251, y: 636.11034), controlPoint2: NSPoint(x: 881.62304, y: 675.67923))
    path.curve(to: NSPoint(x: 878.11174, y: 741.66426), controlPoint1: NSPoint(x: 886.34010, y: 730.36237), controlPoint2: NSPoint(x: 885.61203, y: 737.85498))
    path.close()
    path.move(to: NSPoint(x: 501.65043, y: 314.78067))
    path.curve(to: NSPoint(x: 392.74189, y: 382.97754), controlPoint1: NSPoint(x: 437.03706, y: 366.63450), controlPoint2: NSPoint(x: 405.69498, y: 383.71174))
    path.curve(to: NSPoint(x: 385.48275, y: 358.89459), controlPoint1: NSPoint(x: 380.64435, y: 382.23565), controlPoint2: NSPoint(x: 382.81933, y: 368.10445))
    path.curve(to: NSPoint(x: 396.97971, y: 335.54739), controlPoint1: NSPoint(x: 388.26445, y: 349.79686), controlPoint2: NSPoint(x: 391.90323, y: 343.52691))
    path.curve(to: NSPoint(x: 393.46995, y: 316.49792), controlPoint1: NSPoint(x: 400.48947, y: 330.26048), controlPoint2: NSPoint(x: 402.91174, y: 322.39309))
    path.curve(to: NSPoint(x: 334.78246, y: 321.78483), controlPoint1: NSPoint(x: 372.65715, y: 303.34976), controlPoint2: NSPoint(x: 336.47821, y: 320.92314))
    path.curve(to: NSPoint(x: 232.65505, y: 426.22976), controlPoint1: NSPoint(x: 292.66995, y: 347.09811), controlPoint2: NSPoint(x: 257.45746, y: 380.51686))
    path.curve(to: NSPoint(x: 192.47744, y: 567.79213), controlPoint1: NSPoint(x: 208.69253, y: 470.22541), controlPoint2: NSPoint(x: 194.78006, y: 517.40826))
    path.curve(to: NSPoint(x: 207.23748, y: 586.46682), controlPoint1: NSPoint(x: 191.86995, y: 579.95725), controlPoint2: NSPoint(x: 195.38002, y: 584.25498))
    path.curve(to: NSPoint(x: 254.55503, y: 587.69715), controlPoint1: NSPoint(x: 222.85245, y: 589.41440), controlPoint2: NSPoint(x: 238.94743, y: 590.03034))
    path.curve(to: NSPoint(x: 423.72454, y: 500.08218), controlPoint1: NSPoint(x: 320.50227, y: 577.86522), controlPoint2: NSPoint(x: 376.65536, y: 547.75962))
    path.curve(to: NSPoint(x: 491.85536, y: 408.77773), controlPoint1: NSPoint(x: 450.59072, y: 472.92570), controlPoint2: NSPoint(x: 470.91507, y: 440.48691))
    path.curve(to: NSPoint(x: 568.57242, y: 316.74522), controlPoint1: NSPoint(x: 514.11507, y: 375.11014), controlPoint2: NSPoint(x: 538.07821, y: 343.04000))
    path.curve(to: NSPoint(x: 596.15744, y: 295.36256), controlPoint1: NSPoint(x: 579.34285, y: 307.52768), controlPoint2: NSPoint(x: 587.93062, y: 300.52198))
    path.curve(to: NSPoint(x: 501.65043, y: 314.78067), controlPoint1: NSPoint(x: 571.35565, y: 292.53478), controlPoint2: NSPoint(x: 529.96966, y: 291.92038))
    path.close()
    path.move(to: NSPoint(x: 532.63309, y: 518.14246))
    path.curve(to: NSPoint(x: 542.19469, y: 527.85459), controlPoint1: NSPoint(x: 532.63309, y: 523.55072), controlPoint2: NSPoint(x: 536.86938, y: 527.85459))
    path.curve(to: NSPoint(x: 545.45715, y: 527.24019), controlPoint1: NSPoint(x: 543.40198, y: 527.85459), controlPoint2: NSPoint(x: 544.48947, y: 527.60730))
    path.curve(to: NSPoint(x: 548.96691, y: 524.89933), controlPoint1: NSPoint(x: 546.79194, y: 526.74560), controlPoint2: NSPoint(x: 548.00077, y: 526.00986))
    path.curve(to: NSPoint(x: 551.63034, y: 518.14246), controlPoint1: NSPoint(x: 550.66266, y: 523.18208), controlPoint2: NSPoint(x: 551.63034, y: 520.72294))
    path.curve(to: NSPoint(x: 542.06720, y: 508.43802), controlPoint1: NSPoint(x: 551.63034, y: 512.73574), controlPoint2: NSPoint(x: 547.39251, y: 508.43802))
    path.curve(to: NSPoint(x: 532.63309, y: 518.14246), controlPoint1: NSPoint(x: 536.74189, y: 508.43802), controlPoint2: NSPoint(x: 532.63309, y: 512.73574))
    path.close()
    path.move(to: NSPoint(x: 628.83430, y: 467.76474))
    path.curve(to: NSPoint(x: 610.55744, y: 462.72512), controlPoint1: NSPoint(x: 622.66266, y: 465.18426), controlPoint2: NSPoint(x: 616.48947, y: 462.97242))
    path.curve(to: NSPoint(x: 585.87546, y: 470.71232), controlPoint1: NSPoint(x: 601.36294, y: 462.23821), controlPoint2: NSPoint(x: 591.32058, y: 466.03981))
    path.curve(to: NSPoint(x: 568.81203, y: 494.67546), controlPoint1: NSPoint(x: 577.40749, y: 477.96531), controlPoint2: NSPoint(x: 571.35565, y: 482.01574))
    path.curve(to: NSPoint(x: 569.30048, y: 513.23034), controlPoint1: NSPoint(x: 567.72454, y: 500.08218), controlPoint2: NSPoint(x: 568.33280, y: 508.43802))
    path.curve(to: NSPoint(x: 561.91232, y: 536.21043), controlPoint1: NSPoint(x: 571.47546, y: 523.55072), controlPoint2: NSPoint(x: 569.05318, y: 530.18778))
    path.curve(to: NSPoint(x: 540.62029, y: 542.47270), controlPoint1: NSPoint(x: 556.10778, y: 541.12256), controlPoint2: NSPoint(x: 548.72730, y: 542.47270))
    path.curve(to: NSPoint(x: 532.75290, y: 544.93184), controlPoint1: NSPoint(x: 537.58976, y: 542.47270), controlPoint2: NSPoint(x: 534.80806, y: 543.83053))
    path.curve(to: NSPoint(x: 529.24314, y: 556.23526), controlPoint1: NSPoint(x: 529.36294, y: 546.65062), controlPoint2: NSPoint(x: 526.57971, y: 550.95450))
    path.curve(to: NSPoint(x: 535.17517, y: 562.87232), controlPoint1: NSPoint(x: 530.08947, y: 557.96019), controlPoint2: NSPoint(x: 534.20749, y: 562.13811))
    path.curve(to: NSPoint(x: 570.62758, y: 562.38541), controlPoint1: NSPoint(x: 546.18522, y: 569.26208), controlPoint2: NSPoint(x: 558.88947, y: 567.17773))
    path.curve(to: NSPoint(x: 601.61024, y: 537.68038), controlPoint1: NSPoint(x: 581.51782, y: 557.83270), controlPoint2: NSPoint(x: 589.74464, y: 549.47686))
    path.curve(to: NSPoint(x: 622.78246, y: 508.80512), controlPoint1: NSPoint(x: 613.70778, y: 523.42938), controlPoint2: NSPoint(x: 615.88275, y: 519.50029))
    path.curve(to: NSPoint(x: 636.57574, y: 482.01574), controlPoint1: NSPoint(x: 628.22758, y: 500.44928), controlPoint2: NSPoint(x: 633.19194, y: 491.84768))
    path.curve(to: NSPoint(x: 628.83430, y: 467.76474), controlPoint1: NSPoint(x: 638.63706, y: 475.87174), controlPoint2: NSPoint(x: 635.97517, y: 470.83213))
    path.close()
    color(ink).setFill(); path.fill()
}
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        let transform = NSAffineTransform(); transform.scale(by: CGFloat(pixels) / 1024); transform.concat()
        rounded(NSRect(x: 64, y: 64, width: 896, height: 896), 200, 0xFFFFFF)
        whale()
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 2 ? "@2x" : ""
        try bitmap.representation(using: .png, properties: [:])!.write(to:
            destination.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
    }
}

let template = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 80, pixelsHigh: 80,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: template)
let t = NSAffineTransform(); t.scale(by: 80.0 / 1024); t.concat()
whale(0x000000)
NSGraphicsContext.restoreGraphicsState()
try template.representation(using: .png, properties: [:])!.write(to: destination.deletingLastPathComponent().appendingPathComponent("WhaleTemplate.png"))
