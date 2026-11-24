import AppKit
import CoreGraphics
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
        if operation.isEmpty {
            print("finder-drag-cancelled")
            fflush(stdout)
        }
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
            completionHandler(nil)
            print("finder-drop-saved")
            fflush(stdout)
        } catch {
            fputs("finder-drop-failed: \(error.localizedDescription)\n", stderr)
            completionHandler(error)
        }
    }
}

// This input is local stdin, not a network listener. The app must authorize
// a session before starting the adapter and forwarding events to it.
final class HandoffPointer {
    private var position: CGPoint
    private var pressed = false
    private var finished = false

    init(position: CGPoint) { self.position = position }

    func handle(_ command: PointerCommand) {
        guard !finished else { return }
        switch command.type {
        case "file-drag-move":
            guard let dx = command.dx, let dy = command.dy,
                  abs(dx) <= 2048, abs(dy) <= 2048 else { return }
            if !pressed {
                post(.leftMouseDown)
                pressed = true
            }
            position.x += dx
            position.y += dy
            post(.leftMouseDragged)
        case "file-drag-released":
            finish(cancelled: false)
        case "file-drag-cancelled":
            finish(cancelled: true)
        default:
            break
        }
    }

    func finish(cancelled: Bool) {
        guard !finished else { return }
        finished = true
        if cancelled && pressed {
            CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: true)?.post(tap: .cghidEventTap)
            CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: false)?.post(tap: .cghidEventTap)
        }
        if pressed { post(.leftMouseUp) }
        pressed = false
    }

    private func post(_ type: CGEventType) {
        CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: position,
                mouseButton: .left)?.post(tap: .cghidEventTap)
    }
}

struct PointerCommand: Decodable {
    let type: String
    let dx: CGFloat?
    let dy: CGFloat?
}

let handoff = CommandLine.arguments.count == 3 && CommandLine.arguments[2] == "--handoff"
guard CommandLine.arguments.count == 2 || handoff else {
    fputs("Uso: FinderDragProbe /caminho/do/arquivo [--handoff]\n", stderr)
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
    var pointer: HandoffPointer?
    func windowWillClose(_ notification: Notification) {
        pointer?.finish(cancelled: true)
        NSApp.terminate(nil)
    }
}
let delegate = ProbeDelegate()
window.delegate = delegate
window.title = "HeyMouse · teste de arraste no Finder"
window.contentView = FinderDragView(file: file)
window.center()
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
if handoff, let view = window.contentView, CGPreflightPostEventAccess() {
    let point = view.convert(NSPoint(x: view.bounds.midX, y: view.bounds.midY), to: nil)
    let screenPoint = window.convertPoint(toScreen: point)
    let primary = CGDisplayBounds(CGMainDisplayID())
    let pointer = HandoffPointer(position: CGPoint(x: screenPoint.x, y: primary.height - screenPoint.y))
    delegate.pointer = pointer
    print("finder-drag-ready")
    fflush(stdout)
    DispatchQueue.global(qos: .userInitiated).async {
        while let line = readLine() {
            guard line.utf8.count < 2048,
                  let command = try? JSONDecoder().decode(PointerCommand.self, from: Data(line.utf8)) else { continue }
            DispatchQueue.main.async { pointer.handle(command) }
        }
        DispatchQueue.main.async { pointer.finish(cancelled: true) }
    }
} else if handoff {
    fputs("Permissão de Acessibilidade necessária para receber os movimentos do arraste.\n", stderr)
    exit(1)
}
app.run()
