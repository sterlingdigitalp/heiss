import XCTest
import Photos

/// Long-running XCTest host that performs real gestures in third-party apps.
/// The Mac writes JSON commands into this test runner's Documents/inbox.
final class HeissRunnerUITests: XCTestCase {
    private let fm = FileManager.default
    private var activeHandles: [String: String] = [:]

    func testCommandServer() throws {
        continueAfterFailure = true
        let inbox = documents().appendingPathComponent("inbox", isDirectory: true)
        let outbox = documents().appendingPathComponent("outbox", isDirectory: true)
        let media = documents().appendingPathComponent("media", isDirectory: true)
        try fm.createDirectory(at: inbox, withIntermediateDirectories: true)
        try fm.createDirectory(at: outbox, withIntermediateDirectories: true)
        try fm.createDirectory(at: media, withIntermediateDirectories: true)
        for stale in (try? fm.contentsOfDirectory(at: outbox, includingPropertiesForKeys: nil)) ?? [] {
            try? fm.removeItem(at: stale)
        }

        // xcodebuild owns the runner process. It is intentionally long-lived so
        // the Mac can drive many actions without rebuilding between gestures.
        let deadline = Date().addingTimeInterval(12 * 60 * 60)
        while Date() < deadline {
            for file in (try? fm.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)) ?? [] where file.pathExtension == "json" {
                autoreleasepool {
                    self.handle(file, outbox: outbox)
                }
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
    }

    private func handle(_ file: URL, outbox: URL) {
        guard let data = try? Data(contentsOf: file),
              let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { try? fm.removeItem(at: file); return }
        let result: [String: Any]
        do {
            result = try perform(command)
        } catch {
            let screenshots = documents().appendingPathComponent("screenshots", isDirectory: true)
            try? fm.createDirectory(at: screenshots, withIntermediateDirectories: true)
            let name = "failure-\(UUID().uuidString).png"
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: screenshots.appendingPathComponent(name))
            result = [
                "ok": false,
                "executed": false,
                "detail": "\(error.localizedDescription) (screenshot: \(name))",
                "screenshot": name,
            ]
        }
        if let data = try? JSONSerialization.data(withJSONObject: result) {
            try? data.write(to: outbox.appendingPathComponent(file.lastPathComponent), options: .atomic)
        }
        try? fm.removeItem(at: file)
    }

    private func perform(_ command: [String: Any]) throws -> [String: Any] {
        let action = command["action"] as? String ?? "unknown"
        if action == "ping" { return ["ok": true, "executed": true, "detail": "xctest-ready"] }
        if action == "screenshot" {
            let screenshots = documents().appendingPathComponent("screenshots", isDirectory: true)
            try fm.createDirectory(at: screenshots, withIntermediateDirectories: true)
            let name = "capture-\(UUID().uuidString).png"
            try XCUIScreen.main.screenshot().pngRepresentation.write(
                to: screenshots.appendingPathComponent(name),
                options: .atomic
            )
            return ["ok": true, "executed": true, "detail": "screenshot captured", "screenshot": name]
        }
        let platform = command["platform"] as? String ?? "tiktok"
        let fallbackBundle = [
            "tiktok": "com.zhiliaoapp.musically",
            "instagram": "com.burbn.instagram",
            "x": "com.atebits.Tweetie2",
            "linkedin": "com.linkedin.LinkedIn"
        ][platform] ?? "com.zhiliaoapp.musically"
        let bundle = ((command["uiProfile"] as? [String: Any])?["bundleId"] as? String) ?? fallbackBundle
        let app = XCUIApplication(bundleIdentifier: bundle)
        if app.state != .runningForeground { app.launch() }
        guard app.wait(for: .runningForeground, timeout: 12) else {
            throw NSError(domain: "HeissRunner", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(platform) did not reach foreground"])
        }
        let handle = command["handle"] as? String ?? ""
        if action != "post:verify_published" {
            try ensureAccount(app, platform: platform, handle: handle, command: command)
        }

        let window = app.windows.firstMatch
        Thread.sleep(forTimeInterval: Double.random(in: 0.65...1.8))
        if action == "post:verify_published" {
            let publish = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "Post", "Share"))
            if publish.count > 0 {
                throw NSError(domain: "HeissRunner", code: 9, userInfo: [NSLocalizedDescriptionKey: "Publish outcome is indeterminate: composer is still visible; refusing a second tap"])
            }
        } else if action.contains("scroll") {
            window.swipeUp(velocity: .slow)
        } else if action.contains("like") {
            window.coordinate(withNormalizedOffset: point(command, "like", .init(dx: 0.90, dy: 0.55))).tap()
        } else if action.contains("follow") {
            window.coordinate(withNormalizedOffset: point(command, "follow", .init(dx: 0.88, dy: 0.43))).tap()
        } else if action.contains("search") {
            let searchButtons = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Search"))
            if searchButtons.count > 0 { searchButtons.firstMatch.tap() }
            else { window.coordinate(withNormalizedOffset: point(command, "search", .init(dx: 0.50, dy: 0.94))).tap() }
            let fields = app.searchFields.count > 0 ? app.searchFields : app.textFields
            let terms = command["searchTerms"] as? [String] ?? []
            if fields.count > 0, let term = terms.randomElement() {
                fields.firstMatch.tap(); fields.firstMatch.typeText(term); fields.firstMatch.typeText("\n")
            }
        } else if action == "post:upload" {
            let staged = command["stagedMediaNames"] as? [String] ?? []
            for name in staged {
                try importIntoPhotos(documents().appendingPathComponent("media").appendingPathComponent(name))
            }
            window.coordinate(withNormalizedOffset: point(command, "create", .init(dx: 0.50, dy: 0.94))).tap()
            // Select the newest staged assets from the system/platform picker.
            if staged.count > 1 {
                let multiple = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "multiple"))
                if multiple.count > 0 { multiple.firstMatch.tap() }
            }
            let cells = app.cells
            _ = cells.firstMatch.waitForExistence(timeout: 8)
            for index in 0..<min(max(staged.count, 1), cells.count) {
                cells.element(boundBy: index).tap()
            }
            let next = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Next"))
            if next.count > 0 { next.firstMatch.tap() }
        } else if action == "post:caption" {
            let text = command["caption"] as? String ?? ""
            let fields = app.textViews.count > 0 ? app.textViews : app.textFields
            if fields.count > 0 { fields.firstMatch.tap(); fields.firstMatch.typeText(text) }
        } else if action == "post:music_optional" {
            let music = command["music"] as? String ?? ""
            if !music.isEmpty {
                let sound = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "sound", "music"))
                guard sound.count > 0 else {
                    throw NSError(domain: "HeissRunner", code: 6, userInfo: [NSLocalizedDescriptionKey: "Music control not found; app layout may have changed"])
                }
                sound.firstMatch.tap()
                let fields = app.searchFields.count > 0 ? app.searchFields : app.textFields
                guard fields.count > 0 else {
                    throw NSError(domain: "HeissRunner", code: 7, userInfo: [NSLocalizedDescriptionKey: "Music search field not found"])
                }
                fields.firstMatch.tap(); fields.firstMatch.typeText(music); fields.firstMatch.typeText("\n")
                let result = app.cells.firstMatch
                if result.waitForExistence(timeout: 8) { result.tap() }
                let use = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "Use", "Done"))
                if use.count > 0 { use.firstMatch.tap() }
            }
        } else if action == "post:publish" {
            let candidates = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "Post", "Share"))
            guard candidates.count > 0 else {
                throw NSError(domain: "HeissRunner", code: 2, userInfo: [NSLocalizedDescriptionKey: "Publish button not found; app layout may have changed"])
            }
            let publish = candidates.firstMatch
            publish.tap()
            let leftComposer = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "exists == false"),
                object: publish
            )
            if XCTWaiter.wait(for: [leftComposer], timeout: 90) != .completed {
                throw NSError(domain: "HeissRunner", code: 8, userInfo: [NSLocalizedDescriptionKey: "Publish did not leave the composer within 90 seconds"])
            }
        } else {
            throw NSError(domain: "HeissRunner", code: 3, userInfo: [NSLocalizedDescriptionKey: "Unsupported action \(action)"])
        }
        return ["ok": true, "executed": true, "detail": "xctest:\(platform):\(action)"]
    }

    private func documents() -> URL {
        fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    private func ensureAccount(_ app: XCUIApplication, platform: String, handle: String, command: [String: Any]) throws {
        guard !handle.isEmpty, activeHandles[platform] != handle else { return }
        let normalized = handle.hasPrefix("@") ? String(handle.dropFirst()) : handle
        let window = app.windows.firstMatch
        window.coordinate(withNormalizedOffset: point(command, "profile", .init(dx: 0.91, dy: 0.95))).tap()
        Thread.sleep(forTimeInterval: 1.0)
        let current = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", normalized))
        if current.count > 0 {
            activeHandles[platform] = handle
            window.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: 0.95))).tap()
            return
        }

        // Profile headers on TikTok/Instagram expose the current username and
        // open the native account switcher when tapped.
        window.coordinate(withNormalizedOffset: point(command, "accountMenu", .init(dx: 0.50, dy: 0.08))).tap()
        Thread.sleep(forTimeInterval: 0.8)
        let targetText = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", normalized))
        let targetButton = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", normalized))
        if targetText.count > 0 { targetText.firstMatch.tap() }
        else if targetButton.count > 0 { targetButton.firstMatch.tap() }
        else {
            throw NSError(domain: "HeissRunner", code: 5, userInfo: [NSLocalizedDescriptionKey: "Account \(handle) was not found in the \(platform) switcher"])
        }
        activeHandles[platform] = handle
        Thread.sleep(forTimeInterval: 0.8)
        window.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: 0.95))).tap()
    }

    private func point(_ command: [String: Any], _ key: String, _ fallback: CGVector) -> CGVector {
        guard let profile = command["uiProfile"] as? [String: Any],
              let points = profile["points"] as? [String: Any],
              let raw = points[key] as? [String: Any],
              let x = raw["x"] as? Double,
              let y = raw["y"] as? Double
        else { return fallback }
        return CGVector(dx: min(max(x, 0), 1), dy: min(max(y, 0), 1))
    }

    private func importIntoPhotos(_ url: URL) throws {
        guard fm.fileExists(atPath: url.path) else {
            throw NSError(domain: "HeissRunner", code: 4, userInfo: [NSLocalizedDescriptionKey: "Staged media is missing: \(url.lastPathComponent)"])
        }
        let auth = expectation(description: "Photos authorization")
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in auth.fulfill() }
        wait(for: [auth], timeout: 30)
        let saved = expectation(description: "Save staged media")
        var saveError: Error?
        PHPhotoLibrary.shared().performChanges({
            let ext = url.pathExtension.lowercased()
            if ["jpg", "jpeg", "png", "heic", "webp"].contains(ext) {
                PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: url)
            } else {
                PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url)
            }
        }) { _, error in saveError = error; saved.fulfill() }
        wait(for: [saved], timeout: 60)
        if let saveError { throw saveError }
        try? fm.removeItem(at: url)
    }
}
