import AppKit
import UniformTypeIdentifiers

// Exercises Finder's native destination selection with an already local file.
// The cross-machine gesture must later supply the event and the staged file.
final class FinderDragView: NSView, NSDraggingSource, NSFilePromiseProviderDelegate {
    private let file: URL
    private let copyQueue = OperationQueue()

    init(file: URL) {
        self.file = file
        super.init(frame: .zero)
        copyQueue.maxConcurrentOperationCount = 1
    }

    required init?(coder: NSCoder) { return nil }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        NSBezierPath(rect: dirtyRect).fill()
        let text = "Arraste para uma pasta do Finder\n\(file.lastPathComponent)"
        (text as NSString).draw(
            in: bounds.insetBy(dx: 20, dy: 22),
            withAttributes: [.font: NSFont.systemFont(ofSize: 15), .foregroundColor: NSColor.labelColor]
        )
    }

    override func mouseDragged(with event: NSEvent) {
        guard !dragActive else { return }
        dragActive = true
        let type = UTType(filenameExtension: file.pathExtension) ?? .data
        let promise = NSFilePromiseProvider(fileType: type.identifier, delegate: self)
        let item = NSDraggingItem(pasteboardWriter: promise)
        let point = convert(event.locationInWindow, from: nil)
        let icon = NSWorkspace.shared.icon(forFile: file.path)
        item.setDraggingFrame(NSRect(x: point.x - 24, y: point.y - 24, width: 48, height: 48), contents: icon)
        beginDraggingSession(with: [item], event: event, source: self)
    }

    private var dragActive = false

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        context == .outsideApplication ? .copy : []
    }

    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        dragActive = false
        if operation.isEmpty { print("finder-drag-cancelled") }
    }

    func filePromiseProvider(_ provider: NSFilePromiseProvider, fileNameForType fileType: String) -> String {
        file.lastPathComponent
    }

    func operationQueue(for filePromiseProvider: NSFilePromiseProvider) -> OperationQueue {
        copyQueue
    }

    func filePromiseProvider(_ provider: NSFilePromiseProvider, writePromiseTo url: URL,
                             completionHandler: @escaping (Error?) -> Void) {
        do {
            try FileManager.default.copyItem(at: file, to: url)
            print("finder-drop-saved")
            completionHandler(nil)
        } catch {
            fputs("finder-drop-failed: \(error.localizedDescription)\n", stderr)
            completionHandler(error)
        }
    }
}

guard CommandLine.arguments.count == 2 else {
    fputs("Uso: FinderDragProbe /caminho/do/arquivo\n", stderr)
    exit(2)
}
let file = URL(fileURLWithPath: CommandLine.arguments[1])
guard (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else {
    fputs("Escolha um arquivo local.\n", stderr)
    exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: 350, height: 115),
    styleMask: [.titled, .closable], backing: .buffered, defer: false
)
final class ProbeDelegate: NSObject, NSWindowDelegate {
    func windowWillClose(_ notification: Notification) { NSApp.stop(nil) }
}
let delegate = ProbeDelegate()
window.delegate = delegate
window.title = "HeyMouse · teste de arraste no Finder"
window.contentView = FinderDragView(file: file)
window.center()
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
