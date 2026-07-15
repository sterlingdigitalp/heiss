import XCTest
import Photos
import UIKit
import Vision
import ObjectiveC.runtime

/// TikTok's continuously animating feed may never report itself idle, which
/// causes XCTest to block before otherwise coordinate-only gestures. Keep our
/// explicit foreground/account waits, but neutralize XCTest's implicit global
/// quiescence wait when the runtime exposes it.
private func disableQuiescenceWait() {
    guard let cls = NSClassFromString("XCUIApplicationProcess") else { return }
    let noop: @convention(block) (AnyObject, Double) -> Void = { _, _ in }
    let implementation = imp_implementationWithBlock(noop)
    for name in ["waitForQuiescenceIncludingAnimationsIdle:", "_waitForQuiescenceIncludingAnimationsIdle:"] {
        let selector = NSSelectorFromString(name)
        if let method = class_getInstanceMethod(cls, selector) {
            method_setImplementation(method, implementation)
        }
    }
}

private func disableAutomaticInterruptionHandling(_ app: XCUIApplication) {
    let selector = NSSelectorFromString("setDoesNotHandleUIInterruptions:")
    guard app.responds(to: selector) else { return }
    app.setValue(true, forKey: "doesNotHandleUIInterruptions")
}

/// Long-running XCTest host that performs real gestures in third-party apps.
/// The Mac writes JSON commands into this test runner's Documents/inbox.
final class HeissRunnerUITests: XCTestCase {
    private let fm = FileManager.default
    private var activeHandles: [String: String] = [:]

    func testCommandServer() throws {
        continueAfterFailure = true
        disableQuiescenceWait()
        let inbox = documents().appendingPathComponent("inbox", isDirectory: true)
        let outbox = documents().appendingPathComponent("outbox", isDirectory: true)
        let media = documents().appendingPathComponent("media", isDirectory: true)
        try fm.createDirectory(at: inbox, withIntermediateDirectories: true)
        try fm.createDirectory(at: outbox, withIntermediateDirectories: true)
        try fm.createDirectory(at: media, withIntermediateDirectories: true)
        // Commands left by a killed/timed-out test host no longer have a Mac
        // waiter and must never be replayed after restart.
        for stale in (try? fm.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)) ?? [] {
            try? fm.removeItem(at: stale)
        }
        for stale in (try? fm.contentsOfDirectory(at: outbox, includingPropertiesForKeys: nil)) ?? [] {
            try? fm.removeItem(at: stale)
        }
        print("HEISS_COMMAND_SERVER_READY")

        // xcodebuild owns the runner process. It is intentionally long-lived so
        // the Mac can drive many actions without rebuilding between gestures.
        // At the recycle deadline the launchd KeepAlive job restarts a fresh
        // session; only exit once the inbox is drained so an in-flight command
        // is never abandoned mid-gesture.
        let deadline = Date().addingTimeInterval(12 * 60 * 60)
        while true {
            let pending = ((try? fm.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)) ?? [])
                .filter { $0.pathExtension == "json" }
            for file in pending {
                autoreleasepool {
                    self.handle(file, outbox: outbox)
                }
            }
            if Date() >= deadline && pending.isEmpty { break }
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
            "youtube": "com.google.ios.youtube"
        ][platform] ?? "com.zhiliaoapp.musically"
        let bundle = ((command["uiProfile"] as? [String: Any])?["bundleId"] as? String) ?? fallbackBundle
        let app = XCUIApplication(bundleIdentifier: bundle)
        if platform == "tiktok" || platform == "x" {
            disableAutomaticInterruptionHandling(app)
        }
        if platform == "tiktok" || platform == "youtube" {
            app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        }
        // TikTok's search-result player and X's search keyboard both hide the
        // normal Home/profile controls. TikTok's animated accessibility
        // process can also wedge after a gesture. Relaunch either app to a
        // known Home state before every independent command.
        // YouTube search results can leave a sponsored bottom sheet over the
        // account controls, so it also starts each command from a clean state.
        if (platform == "tiktok" || platform == "x" || platform == "youtube"), app.state != .notRunning {
            app.terminate()
            Thread.sleep(forTimeInterval: 0.8)
        }
        if app.state != .runningForeground { app.launch() }
        if !app.wait(for: .runningForeground, timeout: 12) {
            // Physical iOS occasionally returns to SpringBoard after XCTest's
            // first launch request even though the app is installed and
            // launchable. Activation is a safe bounded second attempt.
            app.activate()
        }
        guard app.wait(for: .runningForeground, timeout: 12) else {
            throw NSError(domain: "HeissRunner", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(platform) did not reach foreground"])
        }
        if platform == "instagram" {
            // Instagram can present this modal over the profile immediately
            // after switching accounts. It obscures both the current handle
            // and account switcher, so clear it before exact verification.
            let notNow = app.buttons.matching(NSPredicate(format: "label ==[c] %@", "Not now")).firstMatch
            if notNow.waitForExistence(timeout: 1), notNow.isHittable {
                notNow.tap()
                Thread.sleep(forTimeInterval: 0.5)
            }
        }
        if platform == "tiktok" {
            // TikTok's first-run surfaces can wedge XCTest while it snapshots
            // the animated accessibility hierarchy. Detect their rendered
            // copy with Vision and tap stable coordinates through SpringBoard.
            let surface = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            disableAutomaticInterruptionHandling(surface)
            if try screenContainsTextUsingOCR("Choose your interests"),
               try tapTextUsingOCR(surface: surface, expected: "Skip") {
                Thread.sleep(forTimeInterval: 0.8)
            }
            try dismissTikTokContactsPrompt(surface: surface)
            for _ in 0..<3 {
                if !(try screenContainsTextUsingOCR("Swipe up for more")) { break }
                let start = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.82))
                let end = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.10))
                start.press(forDuration: 0.08, thenDragTo: end)
                Thread.sleep(forTimeInterval: 1.0)
            }
            if try screenContainsTextUsingOCR("Swipe up for more") {
                throw NSError(domain: "HeissRunner", code: 18, userInfo: [NSLocalizedDescriptionKey: "TikTok swipe tutorial did not dismiss after three gestures"])
            }
        }
        if platform == "youtube" { try dismissYouTubeDefaultAccountPrompt(app) }
        if platform == "youtube",
           try screenContainsTextUsingOCR("Sponsored"),
           try screenContainsTextUsingOCR("Learn more") {
            app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.94, dy: 0.625)).tap()
            Thread.sleep(forTimeInterval: 0.8)
        }
        let handle = command["handle"] as? String ?? ""
        if action != "post:verify_published" {
            try ensureAccount(app, platform: platform, handle: handle, command: command)
            if app.state != .runningForeground {
                app.activate()
                guard app.wait(for: .runningForeground, timeout: 8) else {
                    throw NSError(domain: "HeissRunner", code: 17, userInfo: [NSLocalizedDescriptionKey: "\(platform) lost foreground before \(action)"])
                }
                try ensureAccount(app, platform: platform, handle: handle, command: command)
            }
        }
        if action == "verify:account" {
            return ["ok": true, "executed": true, "detail": "xctest:\(platform):verified:\(handle)"]
        }

        let window: XCUIElement
        if platform == "tiktok" || platform == "x" {
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            disableAutomaticInterruptionHandling(springboard)
            window = springboard
        } else {
            window = app.windows.firstMatch
        }
        Thread.sleep(forTimeInterval: Double.random(in: 0.65...1.8))
        if action == "post:verify_published" {
            let publish = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "Post", "Share"))
            if publish.count > 0 {
                throw NSError(domain: "HeissRunner", code: 9, userInfo: [NSLocalizedDescriptionKey: "Publish outcome is indeterminate: composer is still visible; refusing a second tap"])
            }
        } else if action.contains("scroll") {
            // TikTok's continuously playing feed can prevent the convenience
            // swipe API from ever observing an idle application. A bounded
            // coordinate drag synthesizes the same user gesture without the
            // velocity helper's unbounded quiescence retries.
            let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.78))
            let end = window.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.28))
            start.press(forDuration: 0.08, thenDragTo: end)
        } else if action.contains("like") {
            window.coordinate(withNormalizedOffset: point(command, "like", .init(dx: 0.90, dy: 0.55))).tap()
        } else if action.contains("follow") {
            window.coordinate(withNormalizedOffset: point(command, "follow", .init(dx: 0.88, dy: 0.43))).tap()
        } else if action.contains("search") {
            if platform == "instagram" {
                let notNow = app.buttons.matching(NSPredicate(format: "label ==[c] %@", "Not now"))
                if notNow.count > 0, notNow.firstMatch.isHittable { notNow.firstMatch.tap() }
                let explore = app.buttons["explore-tab"]
                if explore.waitForExistence(timeout: 3), explore.isHittable { explore.tap() }
                else { window.coordinate(withNormalizedOffset: point(command, "search", .init(dx: 0.70, dy: 0.95))).tap() }
            } else if platform == "tiktok" {
                let existingSearch = app.searchFields.firstMatch
                if existingSearch.exists {
                    // Results pages retain the search field but move the
                    // top-right coordinate to an overflow menu.
                    window.coordinate(withNormalizedOffset: CGVector(dx: 0.42, dy: 0.06)).tap()
                } else {
                    // Avoid resolving TikTok's Search button through the
                    // animated feed hierarchy; it is top-right on Home.
                    window.coordinate(withNormalizedOffset: point(command, "search", .init(dx: 0.92, dy: 0.08))).tap()
                }
            } else {
                if platform == "youtube" {
                    let readyDeadline = Date().addingTimeInterval(15)
                    var navigationReady = false
                    while Date() < readyDeadline {
                        navigationReady = try screenContainsTextUsingOCR("Home")
                        if !navigationReady { navigationReady = try screenContainsTextUsingOCR("Shorts") }
                        if navigationReady { break }
                        if try screenContainsTextUsingOCR("Default Account") {
                            try dismissYouTubeDefaultAccountPrompt(app)
                            try ensureAccount(app, platform: platform, handle: handle, command: command)
                            continue
                        }
                        Thread.sleep(forTimeInterval: 0.5)
                    }
                    guard navigationReady else {
                        throw NSError(domain: "HeissRunner", code: 21, userInfo: [NSLocalizedDescriptionKey: "YouTube navigation did not finish loading before search"])
                    }
                }
                let notNow = app.buttons.matching(NSPredicate(format: "label ==[c] %@", "Not now"))
                if notNow.count > 0, notNow.firstMatch.isHittable { notNow.firstMatch.tap() }
                let searchButtons = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Search"))
                if searchButtons.count > 0, searchButtons.firstMatch.isHittable { searchButtons.firstMatch.tap() }
                else {
                    let fallback: CGVector
                    if platform == "x" { fallback = CGVector(dx: 0.30, dy: 0.95) }
                    // YouTube Shorts places Search immediately left of the
                    // overflow menu; 0.88 hits the menu on compact iPhones.
                    else if platform == "youtube" { fallback = CGVector(dx: 0.79, dy: 0.065) }
                    else { fallback = CGVector(dx: 0.50, dy: 0.94) }
                    window.coordinate(withNormalizedOffset: point(command, "search", fallback)).tap()
                }
            }
            Thread.sleep(forTimeInterval: 0.8)
            let fields = app.searchFields.count > 0 ? app.searchFields : app.textFields
            let terms = command["searchTerms"] as? [String] ?? []
            if fields.count > 0, let term = terms.randomElement() {
                let field = fields.firstMatch
                if platform == "tiktok" {
                    window.coordinate(withNormalizedOffset: CGVector(dx: 0.42, dy: 0.06)).tap()
                } else if field.isHittable { field.tap() }
                else { field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
                let keyboardApp: XCUIApplication
                if platform == "tiktok" {
                    keyboardApp = XCUIApplication(bundleIdentifier: "com.apple.springboard")
                    disableAutomaticInterruptionHandling(keyboardApp)
                } else {
                    keyboardApp = app
                }
                guard app.keyboards.firstMatch.waitForExistence(timeout: 3) else {
                    throw NSError(domain: "HeissRunner", code: 11, userInfo: [NSLocalizedDescriptionKey: "Search field did not receive keyboard focus"])
                }
                if platform == "tiktok" {
                    keyboardApp.coordinate(withNormalizedOffset: CGVector(dx: 0.94, dy: 0.88)).press(forDuration: 1.2)
                    try typeUsingKeyboardCoordinates(keyboardApp, text: term)
                    keyboardApp.coordinate(withNormalizedOffset: CGVector(dx: 0.87, dy: 0.96)).tap()
                } else {
                    try typeUsingVisibleKeyboard(keyboardApp, text: term)
                    let submit = keyboardApp.keys.matching(
                        NSPredicate(format: "label ==[c] %@ OR label ==[c] %@ OR label ==[c] %@", "Search", "Return", "Go")
                    ).firstMatch
                    if submit.waitForExistence(timeout: 2), submit.isHittable { submit.tap() }
                }
            } else {
                throw NSError(domain: "HeissRunner", code: 12, userInfo: [NSLocalizedDescriptionKey: "Search field was not found after opening (platform) search"])
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

    private func typeUsingVisibleKeyboard(_ app: XCUIApplication, text: String) throws {
        for character in text.lowercased() {
            let label = character == " " ? "space" : String(character)
            let key = app.keys[label]
            guard key.waitForExistence(timeout: 2), key.isHittable else {
                throw NSError(domain: "HeissRunner", code: 13, userInfo: [NSLocalizedDescriptionKey: "Keyboard key \(label) was not available"])
            }
            key.tap()
            Thread.sleep(forTimeInterval: Double.random(in: 0.06...0.16))
        }
    }

    private func typeUsingKeyboardCoordinates(_ surface: XCUIElement, text: String) throws {
        let keys: [Character: CGVector] = [
            "q": .init(dx: 0.06, dy: 0.72), "w": .init(dx: 0.16, dy: 0.72),
            "e": .init(dx: 0.25, dy: 0.72), "r": .init(dx: 0.35, dy: 0.72),
            "t": .init(dx: 0.45, dy: 0.72), "y": .init(dx: 0.55, dy: 0.72),
            "u": .init(dx: 0.65, dy: 0.72), "i": .init(dx: 0.75, dy: 0.72),
            "o": .init(dx: 0.85, dy: 0.72), "p": .init(dx: 0.95, dy: 0.72),
            "a": .init(dx: 0.11, dy: 0.80), "s": .init(dx: 0.21, dy: 0.80),
            "d": .init(dx: 0.31, dy: 0.80), "f": .init(dx: 0.41, dy: 0.80),
            "g": .init(dx: 0.51, dy: 0.80), "h": .init(dx: 0.61, dy: 0.80),
            "j": .init(dx: 0.71, dy: 0.80), "k": .init(dx: 0.81, dy: 0.80),
            "l": .init(dx: 0.90, dy: 0.80), "z": .init(dx: 0.21, dy: 0.88),
            "x": .init(dx: 0.31, dy: 0.88), "c": .init(dx: 0.41, dy: 0.88),
            "v": .init(dx: 0.51, dy: 0.88), "b": .init(dx: 0.61, dy: 0.88),
            "n": .init(dx: 0.71, dy: 0.88), "m": .init(dx: 0.81, dy: 0.88),
            " ": .init(dx: 0.55, dy: 0.96),
        ]
        for character in text.lowercased() {
            guard let key = keys[character] else {
                throw NSError(domain: "HeissRunner", code: 14, userInfo: [NSLocalizedDescriptionKey: "Keyboard coordinate for \(character) is unavailable"])
            }
            surface.coordinate(withNormalizedOffset: key).tap()
            Thread.sleep(forTimeInterval: Double.random(in: 0.06...0.16))
        }
    }

    private func dismissTikTokPasskey() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let prompt = springboard.buttons.matching(
            NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "Add Passkey", "Save on Other Device")
        ).firstMatch
        guard prompt.waitForExistence(timeout: 2) else { return }
        let close = springboard.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Close"))
        if close.count > 0, close.firstMatch.isHittable { close.firstMatch.tap() }
        else { springboard.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.90, dy: 0.445)).tap() }
        Thread.sleep(forTimeInterval: 0.8)
    }

    private func dismissTikTokContactsPrompt(surface: XCUIElement) throws {
        // TikTok may delay this app-owned upsell until after the Profile tab is
        // opened. XCTest cannot reliably see it through TikTok's animated
        // accessibility tree, so use rendered text as the guard and a stable
        // button coordinate as the fallback. Never tap the coordinate unless
        // the distinctive prompt copy is visible.
        for _ in 0..<2 {
            guard try screenContainsTextUsingOCR("Find contacts") else { return }
            if !(try tapTextUsingOCR(surface: surface, expected: "Don")) {
                surface.coordinate(withNormalizedOffset: CGVector(dx: 0.31, dy: 0.74)).tap()
            }
            Thread.sleep(forTimeInterval: 0.8)
        }
        if try screenContainsTextUsingOCR("Find contacts") {
            throw NSError(domain: "HeissRunner", code: 19, userInfo: [NSLocalizedDescriptionKey: "TikTok contacts prompt did not dismiss"])
        }
    }

    private func ensureAccount(_ app: XCUIApplication, platform: String, handle: String, command: [String: Any]) throws {
        guard !handle.isEmpty else { return }
        let normalized = handle.hasPrefix("@") ? String(handle.dropFirst()) : handle
        let withAt = "@\(normalized)"
        let normalizedWithMetadata = "\(normalized),"
        let withAtAndMetadata = "\(withAt),"
        let handlePredicate = NSPredicate(
            format: "label ==[c] %@ OR label ==[c] %@ OR label BEGINSWITH[c] %@ OR label BEGINSWITH[c] %@ OR value ==[c] %@ OR value ==[c] %@ OR value BEGINSWITH[c] %@ OR value BEGINSWITH[c] %@ OR identifier ==[c] %@ OR identifier ==[c] %@",
            normalized, withAt, normalizedWithMetadata, withAtAndMetadata,
            normalized, withAt, normalizedWithMetadata, withAtAndMetadata,
            normalized, withAt
        )
        let window: XCUIElement
        if platform == "tiktok" || platform == "x" {
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            disableAutomaticInterruptionHandling(springboard)
            window = springboard
        } else {
            window = app.windows.firstMatch
        }
        if platform == "x", try screenContainsTextUsingOCR("Subscribe & pay") {
            window.coordinate(withNormalizedOffset: CGVector(dx: 0.06, dy: 0.12)).tap()
            Thread.sleep(forTimeInterval: 0.8)
        }
        // If a prior attempt left Instagram's switcher sheet open, use that
        // exact state instead of mistaking a visible-but-unselected row for
        // the active profile.
        if platform == "instagram" {
            let switcherMarker = app.descendants(matching: .any).matching(
                NSPredicate(format: "label CONTAINS[c] %@", "Add Instagram account")
            )
            if switcherMarker.count > 0 {
                try tapExactHandle(app, surface: window, predicate: handlePredicate, handle: handle, platform: platform)
                Thread.sleep(forTimeInterval: 0.8)
                guard instagramTitleMatches(app, normalized: normalized) else {
                    throw NSError(domain: "HeissRunner", code: 15, userInfo: [NSLocalizedDescriptionKey: "Account switch did not verify exact handle \(handle) on \(platform)"])
                }
                activeHandles[platform] = handle
                window.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: 0.95))).tap()
                return
            }
        }
        if platform == "x" {
            // Inspect the stable navigation-drawer header to verify the
            // current X account without touching feed content.
            window.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: 0.95))).tap()
            Thread.sleep(forTimeInterval: 0.8)
            try openXDrawer(surface: window)
            var inspectedAccounts = [try recognizedTextStringsUsingOCR(minimumVisionY: 0.72).joined(separator: " | ")]
            if try screenContainsExactHandleUsingOCR(normalized: normalized, minimumVisionY: 0.72) {
                window.coordinate(withNormalizedOffset: CGVector(dx: 0.90, dy: 0.50)).tap()
                activeHandles[platform] = handle
                return
            }
            // The drawer's top row contains the other signed-in account
            // avatars. Try only those bounded slots, reopening the drawer and
            // verifying the exact header handle after each switch.
            let accountSlots: [CGFloat] = [0.50, 0.62]
            for (index, x) in accountSlots.enumerated() {
                window.coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.075)).tap()
                Thread.sleep(forTimeInterval: 1.0)
                try openXDrawer(surface: window)
                inspectedAccounts.append(try recognizedTextStringsUsingOCR(minimumVisionY: 0.72).joined(separator: " | "))
                if try screenContainsExactHandleUsingOCR(normalized: normalized, minimumVisionY: 0.72) {
                    window.coordinate(withNormalizedOffset: CGVector(dx: 0.90, dy: 0.50)).tap()
                    activeHandles[platform] = handle
                    return
                }
                if index < accountSlots.count - 1 {
                    window.coordinate(withNormalizedOffset: CGVector(dx: 0.90, dy: 0.50)).tap()
                    Thread.sleep(forTimeInterval: 0.5)
                }
            }
            let summary = inspectedAccounts.enumerated().map { "slot\($0.offset): \($0.element)" }.joined(separator: "; ")
            throw NSError(domain: "HeissRunner", code: 15, userInfo: [NSLocalizedDescriptionKey: "X signed-in accounts did not verify exact handle \(handle). OCR headers: \(summary)"])
        }
        if platform == "youtube" {
            try ensureYouTubeAccount(app, surface: window, handle: handle, normalized: normalized, command: command)
            return
        }
        if platform == "tiktok" {
            dismissTikTokPasskey()
            try dismissTikTokContactsPrompt(surface: window)
        }
        if platform == "x" {
            let premium = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Subscribe"))
            if premium.count > 0 {
                let close = app.buttons.matching(NSPredicate(format: "label ==[c] %@ OR label CONTAINS[c] %@", "Close", "Dismiss"))
                if close.count > 0, close.firstMatch.isHittable { close.firstMatch.tap() }
                else { window.coordinate(withNormalizedOffset: CGVector(dx: 0.06, dy: 0.12)).tap() }
                Thread.sleep(forTimeInterval: 0.8)
            }
        }
        // Avoid asking TikTok for a global keyboard snapshot here: its
        // continuously animating feed can wedge that accessibility query.
        if platform != "tiktok", app.keyboards.firstMatch.exists {
            let back = app.buttons.matching(NSPredicate(format: "label ==[c] %@ OR label CONTAINS[c] %@ OR label CONTAINS[c] %@ OR label CONTAINS[c] %@", "Back", "back", "Close", "Cancel"))
            if back.count > 0, back.firstMatch.isHittable { back.firstMatch.tap() }
            else { window.coordinate(withNormalizedOffset: CGVector(dx: 0.09, dy: 0.08)).tap() }
            Thread.sleep(forTimeInterval: 0.8)
        }
        let profileTab = app.buttons["profile-tab"]
        if platform == "instagram", profileTab.waitForExistence(timeout: 2), profileTab.isHittable { profileTab.tap() }
        else {
            let fallback = platform == "x"
                ? CGVector(dx: 0.08, dy: 0.08)
                : CGVector(dx: 0.91, dy: 0.95)
            window.coordinate(withNormalizedOffset: point(command, "profile", fallback)).tap()
        }
        Thread.sleep(forTimeInterval: 1.0)
        if platform == "tiktok", app.state != .runningForeground {
            app.activate()
            guard app.wait(for: .runningForeground, timeout: 8) else {
                throw NSError(domain: "HeissRunner", code: 17, userInfo: [NSLocalizedDescriptionKey: "TikTok lost foreground during account verification"])
            }
            window.coordinate(withNormalizedOffset: point(command, "profile", .init(dx: 0.91, dy: 0.95))).tap()
            Thread.sleep(forTimeInterval: 1.0)
        }
        if platform == "tiktok" {
            dismissTikTokPasskey()
            try dismissTikTokContactsPrompt(surface: window)
        }
        if platform == "x" {
            let drawerHandle = app.descendants(matching: .any).matching(handlePredicate)
            if drawerHandle.count == 0 {
                // X's animated drawer can hold XCTest's element-tap
                // quiescence wait for a full minute. The stable Profile row
                // coordinate on SpringBoard delivers the same tap immediately.
                window.coordinate(withNormalizedOffset: CGVector(dx: 0.22, dy: 0.23)).tap()
                Thread.sleep(forTimeInterval: 1.0)
            }
        }
        if platform == "youtube" {
            let channelHandle = app.descendants(matching: .any).matching(handlePredicate)
            if channelHandle.count == 0 {
                let channel = app.descendants(matching: .any).matching(
                    NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "View channel", "Your channel")
                ).firstMatch
                if channel.waitForExistence(timeout: 3), channel.isHittable { channel.tap() }
                Thread.sleep(forTimeInterval: 1.0)
            }
        }
        // TikTok has exposed the profile handle as a button/other element in
        // multiple UI revisions, so do not restrict account verification to
        // static text. The exact normalized handle is still required.
        let isCurrent: Bool
        if platform == "instagram" {
            isCurrent = instagramTitleMatches(app, normalized: normalized)
        } else if platform == "tiktok" {
            // TikTok can wedge XCTest while snapshotting its animated profile
            // hierarchy. Vision reads the rendered username without asking the
            // app (or Continuity) for an accessibility snapshot.
            isCurrent = try screenContainsExactHandleUsingOCR(normalized: normalized)
        } else {
            isCurrent = app.descendants(matching: .any).matching(handlePredicate).firstMatch.waitForExistence(timeout: platform == "x" ? 10 : 1)
        }
        if isCurrent {
            activeHandles[platform] = handle
            window.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: 0.95))).tap()
            return
        }

        // Profile headers on TikTok/Instagram expose the current username and
        // open the native account switcher when tapped.
        if platform == "tiktok" {
            window.coordinate(withNormalizedOffset: point(command, "accountMenu", .init(dx: 0.57, dy: 0.27))).tap()
        } else {
            let accountMenu = app.buttons["user-switch-title-button"]
            if accountMenu.waitForExistence(timeout: 2), accountMenu.isHittable { accountMenu.tap() }
            else {
            let fallback: CGVector
            if platform == "youtube" { fallback = .init(dx: 0.20, dy: 0.06) }
            else { fallback = .init(dx: 0.50, dy: 0.08) }
            window.coordinate(withNormalizedOffset: point(command, "accountMenu", fallback)).tap()
            }
        }
        Thread.sleep(forTimeInterval: 0.8)
        try tapExactHandle(app, surface: window, predicate: handlePredicate, handle: handle, platform: platform)
        Thread.sleep(forTimeInterval: 0.8)
        let verified: Bool
        if platform == "instagram" {
            verified = instagramTitleMatches(app, normalized: normalized)
        } else if platform == "tiktok" {
            verified = try waitForExactHandleUsingOCR(normalized: normalized, timeout: 8)
        } else {
            verified = app.descendants(matching: .any).matching(handlePredicate).firstMatch.waitForExistence(timeout: 5)
        }
        guard verified else {
            throw NSError(domain: "HeissRunner", code: 15, userInfo: [NSLocalizedDescriptionKey: "Account switch did not verify exact handle \(handle) on \(platform)"])
        }
        activeHandles[platform] = handle
        window.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: 0.95))).tap()
    }

    private func tapExactHandle(_ app: XCUIApplication, surface: XCUIElement, predicate: NSPredicate, handle: String, platform: String) throws {
        let normalized = handle.hasPrefix("@") ? String(handle.dropFirst()) : handle
        if platform == "tiktok" {
            if try tapExactHandleUsingOCR(surface: surface, normalized: normalized) { return }
            throw NSError(domain: "HeissRunner", code: 5, userInfo: [NSLocalizedDescriptionKey: "Account \(handle) was not found in the \(platform) switcher"])
        }
        let target: XCUIElement?
        if ["instagram", "tiktok", "x", "youtube"].contains(platform) {
            let broad = NSPredicate(
                format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@ OR identifier CONTAINS[c] %@",
                normalized, normalized, normalized
            )
            target = app.descendants(matching: .any).matching(broad).allElementsBoundByIndex.first {
                elementContainsExactHandle($0, normalized: normalized)
            }
        } else {
            let exact = app.descendants(matching: .any).matching(predicate).firstMatch
            target = exact.waitForExistence(timeout: 3) ? exact : nil
        }
        if let target {
            if target.isHittable { target.tap() }
            else { target.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
            return
        }
        if try tapExactHandleUsingOCR(surface: surface, normalized: normalized) { return }
        throw NSError(domain: "HeissRunner", code: 5, userInfo: [NSLocalizedDescriptionKey: "Account \(handle) was not found in the \(platform) switcher"])
    }

    private func ensureYouTubeAccount(
        _ app: XCUIApplication,
        surface: XCUIElement,
        handle: String,
        normalized: String,
        command: [String: Any]
    ) throws {
        // YouTube's current iOS UI puts account identity under the bottom
        // "You" tab. A channel page has a back arrow where the old profile
        // menu used to be, so always return to You before switching.
        surface.coordinate(withNormalizedOffset: point(command, "profile", .init(dx: 0.91, dy: 0.95))).tap()
        Thread.sleep(forTimeInterval: 1.0)
        try dismissYouTubeDefaultAccountPrompt(app)
        surface.coordinate(withNormalizedOffset: point(command, "profile", .init(dx: 0.91, dy: 0.95))).tap()
        Thread.sleep(forTimeInterval: 0.8)
        if try screenContainsTextUsingOCR("Manage accounts") {
            surface.coordinate(withNormalizedOffset: CGVector(dx: 0.06, dy: 0.06)).tap()
            Thread.sleep(forTimeInterval: 0.8)
            surface.coordinate(withNormalizedOffset: point(command, "profile", .init(dx: 0.91, dy: 0.95))).tap()
            Thread.sleep(forTimeInterval: 0.8)
        }
        if try screenContainsExactHandleUsingOCR(normalized: normalized) {
            activeHandles["youtube"] = handle
            surface.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: 0.95))).tap()
            return
        }

        let switchAccount = app.descendants(matching: .any).matching(
            NSPredicate(
                format: "label ==[c] %@ OR label CONTAINS[c] %@ OR identifier CONTAINS[c] %@",
                "Accounts", "Switch account", "switch-account"
            )
        ).firstMatch
        if switchAccount.waitForExistence(timeout: 2), switchAccount.isHittable {
            switchAccount.tap()
        } else {
            // Stable account-header position in the You tab (avatar/name/chevron).
            surface.coordinate(withNormalizedOffset: point(command, "accountMenu", .init(dx: 0.30, dy: 0.12))).tap()
        }
        Thread.sleep(forTimeInterval: 1.0)
        var selected = try tapExactHandleUsingOCR(surface: surface, normalized: normalized)
        if !selected, let switcherHint = command["switcherHint"] as? String, !switcherHint.isEmpty {
            selected = try tapTextUsingOCR(surface: surface, expected: switcherHint)
        }
        guard selected else {
            throw NSError(domain: "HeissRunner", code: 5, userInfo: [NSLocalizedDescriptionKey: "Account \(handle) was not found in the youtube switcher"])
        }
        Thread.sleep(forTimeInterval: 1.2)

        surface.coordinate(withNormalizedOffset: point(command, "profile", .init(dx: 0.91, dy: 0.95))).tap()
        Thread.sleep(forTimeInterval: 1.0)
        if !(try screenContainsExactHandleUsingOCR(normalized: normalized)) {
            let channel = app.descendants(matching: .any).matching(
                NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "View channel", "Your channel")
            ).firstMatch
            if channel.waitForExistence(timeout: 2), channel.isHittable {
                channel.tap()
                Thread.sleep(forTimeInterval: 1.0)
            }
        }
        guard try screenContainsExactHandleUsingOCR(normalized: normalized) else {
            throw NSError(domain: "HeissRunner", code: 15, userInfo: [NSLocalizedDescriptionKey: "Account switch did not verify exact handle \(handle) on youtube"])
        }
        activeHandles["youtube"] = handle
        surface.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: 0.95))).tap()
    }

    private func dismissYouTubeDefaultAccountPrompt(_ app: XCUIApplication) throws {
        guard try screenContainsTextUsingOCR("Default Account") else { return }
        let surface = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        disableAutomaticInterruptionHandling(surface)
        // "Manage accounts" is also a row label on the account-switcher sheet
        // that sits UNDER the full-screen manager, so keying detection and
        // dismissal-verification on that title reports false failures after a
        // successful Done tap. The per-account "Remove from this device" rows
        // exist only on the manager screen itself.
        if try screenContainsTextUsingOCR("Remove from this device") {
            if !(try tapTextUsingOCR(surface: surface, expected: "Done")) {
                surface.coordinate(withNormalizedOffset: CGVector(dx: 0.89, dy: 0.075)).tap()
            }
            let deadline = Date().addingTimeInterval(5)
            while Date() < deadline, try screenContainsTextUsingOCR("Remove from this device") {
                Thread.sleep(forTimeInterval: 0.5)
            }
            if try screenContainsTextUsingOCR("Remove from this device") {
                throw NSError(domain: "HeissRunner", code: 20, userInfo: [NSLocalizedDescriptionKey: "YouTube Manage accounts screen could not be dismissed after tapping Done"])
            }
            Thread.sleep(forTimeInterval: 0.5)
            // Done may drop back onto the default-account sheet underneath;
            // fall through and dismiss that too when it is still visible.
            if !(try screenContainsTextUsingOCR("Default Account")) { return }
        }
        let doneButton = app.buttons.matching(NSPredicate(format: "label ==[c] %@", "Done")).firstMatch
        if doneButton.waitForExistence(timeout: 1), doneButton.isHittable {
            doneButton.tap()
        } else if !(try tapTextUsingOCR(surface: surface, expected: "Done")) {
            let start = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.82))
            let end = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.50))
            start.press(forDuration: 0.08, thenDragTo: end)
            Thread.sleep(forTimeInterval: 0.8)
            if !(try tapTextUsingOCR(surface: surface, expected: "Done")) {
                // On compact iPhones only the top edge of the blue Done
                // button is visible until the sheet accepts this tap.
                surface.coordinate(withNormalizedOffset: CGVector(dx: 0.82, dy: 0.985)).tap()
            }
        }
        Thread.sleep(forTimeInterval: 1.0)
        guard !(try screenContainsTextUsingOCR("Default Account")) else {
            throw NSError(domain: "HeissRunner", code: 20, userInfo: [NSLocalizedDescriptionKey: "YouTube default-account prompt could not be dismissed"])
        }
    }

    private func instagramTitleMatches(_ app: XCUIApplication, normalized: String) -> Bool {
        let title = app.buttons["user-switch-title-button"]
        guard title.waitForExistence(timeout: 2) else { return false }
        return elementContainsExactHandle(title, normalized: normalized)
    }

    private func elementContainsExactHandle(_ element: XCUIElement, normalized: String) -> Bool {
        return [element.label, element.identifier, element.value as? String ?? ""].contains { raw in
            textContainsExactHandle(raw, normalized: normalized)
        }
    }

    private func textContainsExactHandle(_ raw: String, normalized: String) -> Bool {
        let escaped = NSRegularExpression.escapedPattern(for: normalized.lowercased())
        let pattern = "(^|[^a-z0-9._])@?\(escaped)($|[^a-z0-9._])"
        return raw.lowercased().range(of: pattern, options: .regularExpression) != nil
    }

    private func tapExactHandleUsingOCR(surface: XCUIElement, normalized: String) throws -> Bool {
        guard let match = try recognizedHandleObservation(normalized: normalized) else { return false }
        let box = match.boundingBox
        surface.coordinate(withNormalizedOffset: CGVector(dx: box.midX, dy: 1.0 - box.midY)).tap()
        return true
    }

    private func screenContainsExactHandleUsingOCR(normalized: String, minimumVisionY: CGFloat = 0) throws -> Bool {
        guard let match = try recognizedHandleObservation(normalized: normalized) else { return false }
        return match.boundingBox.midY >= minimumVisionY
    }

    private func waitForExactHandleUsingOCR(normalized: String, timeout: TimeInterval) throws -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if try screenContainsExactHandleUsingOCR(normalized: normalized) { return true }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < deadline
        return false
    }

    private func openXDrawer(surface: XCUIElement) throws {
        for _ in 0..<3 {
            surface.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.06)).tap()
            Thread.sleep(forTimeInterval: 1.0)
            if try screenContainsTextUsingOCR("Profile", minimumVisionY: 0.55) { return }
        }
        throw NSError(domain: "HeissRunner", code: 16, userInfo: [NSLocalizedDescriptionKey: "X navigation drawer did not open"])
    }

    private func screenContainsTextUsingOCR(_ expected: String, minimumVisionY: CGFloat = 0) throws -> Bool {
        guard let image = UIImage(data: XCUIScreen.main.screenshot().pngRepresentation)?.cgImage else { return false }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
        return (request.results ?? []).contains { observation in
            observation.boundingBox.midY >= minimumVisionY && observation.topCandidates(3).contains {
                $0.string.range(of: expected, options: [.caseInsensitive, .diacriticInsensitive]) != nil
            }
        }
    }

    private func tapTextUsingOCR(surface: XCUIElement, expected: String) throws -> Bool {
        guard let image = UIImage(data: XCUIScreen.main.screenshot().pngRepresentation)?.cgImage else { return false }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
        guard let observation = (request.results ?? []).first(where: { observation in
            observation.topCandidates(3).contains {
                $0.string.range(of: expected, options: [.caseInsensitive, .diacriticInsensitive]) != nil
            }
        }) else { return false }
        let box = observation.boundingBox
        surface.coordinate(withNormalizedOffset: CGVector(dx: box.midX, dy: 1.0 - box.midY)).tap()
        return true
    }

    private func recognizedTextStringsUsingOCR(minimumVisionY: CGFloat = 0) throws -> [String] {
        guard let image = UIImage(data: XCUIScreen.main.screenshot().pngRepresentation)?.cgImage else { return [] }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
        return (request.results ?? [])
            .filter { $0.boundingBox.midY >= minimumVisionY }
            .compactMap { $0.topCandidates(1).first?.string }
            .prefix(12)
            .map { $0 }
    }

    private func recognizedHandleObservation(normalized: String) throws -> VNRecognizedTextObservation? {
        guard let image = UIImage(data: XCUIScreen.main.screenshot().pngRepresentation)?.cgImage else { return nil }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
        let observations = request.results ?? []
        return observations.first(where: { observation in
            observation.topCandidates(3).contains { textContainsExactHandle($0.string, normalized: normalized) }
        })
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
