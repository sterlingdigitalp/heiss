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

private enum PlatformScreenState: String {
    case home, profile, accountSwitcher = "account_switcher", search
    case onboardingOverlay = "onboarding_overlay"
    case unknown
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
        if action == "warmup:session" {
            return try performWarmupSession(command)
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
            dismissInstagramSetupPrompt(app)
        }
        if platform == "tiktok" {
            // TikTok's first-run surfaces can wedge XCTest while it snapshots
            // the animated accessibility hierarchy. Detect their rendered
            // copy with Vision and tap stable coordinates through SpringBoard.
            let surface = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            disableAutomaticInterruptionHandling(surface)
            try dismissTikTokInterestsPrompt(surface: surface)
            try dismissTikTokContactsPrompt(surface: surface)
            try dismissTikTokSwipeTutorial(surface: surface)
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
                    if !waitForSearchField(app, timeout: 0.2) {
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
                }
                let notNow = app.buttons.matching(NSPredicate(format: "label ==[c] %@", "Not now"))
                if notNow.count > 0, notNow.firstMatch.isHittable { notNow.firstMatch.tap() }
                if platform == "youtube" {
                    try openYouTubeSearch(app: app, surface: window, command: command)
                } else {
                    let searchButtons = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Search"))
                    if searchButtons.count > 0, searchButtons.firstMatch.isHittable { searchButtons.firstMatch.tap() }
                    else {
                        let fallback = platform == "x" ? CGVector(dx: 0.30, dy: 0.95) : CGVector(dx: 0.50, dy: 0.94)
                        window.coordinate(withNormalizedOffset: point(command, "search", fallback)).tap()
                    }
                }
            }
            Thread.sleep(forTimeInterval: 0.8)
            let fields = app.searchFields.count > 0 ? app.searchFields : app.textFields
            let terms = command["searchTerms"] as? [String] ?? []
            if fields.count > 0, let term = terms.randomElement() {
                let field = fields.firstMatch
                if platform == "youtube" { clearYouTubeSearchField(app: app, surface: window, field: field) }
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
                    else if platform == "youtube" {
                        window.coordinate(withNormalizedOffset: CGVector(dx: 0.87, dy: 0.96)).tap()
                    }
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

    /// Execute a frozen warmup plan with one app launch and one exact account
    /// verification. Progress is journaled after every gesture so a lost Mac
    /// acknowledgement cannot replay actions on retry.
    private func performWarmupSession(_ command: [String: Any]) throws -> [String: Any] {
        let platform = command["platform"] as? String ?? "tiktok"
        let handle = command["handle"] as? String ?? ""
        let sessionId = command["sessionId"] as? String ?? UUID().uuidString
        let plannedSteps = command["plannedSteps"] as? [String] ?? []
        let requestedStart = command["startIndex"] as? Int ?? 0
        guard !plannedSteps.isEmpty else {
            throw NSError(domain: "HeissRunner", code: 22, userInfo: [NSLocalizedDescriptionKey: "Batched warmup session has no planned steps"])
        }

        let journalURL = sessionJournalURL(sessionId)
        let prior = readSessionJournal(journalURL)
        let priorCompleted = prior?["completedSteps"] as? Int ?? 0
        var completed = min(plannedSteps.count, max(requestedStart, priorCompleted))
        var stepDetails = prior?["stepDetails"] as? [String] ?? Array(repeating: "", count: plannedSteps.count)
        if stepDetails.count < plannedSteps.count {
            stepDetails.append(contentsOf: Array(repeating: "", count: plannedSteps.count - stepDetails.count))
        }
        if completed >= plannedSteps.count {
            return [
                "ok": true, "executed": true,
                "detail": "xctest:\(platform):session:recovered:\(completed)/\(plannedSteps.count)",
                "completedSteps": completed, "stepDetails": stepDetails,
                "heartbeatAt": isoTimestamp(), "journal": journalURL.lastPathComponent,
            ]
        }

        let fallbackBundle = [
            "tiktok": "com.zhiliaoapp.musically",
            "instagram": "com.burbn.instagram",
            "x": "com.atebits.Tweetie2",
            "youtube": "com.google.ios.youtube"
        ][platform] ?? "com.zhiliaoapp.musically"
        let bundle = ((command["uiProfile"] as? [String: Any])?["bundleId"] as? String) ?? fallbackBundle
        let app = XCUIApplication(bundleIdentifier: bundle)
        if platform == "tiktok" || platform == "x" { disableAutomaticInterruptionHandling(app) }
        if platform == "tiktok" || platform == "youtube" {
            app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        }
        // Platform-major scheduling deliberately leaves the current app open.
        // Launch only when needed; never terminate between accounts or steps.
        if app.state != .runningForeground { app.launch() }
        if !app.wait(for: .runningForeground, timeout: 12) { app.activate() }
        guard app.wait(for: .runningForeground, timeout: 12) else {
            throw NSError(domain: "HeissRunner", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(platform) did not reach foreground"])
        }

        do {
            try sweepKnownOverlays(app: app, platform: platform)
            try assertNoBlockingOverlay(app: app, platform: platform)
            try ensureAccount(app, platform: platform, handle: handle, command: command)
            guard app.state == .runningForeground else {
                throw NSError(domain: "HeissRunner", code: 17, userInfo: [NSLocalizedDescriptionKey: "\(platform) lost foreground before batched session"])
            }
            let window: XCUIElement
            if platform == "tiktok" || platform == "x" {
                let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
                disableAutomaticInterruptionHandling(springboard)
                window = springboard
            } else {
                window = app.windows.firstMatch
            }
            writeSessionJournal(
                journalURL, sessionId: sessionId, platform: platform, handle: handle,
                status: "running", completedSteps: completed, plannedSteps: plannedSteps,
                stepDetails: stepDetails, error: nil
            )
            while completed < plannedSteps.count {
                try sweepKnownOverlays(app: app, platform: platform)
                try assertNoBlockingOverlay(app: app, platform: platform)
                guard app.state == .runningForeground else {
                    throw NSError(domain: "HeissRunner", code: 17, userInfo: [NSLocalizedDescriptionKey: "\(platform) lost foreground at step \(completed + 1)"])
                }
                let step = plannedSteps[completed]
                try performWarmupStep(step, app: app, window: window, platform: platform, command: command)
                stepDetails[completed] = "xctest:\(platform):\(step)"
                completed += 1
                writeSessionJournal(
                    journalURL, sessionId: sessionId, platform: platform, handle: handle,
                    status: completed == plannedSteps.count ? "completed" : "running",
                    completedSteps: completed, plannedSteps: plannedSteps,
                    stepDetails: stepDetails, error: nil
                )
                Thread.sleep(forTimeInterval: Double.random(in: 0.65...1.8))
            }
            // Leave the platform in a predictable state for the next account.
            window.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: 0.95))).tap()
            return [
                "ok": true, "executed": true,
                "detail": "xctest:\(platform):session:\(completed)/\(plannedSteps.count)",
                "completedSteps": completed, "stepDetails": stepDetails,
                "heartbeatAt": isoTimestamp(), "journal": journalURL.lastPathComponent,
            ]
        } catch {
            let screenshots = documents().appendingPathComponent("screenshots", isDirectory: true)
            try? fm.createDirectory(at: screenshots, withIntermediateDirectories: true)
            let name = "failure-\(UUID().uuidString).png"
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: screenshots.appendingPathComponent(name))
            let kind = failureKind(error)
            writeSessionJournal(
                journalURL, sessionId: sessionId, platform: platform, handle: handle,
                status: "checkpointed", completedSteps: completed, plannedSteps: plannedSteps,
                stepDetails: stepDetails, error: error.localizedDescription
            )
            return [
                "ok": false, "executed": false,
                "detail": "\(error.localizedDescription) (screenshot: \(name))",
                "failureKind": kind, "completedSteps": completed,
                "stepDetails": stepDetails, "heartbeatAt": isoTimestamp(),
                "journal": journalURL.lastPathComponent, "screenshot": name,
            ]
        }
    }

    private func waitForSearchField(_ app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if app.searchFields.firstMatch.exists || app.textFields.firstMatch.exists { return true }
            Thread.sleep(forTimeInterval: 0.2)
        } while Date() < deadline
        return false
    }

    private func tapVisibleYouTubeSearchButton(_ app: XCUIApplication) -> Bool {
        let buttons = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Search"))
        for button in buttons.allElementsBoundByIndex.reversed() where button.exists && button.isHittable {
            button.tap()
            if waitForSearchField(app, timeout: 2.5) { return true }
        }
        return false
    }

    private func openYouTubeSearch(
        app: XCUIApplication,
        surface: XCUIElement,
        command: [String: Any]
    ) throws {
        if waitForSearchField(app, timeout: 0.2) { return }
        if tapVisibleYouTubeSearchButton(app) { return }

        // YouTube collapses its top toolbar after feed scrolling. Returning to
        // the active Home tab restores it before trying bounded coordinates.
        surface.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: 0.965))).tap()
        Thread.sleep(forTimeInterval: 0.8)
        if tapVisibleYouTubeSearchButton(app) { return }

        let configured = point(command, "search", .init(dx: 0.93, dy: 0.060))
        let anchors = [configured, CGVector(dx: 0.93, dy: 0.060), CGVector(dx: 0.90, dy: 0.070)]
        for anchor in anchors {
            surface.coordinate(withNormalizedOffset: anchor).tap()
            if waitForSearchField(app, timeout: 2.5) { return }
        }
        throw NSError(
            domain: "HeissRunner",
            code: 12,
            userInfo: [NSLocalizedDescriptionKey: "YouTube Search control did not reveal a search field after restoring the Home toolbar"]
        )
    }

    private func clearYouTubeSearchField(app: XCUIApplication, surface: XCUIElement, field: XCUIElement) {
        guard let value = field.value as? String else { return }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty, !normalized.contains("search youtube") else { return }
        let clear = app.buttons.matching(
            NSPredicate(format: "label CONTAINS[c] %@", "Clear")
        ).firstMatch
        if clear.waitForExistence(timeout: 1), clear.isHittable { clear.tap() }
        else { surface.coordinate(withNormalizedOffset: CGVector(dx: 0.90, dy: 0.063)).tap() }
        Thread.sleep(forTimeInterval: 0.3)
    }

    private func performWarmupStep(
        _ action: String,
        app: XCUIApplication,
        window: XCUIElement,
        platform: String,
        command: [String: Any]
    ) throws {
        if action.contains("scroll") {
            let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.78))
            let end = window.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.28))
            start.press(forDuration: 0.08, thenDragTo: end)
            return
        }
        if action.contains("like") {
            window.coordinate(withNormalizedOffset: point(command, "like", .init(dx: 0.90, dy: 0.55))).tap()
            return
        }
        if action.contains("follow") {
            window.coordinate(withNormalizedOffset: point(command, "follow", .init(dx: 0.88, dy: 0.43))).tap()
            return
        }
        guard action.contains("search") else {
            throw NSError(domain: "HeissRunner", code: 3, userInfo: [NSLocalizedDescriptionKey: "Unsupported batched action \(action)"])
        }

        if platform == "instagram" {
            let explore = app.buttons["explore-tab"]
            if explore.waitForExistence(timeout: 3), explore.isHittable { explore.tap() }
            else { window.coordinate(withNormalizedOffset: point(command, "search", .init(dx: 0.70, dy: 0.95))).tap() }
        } else if platform == "tiktok" {
            if app.searchFields.firstMatch.exists {
                window.coordinate(withNormalizedOffset: CGVector(dx: 0.42, dy: 0.06)).tap()
            } else {
                window.coordinate(withNormalizedOffset: point(command, "search", .init(dx: 0.92, dy: 0.08))).tap()
            }
        } else {
            if platform == "youtube" {
                if !waitForSearchField(app, timeout: 0.2) {
                    let deadline = Date().addingTimeInterval(15)
                    var ready = false
                    while Date() < deadline {
                        ready = try screenContainsTextUsingOCR("Home") || screenContainsTextUsingOCR("Shorts")
                        if ready { break }
                        try sweepKnownOverlays(app: app, platform: platform)
                        Thread.sleep(forTimeInterval: 0.5)
                    }
                    guard ready else {
                        throw NSError(domain: "HeissRunner", code: 21, userInfo: [NSLocalizedDescriptionKey: "YouTube navigation did not finish loading before search"])
                    }
                }
            }
            if platform == "youtube" {
                try openYouTubeSearch(app: app, surface: window, command: command)
            } else {
                let searchButtons = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Search"))
                if searchButtons.count > 0, searchButtons.firstMatch.isHittable { searchButtons.firstMatch.tap() }
                else {
                    let fallback = platform == "x" ? CGVector(dx: 0.30, dy: 0.95) : CGVector(dx: 0.50, dy: 0.94)
                    window.coordinate(withNormalizedOffset: point(command, "search", fallback)).tap()
                }
            }
        }
        Thread.sleep(forTimeInterval: 0.8)
        let fields = app.searchFields.count > 0 ? app.searchFields : app.textFields
        let terms = command["searchTerms"] as? [String] ?? []
        guard fields.count > 0, let term = terms.randomElement() else {
            throw NSError(domain: "HeissRunner", code: 12, userInfo: [NSLocalizedDescriptionKey: "Search field was not found after opening platform search"])
        }
        let field = fields.firstMatch
        if platform == "youtube" { clearYouTubeSearchField(app: app, surface: window, field: field) }
        if platform == "tiktok" { window.coordinate(withNormalizedOffset: CGVector(dx: 0.42, dy: 0.06)).tap() }
        else if field.isHittable { field.tap() }
        else { field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
        let keyboardApp: XCUIApplication
        if platform == "tiktok" {
            keyboardApp = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            disableAutomaticInterruptionHandling(keyboardApp)
        } else { keyboardApp = app }
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
            else if platform == "youtube" {
                window.coordinate(withNormalizedOffset: CGVector(dx: 0.87, dy: 0.96)).tap()
            }
        }
    }

    private func sweepKnownOverlays(app: XCUIApplication, platform: String) throws {
        if platform == "instagram" { dismissInstagramSetupPrompt(app) }
        if platform == "tiktok" {
            let surface = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            disableAutomaticInterruptionHandling(surface)
            dismissTikTokPasskey()
            try dismissTikTokInterestsPrompt(surface: surface)
            try dismissTikTokContactsPrompt(surface: surface)
            try dismissTikTokSwipeTutorial(surface: surface)
        }
        if platform == "youtube" { try dismissYouTubeDefaultAccountPrompt(app) }
    }

    private func detectPlatformState(app: XCUIApplication, platform: String) throws -> PlatformScreenState {
        let onboardingTerms = ["Choose your interests", "Sync contacts", "Swipe up", "Default Account", "Save your login"]
        for term in onboardingTerms {
            if try screenContainsTextUsingOCR(term) { return .onboardingOverlay }
        }
        if app.keyboards.firstMatch.exists { return .search }
        if try screenContainsTextUsingOCR("Search", minimumVisionY: 0.72, maximumVisionY: 0.96) { return .search }
        let switcherTerms = ["Add Instagram account", "Manage accounts", "Switch account", "Add account"]
        for term in switcherTerms {
            if try screenContainsTextUsingOCR(term) { return .accountSwitcher }
        }
        if try screenContainsTextUsingOCR("Profile", minimumVisionY: 0.55, maximumVisionY: 0.95) { return .profile }
        if try screenContainsTextUsingOCR("Home", maximumVisionY: 0.30) { return .home }
        return .unknown
    }

    private func assertNoBlockingOverlay(app: XCUIApplication, platform: String) throws {
        if try detectPlatformState(app: app, platform: platform) == .onboardingOverlay {
            throw NSError(domain: "HeissRunner", code: 24, userInfo: [NSLocalizedDescriptionKey: "Onboarding overlay remains after bounded cleanup"])
        }
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        disableAutomaticInterruptionHandling(springboard)
        if app.alerts.count > 0 || springboard.alerts.count > 0 {
            throw NSError(domain: "HeissRunner", code: 24, userInfo: [NSLocalizedDescriptionKey: "Unexpected popup or permission alert is blocking (platform)"])
        }
    }

    private func sessionJournalURL(_ sessionId: String) -> URL {
        let journals = documents().appendingPathComponent("journals", isDirectory: true)
        try? fm.createDirectory(at: journals, withIntermediateDirectories: true)
        let safe = sessionId.replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "-", options: .regularExpression)
        return journals.appendingPathComponent("\(safe).json")
    }

    private func readSessionJournal(_ url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func writeSessionJournal(
        _ url: URL,
        sessionId: String,
        platform: String,
        handle: String,
        status: String,
        completedSteps: Int,
        plannedSteps: [String],
        stepDetails: [String],
        error: String?
    ) {
        var journal: [String: Any] = [
            "sessionId": sessionId, "platform": platform, "handle": handle,
            "status": status, "completedSteps": completedSteps,
            "plannedSteps": plannedSteps, "stepDetails": stepDetails,
            "updatedAt": isoTimestamp(),
        ]
        if let error { journal["error"] = error }
        if let data = try? JSONSerialization.data(withJSONObject: journal) {
            try? data.write(to: url, options: .atomic)
        }
    }

    private func isoTimestamp() -> String {
        ISO8601DateFormatter().string(from: Date())
    }

    private func failureKind(_ error: Error) -> String {
        let text = error.localizedDescription.lowercased()
        if text.contains("account") && (text.contains("not found") || text.contains("verify") || text.contains("exact handle")) {
            return "account_mismatch"
        }
        if text.contains("prompt") || text.contains("onboarding") || text.contains("tutorial") || text.contains("overlay") {
            return "unknown_ui"
        }
        if text.contains("foreground") || text.contains("navigation") || text.contains("search field") || text.contains("keyboard") {
            return "app_navigation"
        }
        return "action"
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

    private func dismissInstagramSetupPrompt(_ app: XCUIApplication) {
        // Instagram may defer “Finish setting up your profile” until Profile
        // is opened, so this must run both after launch and after navigation.
        // The exact Not now label keeps the dismissal fail-closed.
        let notNow = app.buttons.matching(NSPredicate(format: "label ==[c] %@", "Not now")).firstMatch
        if notNow.waitForExistence(timeout: 1), notNow.isHittable {
            notNow.tap()
            Thread.sleep(forTimeInterval: 0.5)
        }
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

    private func dismissTikTokInterestsPrompt(surface: XCUIElement) throws {
        // Like the contacts upsell, TikTok can defer this onboarding screen
        // until a later relaunch. Guard the stable Skip coordinate with the
        // distinctive rendered heading so feed content can never be tapped.
        for _ in 0..<2 {
            guard try screenContainsTextUsingOCR("Choose your interests") else { return }
            if !(try tapTextUsingOCR(surface: surface, expected: "Skip")) {
                surface.coordinate(withNormalizedOffset: CGVector(dx: 0.29, dy: 0.94)).tap()
            }
            Thread.sleep(forTimeInterval: 0.8)
        }
        if try screenContainsTextUsingOCR("Choose your interests") {
            throw NSError(domain: "HeissRunner", code: 21, userInfo: [NSLocalizedDescriptionKey: "TikTok interests prompt did not dismiss"])
        }
    }

    private func dismissTikTokSwipeTutorial(surface: XCUIElement) throws {
        for _ in 0..<3 {
            let app = XCUIApplication(bundleIdentifier: "com.zhiliaoapp.musically")
            let accessible = app.descendants(matching: .any).matching(
                NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@", "Swipe up", "Swipe up")
            ).count > 0
            if !(try screenContainsTextUsingOCR("Swipe up")) && !accessible { return }
            let start = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.82))
            let end = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.10))
            start.press(forDuration: 0.08, thenDragTo: end)
            Thread.sleep(forTimeInterval: 1.0)
        }
        let app = XCUIApplication(bundleIdentifier: "com.zhiliaoapp.musically")
        let accessible = app.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@", "Swipe up", "Swipe up")
        ).count > 0
        if try screenContainsTextUsingOCR("Swipe up") || accessible {
            throw NSError(domain: "HeissRunner", code: 18, userInfo: [NSLocalizedDescriptionKey: "TikTok swipe tutorial did not dismiss after three gestures"])
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
                try tapExactHandle(app, surface: window, predicate: handlePredicate, handle: handle, platform: platform, command: command)
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
            // With four or more signed-in accounts, X collapses additional
            // identities behind the overflow button at the right of the
            // avatar row. Search that account list by exact rendered handle.
            window.coordinate(withNormalizedOffset: CGVector(dx: 0.74, dy: 0.075)).tap()
            Thread.sleep(forTimeInterval: 1.0)
            if try tapExactHandleUsingOCR(surface: window, normalized: normalized) {
                Thread.sleep(forTimeInterval: 1.2)
                try openXDrawer(surface: window)
                inspectedAccounts.append(try recognizedTextStringsUsingOCR(minimumVisionY: 0.72).joined(separator: " | "))
                if try screenContainsExactHandleUsingOCR(normalized: normalized, minimumVisionY: 0.72) {
                    window.coordinate(withNormalizedOffset: CGVector(dx: 0.90, dy: 0.50)).tap()
                    activeHandles[platform] = handle
                    return
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
            try dismissTikTokInterestsPrompt(surface: window)
            try dismissTikTokContactsPrompt(surface: window)
            try dismissTikTokSwipeTutorial(surface: window)
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
        if platform == "instagram" {
            // A follow/like may leave Instagram inside a post-detail view
            // where the bottom navigation (and therefore Profile) is hidden.
            // Walk back only while Profile is absent, then use the stable tab.
            for _ in 0..<3 {
                if profileTab.waitForExistence(timeout: 0.5), profileTab.isHittable { break }
                let back = app.buttons.matching(
                    NSPredicate(format: "label ==[c] %@ OR identifier ==[c] %@", "Back", "back")
                ).firstMatch
                if back.waitForExistence(timeout: 0.5), back.isHittable { back.tap() }
                else { window.coordinate(withNormalizedOffset: CGVector(dx: 0.09, dy: 0.07)).tap() }
                Thread.sleep(forTimeInterval: 0.6)
            }
        }
        if platform == "instagram", profileTab.waitForExistence(timeout: 2), profileTab.isHittable { profileTab.tap() }
        else {
            let fallback = platform == "x"
                ? CGVector(dx: 0.08, dy: 0.08)
                : CGVector(dx: 0.91, dy: 0.95)
            window.coordinate(withNormalizedOffset: point(command, "profile", fallback)).tap()
        }
        Thread.sleep(forTimeInterval: 1.0)
        if platform == "instagram" { dismissInstagramSetupPrompt(app) }
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
            try dismissTikTokInterestsPrompt(surface: window)
            try dismissTikTokContactsPrompt(surface: window)
            try dismissTikTokSwipeTutorial(surface: window)
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
        var isCurrent: Bool
        if platform == "instagram" {
            isCurrent = instagramTitleMatches(app, normalized: normalized)
        } else if platform == "tiktok" {
            // TikTok can wedge XCTest while snapshotting its animated profile
            // hierarchy. Vision reads the rendered username without asking the
            // app (or Continuity) for an accessibility snapshot.
            isCurrent = try screenContainsExactHandleUsingOCR(normalized: normalized, minimumVisionY: 0.58, maximumVisionY: 0.92)
            if !isCurrent {
                // A freshly loaded feed can ignore the first tab gesture while
                // its player becomes interactive. Retry the actual compact-
                // iPhone Profile center once, then re-check the rendered handle.
                window.coordinate(withNormalizedOffset: CGVector(dx: 0.90, dy: 0.965)).tap()
                Thread.sleep(forTimeInterval: 1.2)
                try dismissTikTokInterestsPrompt(surface: window)
                try dismissTikTokContactsPrompt(surface: window)
                try dismissTikTokSwipeTutorial(surface: window)
                isCurrent = try screenContainsExactHandleUsingOCR(normalized: normalized, minimumVisionY: 0.58, maximumVisionY: 0.92)
            }
        } else {
            isCurrent = app.descendants(matching: .any).matching(handlePredicate).firstMatch.waitForExistence(timeout: platform == "x" ? 10 : 1)
        }
        if isCurrent {
            activeHandles[platform] = handle
            window.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: 0.95))).tap()
            return
        }

        if platform == "tiktok" {
            // Account-specific onboarding can appear only after TikTok has
            // finished switching profiles. Clear it once more before treating
            // the obscured handle as an account mismatch.
            try dismissTikTokInterestsPrompt(surface: window)
            try dismissTikTokContactsPrompt(surface: window)
            try dismissTikTokSwipeTutorial(surface: window)
            if try waitForExactHandleUsingOCR(normalized: normalized, timeout: 3, minimumVisionY: 0.58, maximumVisionY: 0.92) {
                activeHandles[platform] = handle
                window.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: 0.95))).tap()
                return
            }
        }

        // Profile headers on TikTok/Instagram expose the current username and
        // open the native account switcher when tapped.
        if platform == "tiktok" {
            // Compact TikTok puts the chevron beside the display name. The
            // handle one row below copies the username instead of opening the
            // switcher, so keep this fallback centered on the chevron itself.
            window.coordinate(withNormalizedOffset: point(command, "accountMenu", .init(dx: 0.63, dy: 0.238))).tap()
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
        try tapExactHandle(app, surface: window, predicate: handlePredicate, handle: handle, platform: platform, command: command)
        Thread.sleep(forTimeInterval: 0.8)
        if platform == "tiktok" {
            try dismissTikTokInterestsPrompt(surface: window)
            try dismissTikTokContactsPrompt(surface: window)
            try dismissTikTokSwipeTutorial(surface: window)
        }
        let verified: Bool
        if platform == "instagram" {
            verified = instagramTitleMatches(app, normalized: normalized)
        } else if platform == "tiktok" {
            verified = try waitForExactHandleUsingOCR(normalized: normalized, timeout: 8, minimumVisionY: 0.58, maximumVisionY: 0.92)
        } else {
            verified = app.descendants(matching: .any).matching(handlePredicate).firstMatch.waitForExistence(timeout: 5)
        }
        guard verified else {
            throw NSError(domain: "HeissRunner", code: 15, userInfo: [NSLocalizedDescriptionKey: "Account switch did not verify exact handle \(handle) on \(platform)"])
        }
        activeHandles[platform] = handle
        window.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: 0.95))).tap()
    }

    private func tapExactHandle(
        _ app: XCUIApplication,
        surface: XCUIElement,
        predicate: NSPredicate,
        handle: String,
        platform: String,
        command: [String: Any]
    ) throws {
        let normalized = handle.hasPrefix("@") ? String(handle.dropFirst()) : handle
        if platform == "tiktok" {
            if try tapExactHandleUsingOCR(surface: surface, normalized: normalized) { return }
            for hint in accountPickerHints(command) {
                if try tapTextUsingOCR(surface: surface, expected: hint) { return }
            }
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
        for hint in accountPickerHints(command) {
            if try tapTextUsingOCR(surface: surface, expected: hint) { return }
        }
        throw NSError(domain: "HeissRunner", code: 5, userInfo: [NSLocalizedDescriptionKey: "Account \(handle) was not found in the \(platform) switcher"])
    }

    private func accountPickerHints(_ command: [String: Any]) -> [String] {
        return ["switcherHint", "displayName", "loginEmail"].compactMap { key in
            guard let value = command[key] as? String, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return value
        }
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
        try dismissYouTubeManageAccounts(app)
        try dismissYouTubeAccountSwitcher(app)
        surface.coordinate(withNormalizedOffset: point(command, "profile", .init(dx: 0.91, dy: 0.95))).tap()
        Thread.sleep(forTimeInterval: 1.0)
        try dismissYouTubeDefaultAccountPrompt(app)
        try dismissYouTubeManageAccounts(app)
        try dismissYouTubeAccountSwitcher(app)
        surface.coordinate(withNormalizedOffset: point(command, "profile", .init(dx: 0.91, dy: 0.95))).tap()
        Thread.sleep(forTimeInterval: 0.8)
        if try screenContainsExactHandleUsingOCR(normalized: normalized, minimumVisionY: 0.50, maximumVisionY: 0.94) {
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
        if !selected {
            for hint in accountPickerHints(command) where !selected {
                selected = try tapTextUsingOCR(surface: surface, expected: hint)
            }
        }
        guard selected else {
            throw NSError(domain: "HeissRunner", code: 5, userInfo: [NSLocalizedDescriptionKey: "Account \(handle) was not found in the youtube switcher"])
        }
        Thread.sleep(forTimeInterval: 1.2)

        surface.coordinate(withNormalizedOffset: point(command, "profile", .init(dx: 0.91, dy: 0.95))).tap()
        Thread.sleep(forTimeInterval: 1.0)
        if !(try screenContainsExactHandleUsingOCR(normalized: normalized, minimumVisionY: 0.50, maximumVisionY: 0.94)) {
            let channel = app.descendants(matching: .any).matching(
                NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "View channel", "Your channel")
            ).firstMatch
            if channel.waitForExistence(timeout: 2), channel.isHittable {
                channel.tap()
                Thread.sleep(forTimeInterval: 1.0)
            }
        }
        guard try screenContainsExactHandleUsingOCR(normalized: normalized, minimumVisionY: 0.50, maximumVisionY: 0.94) else {
            throw NSError(domain: "HeissRunner", code: 15, userInfo: [NSLocalizedDescriptionKey: "Account switch did not verify exact handle \(handle) on youtube"])
        }
        activeHandles["youtube"] = handle
        surface.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: 0.95))).tap()
    }

    private func dismissYouTubeAccountSwitcher(_ app: XCUIApplication) throws {
        let switcherVisible = try screenContainsTextUsingOCR("Other accounts")
            && screenContainsTextUsingOCR("Manage accounts on this device")
        guard switcherVisible else { return }
        let close = app.buttons.matching(
            NSPredicate(format: "label ==[c] %@ OR label ==[c] %@", "Close", "Cancel")
        ).firstMatch
        if close.waitForExistence(timeout: 1), close.isHittable {
            close.tap()
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.052, dy: 0.063)).press(forDuration: 0.08)
        }
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline, try screenContainsTextUsingOCR("Other accounts") {
            Thread.sleep(forTimeInterval: 0.4)
        }
        if try screenContainsTextUsingOCR("Other accounts") {
            throw NSError(domain: "HeissRunner", code: 20, userInfo: [NSLocalizedDescriptionKey: "YouTube account switcher could not be closed"])
        }
        Thread.sleep(forTimeInterval: 0.4)
    }

    private func dismissYouTubeManageAccounts(_ app: XCUIApplication) throws {
        // "Manage accounts" is also a row label on the account-switcher sheet
        // that sits UNDER the full-screen manager, so keying detection and
        // dismissal-verification on that title reports false failures after a
        // successful Done tap. The per-account "Remove from this device" rows
        // exist only on the manager screen itself.
        guard try screenContainsTextUsingOCR("Remove from this device") else { return }
        // This full-screen manager belongs to YouTube, not SpringBoard.
        let managerDone = app.buttons.matching(
            NSPredicate(format: "label ==[c] %@", "Done")
        ).firstMatch
        if managerDone.waitForExistence(timeout: 1), managerDone.isHittable {
            managerDone.tap()
            Thread.sleep(forTimeInterval: 0.4)
        }
        if try screenContainsTextUsingOCR("Remove from this device") {
            _ = try tapTextUsingOCR(surface: app, expected: "Done")
            Thread.sleep(forTimeInterval: 0.4)
        }
        if try screenContainsTextUsingOCR("Remove from this device") {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.89, dy: 0.075)).press(forDuration: 0.08)
        }
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline, try screenContainsTextUsingOCR("Remove from this device") {
            Thread.sleep(forTimeInterval: 0.5)
        }
        if try screenContainsTextUsingOCR("Remove from this device") {
            throw NSError(domain: "HeissRunner", code: 20, userInfo: [NSLocalizedDescriptionKey: "YouTube Manage accounts screen could not be dismissed after tapping Done"])
        }
        Thread.sleep(forTimeInterval: 0.5)
    }

    private func dismissYouTubeDefaultAccountPrompt(_ app: XCUIApplication) throws {
        try dismissYouTubeManageAccounts(app)
        guard try screenContainsTextUsingOCR("Default Account") else { return }
        let surface = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        disableAutomaticInterruptionHandling(surface)
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
        // Account rows live between the status bar and bottom navigation.
        // Cropping prevents a matching handle in the underlying feed from
        // being mistaken for the switcher row.
        guard let match = try recognizedHandleObservation(normalized: normalized, minimumVisionY: 0.08, maximumVisionY: 0.95) else { return false }
        let box = match.boundingBox
        surface.coordinate(withNormalizedOffset: CGVector(dx: box.midX, dy: 1.0 - box.midY)).tap()
        return true
    }

    private func screenContainsExactHandleUsingOCR(
        normalized: String,
        minimumVisionY: CGFloat = 0,
        maximumVisionY: CGFloat = 1
    ) throws -> Bool {
        return try recognizedHandleObservation(
            normalized: normalized,
            minimumVisionY: minimumVisionY,
            maximumVisionY: maximumVisionY
        ) != nil
    }

    private func waitForExactHandleUsingOCR(
        normalized: String,
        timeout: TimeInterval,
        minimumVisionY: CGFloat = 0,
        maximumVisionY: CGFloat = 1
    ) throws -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if try screenContainsExactHandleUsingOCR(
                normalized: normalized,
                minimumVisionY: minimumVisionY,
                maximumVisionY: maximumVisionY
            ) { return true }
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

    private func screenContainsTextUsingOCR(
        _ expected: String,
        minimumVisionY: CGFloat = 0,
        maximumVisionY: CGFloat = 1
    ) throws -> Bool {
        guard let image = UIImage(data: XCUIScreen.main.screenshot().pngRepresentation)?.cgImage else { return false }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
        return (request.results ?? []).contains { observation in
            observation.boundingBox.midY >= minimumVisionY &&
            observation.boundingBox.midY <= maximumVisionY && observation.topCandidates(3).contains {
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

    private func recognizedHandleObservation(
        normalized: String,
        minimumVisionY: CGFloat = 0,
        maximumVisionY: CGFloat = 1
    ) throws -> VNRecognizedTextObservation? {
        guard let image = UIImage(data: XCUIScreen.main.screenshot().pngRepresentation)?.cgImage else { return nil }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
        let observations = request.results ?? []
        return observations.first(where: { observation in
            observation.boundingBox.midY >= minimumVisionY &&
            observation.boundingBox.midY <= maximumVisionY &&
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
