import XCTest
import Photos
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
            "linkedin": "com.linkedin.LinkedIn",
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
        // TikTok can leave its accessibility process wedged after an
        // interrupted video-feed gesture. Relaunch once per runner lifetime,
        // before the account is verified and cached.
        if (platform == "tiktok" || platform == "youtube"), activeHandles[platform] == nil, app.state != .notRunning {
            app.terminate()
            Thread.sleep(forTimeInterval: 0.8)
        }
        if app.state != .runningForeground { app.launch() }
        guard app.wait(for: .runningForeground, timeout: 12) else {
            throw NSError(domain: "HeissRunner", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(platform) did not reach foreground"])
        }
        let handle = command["handle"] as? String ?? ""
        if action != "post:verify_published" {
            try ensureAccount(app, platform: platform, handle: handle, command: command)
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
                let notNow = app.buttons.matching(NSPredicate(format: "label ==[c] %@", "Not now"))
                if notNow.count > 0, notNow.firstMatch.isHittable { notNow.firstMatch.tap() }
                let searchButtons = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Search"))
                if searchButtons.count > 0, searchButtons.firstMatch.isHittable { searchButtons.firstMatch.tap() }
                else {
                    let fallback: CGVector
                    if platform == "x" { fallback = CGVector(dx: 0.30, dy: 0.95) }
                    else if platform == "youtube" { fallback = CGVector(dx: 0.88, dy: 0.08) }
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

    private func ensureAccount(_ app: XCUIApplication, platform: String, handle: String, command: [String: Any]) throws {
        guard !handle.isEmpty, activeHandles[platform] != handle else { return }
        let normalized = handle.hasPrefix("@") ? String(handle.dropFirst()) : handle
        let window: XCUIElement
        if platform == "tiktok" || platform == "x" {
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            disableAutomaticInterruptionHandling(springboard)
            window = springboard
        } else {
            window = app.windows.firstMatch
        }
        if platform == "tiktok" { dismissTikTokPasskey() }
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
            let fallback = platform == "x" || platform == "linkedin"
                ? CGVector(dx: 0.08, dy: 0.08)
                : CGVector(dx: 0.91, dy: 0.95)
            window.coordinate(withNormalizedOffset: point(command, "profile", fallback)).tap()
        }
        Thread.sleep(forTimeInterval: 1.0)
        if platform == "tiktok" { dismissTikTokPasskey() }
        let handlePredicate = NSPredicate(
            format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@ OR identifier CONTAINS[c] %@",
            normalized, normalized, normalized
        )
        if platform == "x" {
            let drawerHandle = app.descendants(matching: .any).matching(handlePredicate)
            if drawerHandle.count == 0 {
                let profileButton = app.buttons.matching(NSPredicate(format: "label ==[c] %@", "Profile"))
                let profileText = app.staticTexts.matching(NSPredicate(format: "label ==[c] %@", "Profile"))
                if profileButton.count > 0, profileButton.firstMatch.isHittable { profileButton.firstMatch.tap() }
                else if profileText.count > 0, profileText.firstMatch.isHittable { profileText.firstMatch.tap() }
                else { window.coordinate(withNormalizedOffset: CGVector(dx: 0.22, dy: 0.23)).tap() }
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
        let current = app.descendants(matching: .any).matching(handlePredicate)
        if current.firstMatch.waitForExistence(timeout: platform == "x" ? 10 : 1) {
            activeHandles[platform] = handle
            window.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: 0.95))).tap()
            return
        }

        // Profile headers on TikTok/Instagram expose the current username and
        // open the native account switcher when tapped.
        let accountMenu = app.buttons["user-switch-title-button"]
        if accountMenu.waitForExistence(timeout: 2), accountMenu.isHittable { accountMenu.tap() }
        else { window.coordinate(withNormalizedOffset: point(command, "accountMenu", .init(dx: 0.50, dy: 0.08))).tap() }
        Thread.sleep(forTimeInterval: 0.8)
        let targetText = app.staticTexts.matching(handlePredicate)
        let targetButton = app.buttons.matching(handlePredicate)
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
