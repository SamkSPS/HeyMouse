import AppKit

struct EdgeEvent: Encodable {
    let type = "file-drag-enter"
    let name: String
    let size: Int
    let x: CGFloat
    let y: CGFloat
}

final class DropEdge: NSView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        registerForDraggedTypes([.fileURL])
        wantsLayer = true
        layer?.backgroundColor = NSColor.systemGreen.cgColor
    }

    required init?(coder: NSCoder) { return nil }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        if let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL],
           urls.count == 1,
           let file = urls.first,
           let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
           values.isRegularFile == true,
           let size = values.fileSize,
           let point = window?.convertPoint(toScreen: sender.draggingLocation),
           let encoded = try? JSONEncoder().encode(EdgeEvent(name: file.lastPathComponent, size: size, x: point.x, y: point.y)) {
            FileHandle.standardOutput.write(encoded + Data([10]))
        }
        // Observe the drag; never move or copy the original into the edge.
        return []
    }
}

guard CommandLine.arguments.count == 2,
      let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main else {
    fputs("Uso: EdgeDragProbe left|right|top|bottom\n", stderr)
    exit(2)
}
let frame = screen.frame
let thickness: CGFloat = 16
let edge: NSRect
switch CommandLine.arguments[1] {
case "left": edge = NSRect(x: frame.minX, y: frame.minY, width: thickness, height: frame.height)
case "right": edge = NSRect(x: frame.maxX - thickness, y: frame.minY, width: thickness, height: frame.height)
case "top": edge = NSRect(x: frame.minX, y: frame.maxY - thickness, width: frame.width, height: thickness)
case "bottom": edge = NSRect(x: frame.minX, y: frame.minY, width: frame.width, height: thickness)
default:
    fputs("Uso: EdgeDragProbe left|right|top|bottom\n", stderr)
    exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let panel = NSPanel(contentRect: edge, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
panel.level = .floating
panel.hidesOnDeactivate = false
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
panel.contentView = DropEdge(frame: NSRect(origin: .zero, size: edge.size))
panel.orderFrontRegardless()
Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { _ in NSApp.terminate(nil) }
app.run()
