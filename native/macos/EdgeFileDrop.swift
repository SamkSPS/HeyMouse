import AppKit

enum Edge: String {
    case left, right, top, bottom

    func distance(from cursor: NSPoint, in frame: NSRect) -> CGFloat {
        switch self {
        case .left: return cursor.x - frame.minX
        case .right: return frame.maxX - cursor.x
        case .top: return frame.maxY - cursor.y
        case .bottom: return cursor.y - frame.minY
        }
    }

    func strip(in frame: NSRect) -> NSRect {
        let thickness: CGFloat = 12
        switch self {
        case .left: return NSRect(x: frame.minX, y: frame.minY, width: thickness, height: frame.height)
        case .right: return NSRect(x: frame.maxX - thickness, y: frame.minY, width: thickness, height: frame.height)
        case .top: return NSRect(x: frame.minX, y: frame.maxY - thickness, width: frame.width, height: thickness)
        case .bottom: return NSRect(x: frame.minX, y: frame.minY, width: frame.width, height: thickness)
        }
    }
}

final class EdgeView: NSView {
    struct Drop: Encodable { let path: String }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        highlight(false)
        registerForDraggedTypes([.fileURL])
    }

    required init?(coder: NSCoder) { return nil }

    func highlight(_ active: Bool) {
        layer?.backgroundColor = NSColor(
            red: 0.75, green: 0.93, blue: 0.39, alpha: active ? 0.9 : 1.0 / 255
        ).cgColor
    }

    private func file(_ sender: NSDraggingInfo) -> URL? {
        guard sender.draggingSourceOperationMask.contains(.copy),
              let files = sender.draggingPasteboard.readObjects(
                forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]
              ) as? [URL], files.count == 1, let file = files.first,
              (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { return nil }
        return file
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        let copy = file(sender) != nil
        highlight(copy)
        return copy ? .copy : []
    }

    override func draggingExited(_ sender: NSDraggingInfo?) { highlight(false) }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let file = file(sender), let json = try? JSONEncoder().encode(Drop(path: file.path)) else { return false }
        FileHandle.standardOutput.write(json + Data([10]))
        highlight(false)
        window?.orderOut(nil)
        return true
    }
}

guard CommandLine.arguments.count == 2, let edge = Edge(rawValue: CommandLine.arguments[1]) else { exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
panel.level = .floating
panel.hidesOnDeactivate = false
panel.isOpaque = false
panel.backgroundColor = .clear
panel.hasShadow = false
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
let edgeView = EdgeView(frame: .zero)
panel.contentView = edgeView

var started: NSPoint?
var moved = false
var hideAfter: TimeInterval = 0
let clock = ProcessInfo.processInfo
@MainActor func refreshEdge() {
    let now = clock.systemUptime
    if NSEvent.pressedMouseButtons & 1 == 0 {
        started = nil
        moved = false
        if panel.isVisible && now >= hideAfter { panel.orderOut(nil) }
        return
    }
    let cursor = NSEvent.mouseLocation
    if started == nil { started = cursor }
    if let start = started {
        moved = moved || abs(cursor.x - start.x) >= 3 || abs(cursor.y - start.y) >= 3
    }
    hideAfter = now + 0.16
    guard moved, !panel.isVisible,
          let display = NSScreen.screens.first(where: { $0.frame.contains(cursor) }),
          edge.distance(from: cursor, in: display.frame) < 28 else { return }
    edgeView.highlight(false)
    panel.setFrame(edge.strip(in: display.frame), display: true)
    panel.orderFrontRegardless()
}
let poll = Timer(timeInterval: 0.035, repeats: true) { _ in
    MainActor.assumeIsolated { refreshEdge() }
}
RunLoop.main.add(poll, forMode: .common)
app.run()
