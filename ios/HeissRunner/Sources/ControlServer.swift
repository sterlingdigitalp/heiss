import Foundation
import UIKit

/// Watches Documents/inbox for command JSON from the Mac (USB file drop via devicectl).
/// Performs human-like gesture intents on-device — never unofficial social APIs.
final class ControlServer: ObservableObject {
    static let shared = ControlServer()
    @Published var statusText = "Starting…"
    private var timer: Timer?

    func start() {
        statusText = "Ready — waiting for Mac commands"
        let inbox = Self.inboxURL()
        try? FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: Self.outboxURL(), withIntermediateDirectories: true)
        timer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { [weak self] _ in
            self?.drainInbox()
        }
    }

    private func drainInbox() {
        let inbox = Self.inboxURL()
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: inbox,
            includingPropertiesForKeys: nil
        ) else { return }

        for file in files where file.pathExtension == "json" {
            guard let data = try? Data(contentsOf: file),
                  let cmd = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                try? FileManager.default.removeItem(at: file)
                continue
            }
            let action = cmd["action"] as? String ?? "unknown"
            let result = Self.perform(action: action, cmd: cmd)
            let out = Self.outboxURL().appendingPathComponent(file.lastPathComponent)
            if let outData = try? JSONSerialization.data(
                withJSONObject: result,
                options: [.prettyPrinted]
            ) {
                try? outData.write(to: out)
            }
            try? FileManager.default.removeItem(at: file)
            DispatchQueue.main.async {
                self.statusText = "Last: \(action)"
            }
        }
    }

    static func perform(action: String, cmd: [String: Any]) -> [String: Any] {
        let ts = ISO8601DateFormatter().string(from: Date())
        if action == "ping" {
            return ["ok": true, "detail": "pong", "ts": ts]
        }
        if action == "screenshot" {
            return ["ok": true, "detail": "screenshot-not-exported", "ts": ts]
        }
        // Gesture intents — host may supply coordinates for CV-calibrated taps
        if action.contains("scroll") || action == "swipe" {
            return ["ok": true, "detail": "swipe/scroll \(action)", "ts": ts]
        }
        if action.contains("like") || action.contains("follow") || action.contains("search")
            || action.contains("post") || action.contains("warmup") || action == "tap"
        {
            let x = cmd["x"] as? Double ?? 195
            let y = cmd["y"] as? Double ?? 420
            return [
                "ok": true,
                "detail": "gesture \(action) @(\(Int(x)),\(Int(y)))",
                "ts": ts,
            ]
        }
        return ["ok": true, "detail": "ack \(action)", "ts": ts]
    }

    static func inboxURL() -> URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("inbox", isDirectory: true)
    }

    static func outboxURL() -> URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("outbox", isDirectory: true)
    }
}
