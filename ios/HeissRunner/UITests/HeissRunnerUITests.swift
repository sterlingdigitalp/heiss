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

private let heissRunnerProtocolVersion = 2
private let heissRunnerBuild = "heiss-runner-2026.07.17.5"

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
        // Session journals from a prior host must never let a reused sessionId
        // report recovered progress against a stale plan.
        let journals = documents().appendingPathComponent("journals", isDirectory: true)
        for stale in (try? fm.contentsOfDirectory(at: journals, includingPropertiesForKeys: nil)) ?? [] {
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
        func respond(_ result: [String: Any], generation: String) {
            var payload = result
            payload["protocolVersion"] = heissRunnerProtocolVersion
            payload["runnerBuild"] = heissRunnerBuild
            payload["commandGeneration"] = generation
            if let data = try? JSONSerialization.data(withJSONObject: payload) {
                try? data.write(to: outbox.appendingPathComponent(file.lastPathComponent), options: .atomic)
            }
            try? fm.removeItem(at: file)
        }
        guard let data = try? Data(contentsOf: file),
              let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else {
            // A malformed payload still gets a tagged reply so the Mac fails
            // fast instead of waiting out its transport timeout.
            respond([
                "ok": false, "executed": false, "failureKind": "transport",
                "detail": "Malformed command payload could not be parsed",
            ], generation: "unknown")
            return
        }
        let generation = command["commandGeneration"] as? String ?? command["id"] as? String ?? "unknown"
        do {
            respond(try perform(command), generation: generation)
        } catch {
            let screenshots = documents().appendingPathComponent("screenshots", isDirectory: true)
            try? fm.createDirectory(at: screenshots, withIntermediateDirectories: true)
            let name = "failure-\(UUID().uuidString).png"
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: screenshots.appendingPathComponent(name))
            respond([
                "ok": false, "executed": false,
                "failureKind": failureKind(error),
                "detail": "\(error.localizedDescription) (screenshot: \(name))",
                "screenshot": name,
            ], generation: generation)
        }
    }

    private func perform(_ command: [String: Any]) throws -> [String: Any] {
        let action = command["action"] as? String ?? "unknown"
        if action == "ping" { return ["ok": true, "executed": true, "detail": "xctest-ready"] }
        let requestedProtocol = command["protocolVersion"] as? Int ?? 0
        let requestedBuild = command["expectedRunnerBuild"] as? String ?? ""
        guard requestedProtocol == heissRunnerProtocolVersion, requestedBuild == heissRunnerBuild else {
            throw NSError(
                domain: "HeissRunner", code: 30,
                userInfo: [NSLocalizedDescriptionKey: "Runner protocol mismatch: controller requested v\(requestedProtocol)/\(requestedBuild), runner is v\(heissRunnerProtocolVersion)/\(heissRunnerBuild)"]
            )
        }
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
        let xPostContinuation = platform == "x" && ["post:caption", "post:media_optional", "post:publish"].contains(action)
        let xPostStateful = xPostContinuation || (platform == "x" && action == "post:verify_published")
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
        if (platform == "tiktok" || (platform == "x" && !xPostStateful) || platform == "youtube"), app.state != .notRunning {
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
        // A limited-Photos alert belongs to the app that requested it, but iOS
        // can leave it above whichever app XCTest launches next. Clear the
        // safe, non-expanding choice before attributing alerts to this app.
        let systemUI = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        disableAutomaticInterruptionHandling(systemUI)
        // TikTok defers the limited-Photos sheet until its restored Story
        // surface settles, sometimes well after XCTest reports foreground.
        let latePromptTimeout: TimeInterval = platform == "tiktok" ? 20 : 3
        _ = try dismissStaleLimitedPhotosSystemPrompt(
            surface: systemUI.windows.firstMatch,
            app: platform == "tiktok" ? nil : app,
            appearanceTimeout: latePromptTimeout
        )
        if app.state != .runningForeground {
            app.activate()
            guard app.wait(for: .runningForeground, timeout: 8) else {
                throw NSError(domain: "HeissRunner", code: 17, userInfo: [NSLocalizedDescriptionKey: "\(platform) did not recover after clearing a delayed system prompt"])
            }
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
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            disableAutomaticInterruptionHandling(springboard)
            let surface = springboard.windows.firstMatch
            try dismissTikTokPhotoStoryPrompt(app: app, surface: surface)
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
        if xPostContinuation {
            guard activeHandles["x"]?.caseInsensitiveCompare(command["handle"] as? String ?? "") == .orderedSame else {
                throw NSError(domain: "HeissRunner", code: 15, userInfo: [
                    NSLocalizedDescriptionKey: "X composer continuation lost its verified account state; refusing to continue",
                    "failureKind": "account_mismatch",
                ])
            }
            let composer = app.textViews.firstMatch.exists || app.textFields.firstMatch.exists
            guard composer else {
                throw NSError(domain: "HeissRunner", code: 9, userInfo: [NSLocalizedDescriptionKey: "X composer is no longer visible; refusing to continue or publish"])
            }
        } else if action != "post:verify_published" {
            try ensureAccountVerified(app, platform: platform, handle: handle, command: command)
            if app.state != .runningForeground {
                app.activate()
                guard app.wait(for: .runningForeground, timeout: 8) else {
                    throw NSError(domain: "HeissRunner", code: 17, userInfo: [NSLocalizedDescriptionKey: "\(platform) lost foreground before \(action)"])
                }
                try ensureAccountVerified(app, platform: platform, handle: handle, command: command)
            }
        }
        if action == "verify:account" {
            return ["ok": true, "executed": true, "detail": "xctest:\(platform):verified:\(handle)"]
        }

        let window: XCUIElement
        if platform == "tiktok" || platform == "x" {
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            disableAutomaticInterruptionHandling(springboard)
            window = platform == "tiktok" ? springboard.windows.firstMatch : springboard
        } else {
            window = app.windows.firstMatch
        }
        Thread.sleep(forTimeInterval: Double.random(in: 0.65...1.8))
        if action == "verify:composer" {
            guard platform == "x" else {
                throw NSError(domain: "HeissRunner", code: 3, userInfo: [NSLocalizedDescriptionKey: "Composer canary is only supported for X"])
            }
            window.coordinate(withNormalizedOffset: point(command, "create", .init(dx: 0.90, dy: 0.88))).tap()
            guard app.textViews.firstMatch.waitForExistence(timeout: 8) || app.textFields.firstMatch.waitForExistence(timeout: 2) else {
                throw NSError(domain: "HeissRunner", code: 2, userInfo: [NSLocalizedDescriptionKey: "X composer canary could not open the composer"])
            }
            let close = app.buttons.matching(NSPredicate(
                format: "label ==[c] %@ OR label ==[c] %@ OR label ==[c] %@",
                "Close", "Cancel", "Back"
            )).firstMatch
            if close.waitForExistence(timeout: 2), close.isHittable { close.tap() }
            else { window.coordinate(withNormalizedOffset: CGVector(dx: 0.06, dy: 0.07)).tap() }
            let discard = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Discard")).firstMatch
            if discard.waitForExistence(timeout: 1), discard.isHittable { discard.tap() }
            if app.textViews.firstMatch.waitForExistence(timeout: 2) {
                throw NSError(domain: "HeissRunner", code: 2, userInfo: [NSLocalizedDescriptionKey: "X composer canary opened successfully but did not close cleanly"])
            }
            return ["ok": true, "executed": true, "detail": "xctest:x:composer_canary:opened_and_closed"]
        } else if action == "post:verify_published" {
            let predicate = platform == "x"
                ? NSPredicate(format: "label ==[c] %@", "Post")
                : NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "Post", "Share")
            let publish = app.buttons.matching(predicate)
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
            var targets = Set<String>()
            let detail = try performGuardedEngagement(
                action: "like", app: app, window: window, platform: platform,
                command: command, engagedTargetKeys: &targets
            )
            return ["ok": true, "executed": true, "detail": detail]
        } else if action.contains("follow") {
            var targets = Set<String>()
            let detail = try performGuardedEngagement(
                action: "follow", app: app, window: window, platform: platform,
                command: command, engagedTargetKeys: &targets
            )
            return ["ok": true, "executed": true, "detail": detail]
        } else if action.contains("search") {
            if platform == "instagram" {
                let notNow = app.buttons.matching(NSPredicate(format: "label ==[c] %@", "Not now"))
                if notNow.count > 0, notNow.firstMatch.isHittable { notNow.firstMatch.tap() }
                let explore = app.buttons["explore-tab"]
                if explore.waitForExistence(timeout: 3), explore.isHittable { explore.tap() }
                else { window.coordinate(withNormalizedOffset: point(command, "search", .init(dx: 0.70, dy: 0.95))).tap() }
            } else if platform == "tiktok" {
                // Reset to Home so the search button has one stable meaning;
                // querying the animated results hierarchy can wedge XCTest.
                window.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: 0.965))).tap()
                Thread.sleep(forTimeInterval: 0.8)
                window.coordinate(withNormalizedOffset: point(command, "search", .init(dx: 0.92, dy: 0.08))).tap()
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
            let terms = command["searchTerms"] as? [String] ?? []
            if platform == "tiktok" {
                guard let term = terms.randomElement() else {
                    throw NSError(domain: "HeissRunner", code: 12, userInfo: [NSLocalizedDescriptionKey: "No search term is configured"])
                }
                try performTikTokSearchTyping(surface: window, term: term)
            } else {
                let fields = app.searchFields.count > 0 ? app.searchFields : app.textFields
                guard fields.count > 0, let term = terms.randomElement() else {
                    throw NSError(domain: "HeissRunner", code: 12, userInfo: [NSLocalizedDescriptionKey: "Search field was not found after opening platform search"])
                }
                let field = fields.firstMatch
                if field.isHittable { field.tap() }
                else { field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
                guard app.keyboards.firstMatch.waitForExistence(timeout: 3) else {
                    throw NSError(domain: "HeissRunner", code: 11, userInfo: [NSLocalizedDescriptionKey: "Search field did not receive keyboard focus"])
                }
                clearSearchFieldIfNeeded(app, surface: window, field: field)
                try typeUsingVisibleKeyboard(app, text: term)
                submitVisibleSearch(app, surface: window, command: command)
            }
        } else if action == "post:compose" {
            guard platform == "x" else {
                throw NSError(domain: "HeissRunner", code: 3, userInfo: [NSLocalizedDescriptionKey: "post:compose is only valid for X"])
            }
            window.coordinate(withNormalizedOffset: point(command, "create", .init(dx: 0.90, dy: 0.88))).tap()
            let composer = app.textViews.firstMatch
            guard composer.waitForExistence(timeout: 8) || app.textFields.firstMatch.waitForExistence(timeout: 2) else {
                throw NSError(domain: "HeissRunner", code: 2, userInfo: [NSLocalizedDescriptionKey: "X compose button did not open a text composer"])
            }
        } else if action == "post:upload" {
            let staged = command["stagedMediaNames"] as? [String] ?? []
            // Never open the composer without media to attach. An empty list
            // previously still tapped picker cell 0 (via a max(_,1) floor),
            // which publishes an arbitrary photo from the camera roll to a real
            // account. A missing asset is a hard error, not an optional.
            guard !staged.isEmpty else {
                throw NSError(domain: "HeissRunner", code: 25, userInfo: [
                    NSLocalizedDescriptionKey: "post:upload received no staged media; refusing to open the picker",
                    "failureKind": "action",
                ])
            }
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
            guard cells.firstMatch.waitForExistence(timeout: 8) else {
                throw NSError(domain: "HeissRunner", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: "Media picker did not show staged Photos",
                    "failureKind": "app_navigation",
                ])
            }
            for index in 0..<min(staged.count, cells.count) {
                cells.element(boundBy: index).tap()
            }
            let next = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Next"))
            if next.count > 0 { next.firstMatch.tap() }
        } else if action == "post:caption" {
            let text = command["caption"] as? String ?? ""
            let fields = app.textViews.count > 0 ? app.textViews : app.textFields
            guard fields.count > 0 else {
                throw NSError(domain: "HeissRunner", code: 2, userInfo: [NSLocalizedDescriptionKey: "Post text field was not found"])
            }
            fields.firstMatch.tap(); fields.firstMatch.typeText(text)
        } else if action == "post:media_optional" {
            guard platform == "x" else {
                throw NSError(domain: "HeissRunner", code: 3, userInfo: [NSLocalizedDescriptionKey: "post:media_optional is only valid for X"])
            }
            let staged = command["stagedMediaNames"] as? [String] ?? []
            if !staged.isEmpty {
                for name in staged { try importIntoPhotos(documents().appendingPathComponent("media").appendingPathComponent(name)) }
                let media = app.buttons.matching(NSPredicate(
                    format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@ OR label CONTAINS[c] %@",
                    "media", "photo", "gallery"
                )).firstMatch
                if media.waitForExistence(timeout: 3), media.isHittable { media.tap() }
                else { window.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.88)).tap() }
                let cells = app.cells
                guard cells.firstMatch.waitForExistence(timeout: 8) else {
                    throw NSError(domain: "HeissRunner", code: 2, userInfo: [NSLocalizedDescriptionKey: "X media picker did not show staged Photos"])
                }
                for index in 0..<min(staged.count, cells.count) { cells.element(boundBy: index).tap() }
                let add = app.buttons.matching(NSPredicate(format: "label ==[c] %@ OR label ==[c] %@ OR label ==[c] %@", "Add", "Done", "Next")).firstMatch
                if add.waitForExistence(timeout: 3), add.isHittable { add.tap() }
            }
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
            let predicate = platform == "x"
                ? NSPredicate(format: "label ==[c] %@", "Post")
                : NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "Post", "Share")
            let candidates = app.buttons.matching(predicate)
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
        let commandGeneration = command["commandGeneration"] as? String ?? command["id"] as? String ?? UUID().uuidString
        let plannedSteps = command["plannedSteps"] as? [String] ?? []
        let requestedStart = command["startIndex"] as? Int ?? 0
        guard !plannedSteps.isEmpty else {
            throw NSError(domain: "HeissRunner", code: 22, userInfo: [NSLocalizedDescriptionKey: "Batched warmup session has no planned steps"])
        }

        let journalURL = sessionJournalURL(sessionId)
        let prior = readSessionJournal(journalURL)
        // Only trust a prior journal that recorded the SAME plan. A reused
        // sessionId carrying a different plannedSteps must not skip work.
        // Frozen per-session plans mean legitimate retries still match here,
        // preserving lost-acknowledgement idempotency.
        let priorMatches = (prior?["plannedSteps"] as? [String]) == plannedSteps
        let priorCompleted = priorMatches ? (prior?["completedSteps"] as? Int ?? 0) : 0
        var completed = min(plannedSteps.count, max(requestedStart, priorCompleted))
        var stepDetails = (priorMatches ? prior?["stepDetails"] as? [String] : nil) ?? Array(repeating: "", count: plannedSteps.count)
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
        if platform == "tiktok" || platform == "youtube" || platform == "x" {
            app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        }
        // TikTok/X/YouTube leave search-result and keyboard surfaces that hide
        // Home and the account controls, so a prior session's leftover search
        // (e.g. X on a results screen with the keyboard up) breaks the next
        // session's drawer/profile navigation. Reset each to a clean state at
        // session start — once per account, not per step.
        if (platform == "tiktok" || platform == "x" || platform == "youtube"), app.state != .notRunning {
            app.terminate()
            Thread.sleep(forTimeInterval: 0.8)
        }
        if app.state != .runningForeground { app.launch() }
        if !app.wait(for: .runningForeground, timeout: 12) { app.activate() }
        guard app.wait(for: .runningForeground, timeout: 12) else {
            throw NSError(domain: "HeissRunner", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(platform) did not reach foreground"])
        }

        do {
            try sweepKnownOverlays(app: app, platform: platform)
            try assertNoBlockingOverlay(app: app, platform: platform)
            try ensureAccountVerified(app, platform: platform, handle: handle, command: command)
            guard app.state == .runningForeground else {
                throw NSError(domain: "HeissRunner", code: 17, userInfo: [NSLocalizedDescriptionKey: "\(platform) lost foreground before batched session"])
            }
            let window: XCUIElement
            if platform == "tiktok" || platform == "x" {
                let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
                disableAutomaticInterruptionHandling(springboard)
                window = platform == "tiktok" ? springboard.windows.firstMatch : springboard
            } else {
                window = app.windows.firstMatch
            }
            writeSessionJournal(
                journalURL, sessionId: sessionId, platform: platform, handle: handle,
                commandGeneration: commandGeneration,
                status: "running", completedSteps: completed, plannedSteps: plannedSteps,
                stepDetails: stepDetails, error: nil
            )
            var engagedTargetKeys = Set(stepDetails.compactMap { detail in
                detail.range(of: "target:").map { String(detail[$0.upperBound...]).split(separator: ":").first.map(String.init) ?? "" }
            }.filter { !$0.isEmpty })
            while completed < plannedSteps.count {
                let disrupted = try sweepKnownOverlays(app: app, platform: platform)
                try assertNoBlockingOverlay(app: app, platform: platform)
                guard app.state == .runningForeground else {
                    throw NSError(domain: "HeissRunner", code: 17, userInfo: [NSLocalizedDescriptionKey: "\(platform) lost foreground at step \(completed + 1)"])
                }
                let step = plannedSteps[completed]
                // Re-verify identity only where drift would actually matter: when
                // an overlay sweep relaunched the app, or immediately before a
                // follow (the one engagement that is consequential on the wrong
                // account). Scroll/like/search on the feed stay on the once-per-
                // session verification, avoiding the repetitive checks that
                // otherwise wedge the app and false-flag a flaky switcher read.
                if disrupted || step.contains("follow") {
                    try ensureAccountVerified(app, platform: platform, handle: handle, command: command)
                    guard app.state == .runningForeground else {
                        throw NSError(domain: "HeissRunner", code: 17, userInfo: [NSLocalizedDescriptionKey: "\(platform) lost foreground re-verifying account at step \(completed + 1)"])
                    }
                }
                stepDetails[completed] = try performWarmupStep(
                    step, app: app, window: window, platform: platform,
                    command: command, engagedTargetKeys: &engagedTargetKeys
                )
                completed += 1
                writeSessionJournal(
                    journalURL, sessionId: sessionId, platform: platform, handle: handle,
                    commandGeneration: commandGeneration,
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
                commandGeneration: commandGeneration,
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

    private func performWarmupStep(
        _ action: String,
        app: XCUIApplication,
        window: XCUIElement,
        platform: String,
        command: [String: Any],
        engagedTargetKeys: inout Set<String>
    ) throws -> String {
        if action.contains("scroll") {
            let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.78))
            let end = window.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.28))
            start.press(forDuration: 0.08, thenDragTo: end)
            return "xctest:\(platform):\(action)"
        }
        if action.contains("like") {
            return try performGuardedEngagement(
                action: "like", app: app, window: window, platform: platform,
                command: command, engagedTargetKeys: &engagedTargetKeys
            )
        }
        if action.contains("follow") {
            return try performGuardedEngagement(
                action: "follow", app: app, window: window, platform: platform,
                command: command, engagedTargetKeys: &engagedTargetKeys
            )
        }
        guard action.contains("search") else {
            throw NSError(domain: "HeissRunner", code: 3, userInfo: [NSLocalizedDescriptionKey: "Unsupported batched action \(action)"])
        }

        if platform == "instagram" {
            let explore = app.buttons["explore-tab"]
            if explore.waitForExistence(timeout: 3), explore.isHittable { explore.tap() }
            else { window.coordinate(withNormalizedOffset: point(command, "search", .init(dx: 0.70, dy: 0.95))).tap() }
        } else if platform == "tiktok" {
            window.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: 0.965))).tap()
            Thread.sleep(forTimeInterval: 0.8)
            window.coordinate(withNormalizedOffset: point(command, "search", .init(dx: 0.92, dy: 0.08))).tap()
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
        let terms = command["searchTerms"] as? [String] ?? []
        if platform == "tiktok" {
            guard let term = terms.randomElement() else {
                throw NSError(domain: "HeissRunner", code: 12, userInfo: [NSLocalizedDescriptionKey: "No search term is configured"])
            }
            try performTikTokSearchTyping(surface: window, term: term)
            Thread.sleep(forTimeInterval: 1.2)
            return discoveryDetail(base: "xctest:\(platform):\(action)", platform: platform, actor: command["handle"] as? String ?? "")
        }
        let fields = app.searchFields.count > 0 ? app.searchFields : app.textFields
        guard fields.count > 0, let term = terms.randomElement() else {
            throw NSError(domain: "HeissRunner", code: 12, userInfo: [NSLocalizedDescriptionKey: "Search field was not found after opening platform search"])
        }
        let field = fields.firstMatch
        if field.isHittable { field.tap() }
        else { field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
        guard app.keyboards.firstMatch.waitForExistence(timeout: 3) else {
            throw NSError(domain: "HeissRunner", code: 11, userInfo: [NSLocalizedDescriptionKey: "Search field did not receive keyboard focus"])
        }
        clearSearchFieldIfNeeded(app, surface: window, field: field)
        try typeUsingVisibleKeyboard(app, text: term)
        submitVisibleSearch(app, surface: window, command: command)
        Thread.sleep(forTimeInterval: 1.2)
        return discoveryDetail(base: "xctest:\(platform):\(action)", platform: platform, actor: command["handle"] as? String ?? "")
    }

    /// Search-result observation is deliberately read-only. Failure to extract
    /// candidates never fails the warmup step or triggers a recovery loop.
    private func discoveryDetail(base: String, platform: String, actor: String) -> String {
        do {
            let observations = try recognizedTextObservationsUsingOCR()
            let visible = observations.filter { observation in
                observation.boundingBox.midY >= 0.14 && observation.boundingBox.midY <= 0.90
            }.compactMap { $0.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines) }
            let actorNormalized = normalizedHandle(actor)
            let handles = Array(Set(visible.flatMap { text in
                text.split(whereSeparator: { $0.isWhitespace || ",;()[]{}".contains($0) })
                    .map(String.init)
                    .filter { $0.hasPrefix("@") && $0.count > 1 }
                    .map(normalizedHandle)
                    .filter { !$0.isEmpty && $0 != actorNormalized }
            })).sorted()
            guard !handles.isEmpty else { return base }
            let excerpt = String(visible.joined(separator: " ").prefix(700))
            let payload: [String: Any] = [
                "handles": handles,
                "excerpt": excerpt,
                "screenKey": stableFingerprint("\(platform)|\(excerpt.lowercased())"),
            ]
            let data = try JSONSerialization.data(withJSONObject: payload)
            return "\(base)|discovery:\(data.base64EncodedString())"
        } catch {
            return base
        }
    }

    private func performGuardedEngagement(
        action: String,
        app: XCUIApplication,
        window: XCUIElement,
        platform: String,
        command: [String: Any],
        engagedTargetKeys: inout Set<String>
    ) throws -> String {
        let target = try engagementTarget(platform: platform, actor: command["handle"] as? String ?? "")
        let blocked = Set(command["blockedEngagementTargetKeys"] as? [String] ?? [])
        let owned = Set((command["ownedHandles"] as? [String] ?? []).map(normalizedHandle))
        let actor = normalizedHandle(command["handle"] as? String ?? "")
        if target.handles.contains(where: { owned.contains($0) && $0 != actor }) {
            return "engagement:skipped_owned:\(action):target:\(target.key)"
        }
        if blocked.contains(target.key) || engagedTargetKeys.contains(target.key) {
            return "engagement:skipped_duplicate:\(action):target:\(target.key)"
        }

        if action == "like" {
            let already = app.buttons.matching(NSPredicate(
                format: "label BEGINSWITH[c] %@ OR label BEGINSWITH[c] %@",
                "Unlike", "Liked"
            )).firstMatch
            if already.exists { return "engagement:skipped_already_liked:like:target:\(target.key)" }
            let likes = app.buttons.matching(NSPredicate(
                format: "label ==[c] %@ OR label BEGINSWITH[c] %@",
                "Like", "Like,"
            ))
            let button = likes.allElementsBoundByIndex.first(where: { $0.exists && $0.isHittable })
            if let button { button.tap() }
            else { window.coordinate(withNormalizedOffset: point(command, "like", .init(dx: 0.90, dy: 0.55))).tap() }
        } else {
            let already = app.buttons.matching(NSPredicate(
                format: "label BEGINSWITH[c] %@ OR label BEGINSWITH[c] %@",
                "Following", "Unfollow"
            )).firstMatch
            if already.exists { return "engagement:skipped_already_following:follow:target:\(target.key)" }
            let follows = app.buttons.matching(NSPredicate(
                format: "label ==[c] %@ OR label BEGINSWITH[c] %@",
                "Follow", "Follow "
            ))
            let button = follows.allElementsBoundByIndex.first(where: { $0.exists && $0.isHittable })
            if let button { button.tap() }
            else { window.coordinate(withNormalizedOffset: point(command, "follow", .init(dx: 0.88, dy: 0.43))).tap() }
        }
        engagedTargetKeys.insert(target.key)
        return "engagement:executed:\(action):target:\(target.key)"
    }

    private func engagementTarget(platform: String, actor: String) throws -> (key: String, handles: Set<String>) {
        let observations = try recognizedTextObservationsUsingOCR()
        let visible = observations.filter { observation in
            observation.boundingBox.midY >= 0.16 && observation.boundingBox.midY <= 0.88
        }.compactMap { $0.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines) }
        let handles = Set(visible.flatMap { text in
            text.split(whereSeparator: { $0.isWhitespace || ",;()[]{}".contains($0) })
                .map(String.init)
                .filter { $0.hasPrefix("@") && $0.count > 1 }
                .map(normalizedHandle)
        })
        let actorNormalized = normalizedHandle(actor)
        let candidates = handles.filter { $0 != actorNormalized }
        guard candidates.count == 1, let candidate = candidates.first else {
            throw NSError(domain: "HeissRunner", code: 25, userInfo: [
                NSLocalizedDescriptionKey: "No single unambiguous visible target handle was available; engagement was refused",
                "failureKind": "safety_policy",
            ])
        }
        return (stableFingerprint("\(platform)|\(candidate)"), handles)
    }

    private func normalizedHandle(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased().replacingOccurrences(of: "@", with: "")
    }

    private func stableFingerprint(_ value: String) -> String {
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in value.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 1_099_511_628_211
        }
        return String(hash, radix: 16)
    }

    /// Returns true when a dismissal relaunched the foreground app, so callers
    /// mid-session can re-verify the active account before the next gesture.
    @discardableResult
    private func sweepKnownOverlays(app: XCUIApplication, platform: String) throws -> Bool {
        let systemUI = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        disableAutomaticInterruptionHandling(systemUI)
        // System prompts and passkey sheets are cheap SpringBoard element
        // queries; always sweep them.
        _ = try dismissStaleLimitedPhotosSystemPrompt(
            surface: systemUI.windows.firstMatch,
            app: platform == "tiktok" ? nil : app
        )
        if platform == "instagram" { dismissInstagramSetupPrompt(app) }
        if platform == "tiktok" { dismissTikTokPasskey() }

        // A single OCR pass gates the per-overlay routines that each otherwise
        // take their own screenshot. A clean feed — the common case — pays for
        // one screenshot instead of five. Markers are a superset of every
        // gated dismissal's own trigger, so nothing is skipped when present.
        let observations = try recognizedTextObservationsUsingOCR()
        let overlayMarkers = [
            "Would Like to Access", "Add to Story", "To access all photos", "change your settings",
            "Choose your interests", "Find contacts", "Sync contacts", "Swipe up",
            "Default Account", "Save your login",
        ]
        let systemKeepVisible = systemUI.buttons.matching(
            NSPredicate(format: "label ==[c] %@", "Keep Current Selection")
        ).firstMatch.exists
        guard systemKeepVisible || overlayMarkers.contains(where: { observationContains(observations, $0) }) else {
            return false
        }

        var relaunched = false
        if platform == "tiktok" {
            let surface = systemUI.windows.firstMatch
            relaunched = try dismissTikTokPhotoStoryPrompt(app: app, surface: surface) || relaunched
            try dismissTikTokInterestsPrompt(surface: surface)
            try dismissTikTokContactsPrompt(surface: surface)
            try dismissTikTokSwipeTutorial(surface: surface)
        }
        if platform == "youtube" { try dismissYouTubeDefaultAccountPrompt(app) }
        return relaunched
    }

    /// Membership test against an already-captured OCR pass — avoids taking a
    /// fresh screenshot per term.
    private func observationContains(
        _ observations: [VNRecognizedTextObservation],
        _ expected: String,
        minimumVisionY: CGFloat = 0,
        maximumVisionY: CGFloat = 1
    ) -> Bool {
        observations.contains { observation in
            observation.boundingBox.midY >= minimumVisionY &&
            observation.boundingBox.midY <= maximumVisionY && observation.topCandidates(3).contains {
                $0.string.range(of: expected, options: [.caseInsensitive, .diacriticInsensitive]) != nil
            }
        }
    }

    private func detectPlatformState(
        app: XCUIApplication,
        platform: String,
        observations: [VNRecognizedTextObservation]? = nil
    ) throws -> PlatformScreenState {
        // One OCR pass classifies the whole screen; callers may pass a shared
        // capture to avoid a second screenshot in the same step.
        let obs = try observations ?? recognizedTextObservationsUsingOCR()
        let onboardingTerms = ["Choose your interests", "Sync contacts", "Swipe up", "Default Account", "Save your login"]
        if onboardingTerms.contains(where: { observationContains(obs, $0) }) { return .onboardingOverlay }
        if platform != "tiktok", app.keyboards.firstMatch.exists { return .search }
        if observationContains(obs, "Search", minimumVisionY: 0.72, maximumVisionY: 0.96) { return .search }
        let switcherTerms = ["Add Instagram account", "Manage accounts", "Switch account", "Add account"]
        if switcherTerms.contains(where: { observationContains(obs, $0) }) { return .accountSwitcher }
        if observationContains(obs, "Profile", minimumVisionY: 0.55, maximumVisionY: 0.95) { return .profile }
        if observationContains(obs, "Home", maximumVisionY: 0.30) { return .home }
        return .unknown
    }

    private func assertNoBlockingOverlay(app: XCUIApplication, platform: String) throws {
        let observations = try recognizedTextObservationsUsingOCR()
        if try detectPlatformState(app: app, platform: platform, observations: observations) == .onboardingOverlay {
            throw NSError(domain: "HeissRunner", code: 24, userInfo: [
                NSLocalizedDescriptionKey: "Onboarding overlay remains after bounded cleanup",
                "failureKind": "unknown_ui",
            ])
        }
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        disableAutomaticInterruptionHandling(springboard)
        // TikTok's animated tree can wedge app.alerts, so its own consent/
        // permission sheets are detected from the shared OCR pass instead of
        // being waved through unconditionally.
        let tiktokModalMarkers = ["Allow Access", "Don't Allow", "Allow While Using", "Turn On Notifications"]
        let appAlertVisible = platform == "tiktok"
            ? tiktokModalMarkers.contains(where: { observationContains(observations, $0) })
            : app.alerts.count > 0
        if appAlertVisible || springboard.alerts.count > 0 {
            throw NSError(domain: "HeissRunner", code: 24, userInfo: [
                NSLocalizedDescriptionKey: "Unexpected popup or permission alert is blocking \(platform)",
                "failureKind": "unknown_ui",
            ])
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
        commandGeneration: String,
        status: String,
        completedSteps: Int,
        plannedSteps: [String],
        stepDetails: [String],
        error: String?
    ) {
        var journal: [String: Any] = [
            "sessionId": sessionId, "platform": platform, "handle": handle,
            "commandGeneration": commandGeneration,
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
        // An explicit classification on the thrown NSError always wins.
        if let explicit = (error as NSError).userInfo["failureKind"] as? String { return explicit }
        let text = error.localizedDescription.lowercased()
        if (text.contains("account") || text.contains("handle") || text.contains("row"))
            && (text.contains("not found") || text.contains("verify") || text.contains("exact handle") || text.contains("switch")) {
            return "account_mismatch"
        }
        if text.contains("popup") || text.contains("alert") || text.contains("blocking") || text.contains("overlay") {
            return "unknown_ui"
        }
        if text.contains("prompt") || text.contains("onboarding") || text.contains("tutorial")
            || text.contains("interests") || text.contains("contacts") {
            return "unknown_ui"
        }
        if text.contains("foreground") || text.contains("navigation") || text.contains("search field")
            || text.contains("keyboard") || text.contains("did not finish loading") || text.contains("toolbar") {
            return "app_navigation"
        }
        return "action"
    }

    private func documents() -> URL {
        fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    /// Clear any existing text before typing so an unsubmitted term from a
    /// prior search step is not appended (which reads as the term "typed
    /// twice"). Non-destructive when the field is empty or shows a placeholder.
    private func clearSearchFieldIfNeeded(_ app: XCUIApplication, surface: XCUIElement, field: XCUIElement) {
        let value = (field.value as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = value.lowercased()
        guard !value.isEmpty, !lower.contains("search"), !lower.contains("find") else { return }
        let clear = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Clear")).firstMatch
        if clear.waitForExistence(timeout: 1), clear.isHittable { clear.tap() }
        else { surface.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.063)).tap() }
        Thread.sleep(forTimeInterval: 0.3)
    }

    /// Submit a typed search. Prefers the labeled Return/Search/Go key, but
    /// falls back to the bottom-right keyboard corner where iOS always places
    /// it — without this the term is typed but the search never executes.
    /// Confirms the keyboard dismissed; one bounded corner retry otherwise.
    private func submitVisibleSearch(_ app: XCUIApplication, surface: XCUIElement, command: [String: Any]) {
        let submit = app.keys.matching(
            NSPredicate(format: "label ==[c] %@ OR label ==[c] %@ OR label ==[c] %@ OR label ==[c] %@", "Search", "Return", "Go", "Enter")
        ).firstMatch
        if submit.waitForExistence(timeout: 2), submit.isHittable {
            submit.tap()
        } else {
            surface.coordinate(withNormalizedOffset: point(command, "searchSubmit", .init(dx: 0.92, dy: 0.965))).tap()
        }
        Thread.sleep(forTimeInterval: 0.7)
        // If the keyboard is still up, the submit missed — retry the corner once.
        if app.keyboards.firstMatch.exists {
            surface.coordinate(withNormalizedOffset: point(command, "searchSubmit", .init(dx: 0.92, dy: 0.965))).tap()
            Thread.sleep(forTimeInterval: 0.5)
        }
    }

    private func typeUsingVisibleKeyboard(_ app: XCUIApplication, text: String) throws {
        // A plus sign is a natural way to configure topics such as "11+ exam",
        // but third-party search keyboards expose it behind inconsistent
        // second-layer labels. The word is semantically identical and keeps
        // input deterministic across app versions.
        let keyboardSafeText = text.replacingOccurrences(of: "+", with: " plus ")
            .split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        for character in keyboardSafeText.lowercased() {
            let label = character == " " ? "space" : String(character)
            var key = app.keys[label]
            if !key.exists || !key.isHittable {
                if character.isNumber {
                    _ = tapKeyboardMode(app, labels: ["numbers", "123", "more"])
                } else if character == "+" {
                    _ = tapKeyboardMode(app, labels: ["numbers", "123", "more"])
                    key = app.keys[label]
                    if !key.waitForExistence(timeout: 0.5) {
                        _ = tapKeyboardMode(app, labels: ["symbols", "#+=", "more"])
                    }
                } else if character.isLetter {
                    _ = tapKeyboardMode(app, labels: ["letters", "abc"])
                }
                key = app.keys[label]
            }
            guard key.waitForExistence(timeout: 2), key.isHittable else {
                throw NSError(domain: "HeissRunner", code: 13, userInfo: [NSLocalizedDescriptionKey: "Keyboard key \(label) was not available"])
            }
            key.tap()
            Thread.sleep(forTimeInterval: Double.random(in: 0.06...0.16))
        }
    }

    private func tapKeyboardMode(_ app: XCUIApplication, labels: [String]) -> Bool {
        let candidates = app.keys.allElementsBoundByIndex
        guard let key = candidates.first(where: { element in
            labels.contains(where: { label in
                element.label.range(of: label, options: [.caseInsensitive, .diacriticInsensitive]) != nil
            }) && element.isHittable
        }) else { return false }
        key.tap()
        Thread.sleep(forTimeInterval: 0.25)
        return true
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
        // TikTok's coordinate keyboard exposes only the letter plane, so match
        // the visible-keyboard path: spell out a plus, and skip any remaining
        // digit/punctuation rather than aborting the whole search. A warmup
        // search does not need exact numerals, and throwing here previously sent
        // any digit-bearing term (e.g. "11+ exam") into an endless retry loop.
        let normalized = text.lowercased().replacingOccurrences(of: "+", with: " plus ")
        for character in normalized {
            guard let key = keys[character] else { continue }
            surface.coordinate(withNormalizedOffset: key).tap()
            Thread.sleep(forTimeInterval: Double.random(in: 0.06...0.16))
        }
    }

    private func performTikTokSearchTyping(surface: XCUIElement, term: String) throws {
        // Search is open at this point. Focus its stable header field, clear
        // any retained query, and type entirely through SpringBoard-delivered
        // keyboard coordinates so TikTok's accessibility tree is never read.
        surface.coordinate(withNormalizedOffset: CGVector(dx: 0.42, dy: 0.06)).tap()
        Thread.sleep(forTimeInterval: 0.8)
        surface.coordinate(withNormalizedOffset: CGVector(dx: 0.94, dy: 0.88)).press(forDuration: 1.2)
        try typeUsingKeyboardCoordinates(surface, text: term)
        surface.coordinate(withNormalizedOffset: CGVector(dx: 0.87, dy: 0.96)).tap()
    }

    private func openTikTokProfile(surface: XCUIElement) throws {
        // Use the center of the rendered Profile icon, above the compact
        // device's bottom safe-area label. A short press is more reliable than
        // a label-edge tap while TikTok's feed player is animating.
        surface.coordinate(withNormalizedOffset: CGVector(dx: 0.90, dy: 0.95)).press(forDuration: 0.08)
        Thread.sleep(forTimeInterval: 2.0)
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

    @discardableResult
    private func dismissStaleLimitedPhotosSystemPrompt(
        surface: XCUIElement,
        app: XCUIApplication? = nil,
        appearanceTimeout: TimeInterval = 0
    ) throws -> Bool {
        let predicate = NSPredicate(format: "label ==[c] %@", "Keep Current Selection")
        let keep = surface.buttons.matching(predicate).firstMatch
        let appKeep = app?.buttons.matching(predicate).firstMatch
        let appAccessible = appearanceTimeout > 0
            ? (appKeep?.waitForExistence(timeout: appearanceTimeout) ?? false)
            : (appKeep?.exists ?? false)
        let systemAccessible = appearanceTimeout > 0 && !appAccessible
            ? keep.waitForExistence(timeout: appearanceTimeout)
            : keep.exists
        let rendered = (appAccessible || systemAccessible) ? true
            : try (screenContainsTextUsingOCR("Would Like to Access Your Photos") || screenContainsTextUsingOCR("Keep Current Selection"))
        guard appAccessible || systemAccessible || rendered else { return false }
        if let appKeep, appKeep.exists, appKeep.isHittable { appKeep.tap() }
        else if keep.waitForExistence(timeout: 1), keep.isHittable { keep.tap() }
        else { surface.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.643)).tap() }
        Thread.sleep(forTimeInterval: 0.8)
        return true
    }

    @discardableResult
    private func recoverLateLimitedPhotosPrompt(
        app: XCUIApplication,
        surface: XCUIElement,
        platform: String
    ) throws -> Bool {
        guard try dismissStaleLimitedPhotosSystemPrompt(
            surface: surface,
            app: platform == "tiktok" ? nil : app
        ) else { return false }
        if platform == "tiktok" {
            try dismissTikTokPhotoStoryPrompt(app: app, surface: surface)
            try openTikTokProfile(surface: surface)
        } else if app.state != .runningForeground {
            app.activate()
            guard app.wait(for: .runningForeground, timeout: 8) else {
                throw NSError(domain: "HeissRunner", code: 17, userInfo: [NSLocalizedDescriptionKey: "\(platform) did not recover after clearing a late Photos prompt"])
            }
        }
        Thread.sleep(forTimeInterval: 0.8)
        return true
    }

    /// Returns true when it relaunched TikTok, so the caller can re-verify the
    /// active account before performing the next engagement gesture.
    @discardableResult
    private func dismissTikTokPhotoStoryPrompt(app: XCUIApplication, surface: XCUIElement) throws -> Bool {
        let keepPredicate = NSPredicate(format: "label ==[c] %@", "Keep Current Selection")
        let systemKeep = surface.buttons.matching(keepPredicate).firstMatch
        let photoPromptRendered = try screenContainsTextUsingOCR("Would Like to Access Your Photos")
        // Never query TikTok's own accessibility tree here. Its animated
        // Story surface can make a single `exists` lookup block for a minute.
        // System alerts remain visible through SpringBoard; app-owned state is
        // guarded exclusively by OCR below.
        let photoPromptVisible = systemKeep.exists || photoPromptRendered
        if photoPromptVisible {
            if systemKeep.waitForExistence(timeout: 1), systemKeep.isHittable { systemKeep.tap() }
            else { surface.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.643)).tap() }
            Thread.sleep(forTimeInterval: 0.8)
        }

        let limitationBanner = try screenContainsTextUsingOCR("To access all photos")
            || screenContainsTextUsingOCR("change your settings")
        if limitationBanner {
            // This app-owned banner overlays the bottom tabs; dismiss its own
            // top-right glyph before attempting Profile/Home navigation.
            surface.coordinate(withNormalizedOffset: CGVector(dx: 0.904, dy: 0.847)).tap()
            Thread.sleep(forTimeInterval: 0.6)
        }

        var storyRendered = try screenContainsTextUsingOCR("Add to Story")
        guard photoPromptVisible || storyRendered else { return false }
        // The Photos-limitation banner also has a close glyph, so a generic
        // Close query is ambiguous here. The guarded top-left target belongs
        // specifically to the Story composer and cancels without publishing.
        for _ in 0..<3 where storyRendered {
            surface.coordinate(withNormalizedOffset: CGVector(dx: 0.073, dy: 0.063)).press(forDuration: 0.08)
            Thread.sleep(forTimeInterval: 2.0)
            storyRendered = try screenContainsTextUsingOCR("Add to Story")
        }
        if storyRendered {
            throw NSError(domain: "HeissRunner", code: 24, userInfo: [NSLocalizedDescriptionKey: "TikTok Add to Story could not be cancelled after retaining current Photos access"])
        }
        // TikTok can leave a black, foreground-but-noninteractive transition
        // after dismissing Story. Relaunch to the known Home state before
        // account verification; launch arguments already disable restoration.
        app.terminate()
        Thread.sleep(forTimeInterval: 0.8)
        app.launch()
        guard app.wait(for: .runningForeground, timeout: 12) else {
            throw NSError(domain: "HeissRunner", code: 17, userInfo: [NSLocalizedDescriptionKey: "TikTok did not return to foreground after Story cancellation"])
        }
        // State restoration can present the limited-Photos sheet several
        // seconds after the app reports foreground. Drive the rendered state
        // machine until Home is actually visible; never let a transient black
        // screen fall through to account-mismatch handling.
        let returnedSystemKeep = surface.buttons.matching(keepPredicate).firstMatch
        let homeEligibleAt = Date().addingTimeInterval(20)
        let settleDeadline = Date().addingTimeInterval(35)
        while Date() < settleDeadline {
            let returnedPromptRendered = try screenContainsTextUsingOCR("Would Like to Access Your Photos")
            if returnedSystemKeep.exists || returnedPromptRendered {
                if returnedSystemKeep.exists, returnedSystemKeep.isHittable { returnedSystemKeep.tap() }
                else { surface.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.643)).tap() }
                Thread.sleep(forTimeInterval: 1.0)
                continue
            }
            let returnedLimitation = try screenContainsTextUsingOCR("To access all photos")
                || screenContainsTextUsingOCR("change your settings")
            if returnedLimitation {
                surface.coordinate(withNormalizedOffset: CGVector(dx: 0.904, dy: 0.847)).tap()
                Thread.sleep(forTimeInterval: 0.8)
                continue
            }
            if try screenContainsTextUsingOCR("Add to Story") {
                surface.coordinate(withNormalizedOffset: CGVector(dx: 0.073, dy: 0.063)).press(forDuration: 0.08)
                Thread.sleep(forTimeInterval: 2.0)
                continue
            }
            let homeRendered = try screenContainsTextUsingOCR("For You", minimumVisionY: 0.82)
                || screenContainsTextUsingOCR("Following", minimumVisionY: 0.82)
            if homeRendered, Date() >= homeEligibleAt {
                surface.coordinate(withNormalizedOffset: CGVector(dx: 0.10, dy: 0.95)).tap()
                Thread.sleep(forTimeInterval: 1.0)
                return true
            }
            Thread.sleep(forTimeInterval: 0.75)
        }
        throw NSError(domain: "HeissRunner", code: 24, userInfo: [NSLocalizedDescriptionKey: "TikTok did not settle on Home after bounded Story cleanup"])
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
            // The rendered tutorial copy is a sufficient guard. Do not query
            // TikTok's animated accessibility hierarchy: that can block for
            // roughly a minute even when the tutorial is absent.
            if !(try screenContainsTextUsingOCR("Swipe up")) { return }
            let start = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.82))
            let end = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.10))
            start.press(forDuration: 0.08, thenDragTo: end)
            Thread.sleep(forTimeInterval: 1.0)
        }
        if try screenContainsTextUsingOCR("Swipe up") {
            throw NSError(domain: "HeissRunner", code: 18, userInfo: [NSLocalizedDescriptionKey: "TikTok swipe tutorial did not dismiss after three gestures"])
        }
    }

    /// Verify the active account, self-remediating first. When verification
    /// fails on an identity/UI mismatch, mimic the manual post-onboarding
    /// cleanup — return toward Home, clear overlays, and scroll the feed a few
    /// times — then retry, up to three attempts. Only a persistent failure
    /// escalates to the human attention queue. Transport/navigation errors are
    /// not remediated here; they retry through their own recovery paths.
    private func ensureAccountVerified(_ app: XCUIApplication, platform: String, handle: String, command: [String: Any]) throws {
        guard !handle.isEmpty else { return }
        var lastError: Error?
        for attempt in 0..<3 {
            do {
                try ensureAccount(app, platform: platform, handle: handle, command: command)
                return
            } catch {
                lastError = error
                let kind = failureKind(error)
                guard (kind == "account_mismatch" || kind == "unknown_ui"), attempt < 2 else { throw error }
                try remediateBeforeReverify(app: app, platform: platform, command: command)
            }
        }
        throw lastError ?? NSError(domain: "HeissRunner", code: 15, userInfo: [
            NSLocalizedDescriptionKey: "Account \(handle) could not be verified on \(platform) after remediation",
            "failureKind": "account_mismatch",
        ])
    }

    private func remediateBeforeReverify(app: XCUIApplication, platform: String, command: [String: Any]) throws {
        let surface: XCUIElement
        if platform == "tiktok" || platform == "x" {
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            disableAutomaticInterruptionHandling(springboard)
            surface = platform == "tiktok" ? springboard.windows.firstMatch : springboard
        } else {
            surface = app.windows.firstMatch
        }
        if app.state != .runningForeground {
            app.activate()
            _ = app.wait(for: .runningForeground, timeout: 8)
        }
        // Return toward Home so the next verification starts from a known state
        // instead of a lingering search-results or profile surface.
        let homeDy: CGFloat = platform == "youtube" ? 0.965 : 0.95
        surface.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: homeDy))).tap()
        Thread.sleep(forTimeInterval: 0.8)
        try? sweepKnownOverlays(app: app, platform: platform)
        // Harmless feed scrolls settle first-run pop-ups the same way a manual
        // pass would, then a final overlay sweep clears whatever they surfaced.
        for _ in 0..<2 {
            surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.72))
                .press(forDuration: 0.08, thenDragTo: surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.32)))
            Thread.sleep(forTimeInterval: 0.6)
        }
        try? sweepKnownOverlays(app: app, platform: platform)
        surface.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: homeDy))).tap()
        Thread.sleep(forTimeInterval: 0.8)
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
            window = platform == "tiktok" ? springboard.windows.firstMatch : springboard
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
        else if platform == "tiktok" { try openTikTokProfile(surface: window) }
        else {
            let fallback = platform == "x"
                ? CGVector(dx: 0.08, dy: 0.08)
                : CGVector(dx: 0.91, dy: 0.95)
            window.coordinate(withNormalizedOffset: point(command, "profile", fallback)).tap()
        }
        Thread.sleep(forTimeInterval: 1.0)
        _ = try recoverLateLimitedPhotosPrompt(app: app, surface: window, platform: platform)
        if platform == "instagram" { dismissInstagramSetupPrompt(app) }
        if platform == "tiktok", app.state != .runningForeground {
            app.activate()
            guard app.wait(for: .runningForeground, timeout: 8) else {
                throw NSError(domain: "HeissRunner", code: 17, userInfo: [NSLocalizedDescriptionKey: "TikTok lost foreground during account verification"])
            }
            try openTikTokProfile(surface: window)
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
        _ = try recoverLateLimitedPhotosPrompt(app: app, surface: window, platform: platform)
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
                try openTikTokProfile(surface: window)
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
        _ = try recoverLateLimitedPhotosPrompt(app: app, surface: window, platform: platform)
        if platform == "tiktok" {
            // Compact TikTok puts the chevron beside the display name. The
            // handle one row below copies the username instead of opening the
            // switcher, so keep this fallback centered on the chevron itself.
            window.coordinate(withNormalizedOffset: point(command, "accountMenu", .init(dx: 0.58, dy: 0.267))).tap()
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
        _ = try recoverLateLimitedPhotosPrompt(app: app, surface: window, platform: platform)
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
        _ = try recoverLateLimitedPhotosPrompt(app: app, surface: surface, platform: "youtube")
        surface.coordinate(withNormalizedOffset: point(command, "profile", .init(dx: 0.91, dy: 0.95))).tap()
        Thread.sleep(forTimeInterval: 1.0)
        _ = try recoverLateLimitedPhotosPrompt(app: app, surface: surface, platform: "youtube")
        try dismissYouTubeDefaultAccountPrompt(app)
        try dismissYouTubeManageAccounts(app)
        try dismissYouTubeAccountSwitcher(app)
        surface.coordinate(withNormalizedOffset: point(command, "profile", .init(dx: 0.91, dy: 0.95))).tap()
        Thread.sleep(forTimeInterval: 1.2)
        if try waitForExactHandleUsingOCR(normalized: normalized, timeout: 3, minimumVisionY: 0.50, maximumVisionY: 0.94) {
            activeHandles["youtube"] = handle
            surface.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: 0.95))).tap()
            return
        }

        var switcherReady = try openYouTubeAccountSwitcher(
            app: app, surface: surface, command: command, timeout: 12
        )
        if !switcherReady {
            // A reboot helping this screen is evidence that YouTube can retain
            // a blank account surface. Bound recovery to one app relaunch,
            // then require the switcher to render before identity scanning.
            app.terminate()
            Thread.sleep(forTimeInterval: 0.8)
            app.launch()
            guard app.wait(for: .runningForeground, timeout: 12) else {
                throw NSError(domain: "HeissRunner", code: 17, userInfo: [NSLocalizedDescriptionKey: "YouTube did not return to foreground while recovering its account switcher"])
            }
            _ = try recoverLateLimitedPhotosPrompt(app: app, surface: surface, platform: "youtube")
            surface.coordinate(withNormalizedOffset: point(command, "profile", .init(dx: 0.91, dy: 0.95))).tap()
            Thread.sleep(forTimeInterval: 1.5)
            switcherReady = try openYouTubeAccountSwitcher(
                app: app, surface: surface, command: command, timeout: 12
            )
        }
        guard switcherReady else {
            throw NSError(domain: "HeissRunner", code: 21, userInfo: [NSLocalizedDescriptionKey: "YouTube account switcher did not finish loading after bounded relaunch recovery"])
        }

        var selection = try selectYouTubeAccount(
            surface: surface,
            normalized: normalized,
            hints: accountPickerHints(command),
            maxViewports: 3
        )
        if !selection.selected,
           try screenContainsTextUsingOCR("Use YouTube signed out"),
           try tapTextUsingOCR(surface: surface, expected: "Use YouTube signed out") {
            // On compact iPhones, YouTube's expanded six-action footer can
            // permanently cover the final account rows at the scroll limit.
            // Signed-out mode collapses that footer to two harmless actions;
            // reopen the switcher and make the real, verified selection.
            Thread.sleep(forTimeInterval: 1.2)
            let reopened = try openYouTubeAccountSwitcher(
                app: app, surface: surface, command: command, timeout: 8
            )
            if reopened {
                let retry = try selectYouTubeAccount(
                    surface: surface,
                    normalized: normalized,
                    hints: accountPickerHints(command),
                    maxViewports: 4
                )
                selection = (
                    selected: retry.selected,
                    inspected: selection.inspected + ["signed-out footer reset"] + retry.inspected
                )
            }
        }
        let selected = selection.selected
        guard selected else {
            let inspected = selection.inspected.enumerated()
                .map { "view\($0.offset + 1): \($0.element)" }
                .joined(separator: "; ")
            throw NSError(domain: "HeissRunner", code: 5, userInfo: [NSLocalizedDescriptionKey: "Account \(handle) was not found after scrolling the youtube switcher. OCR: \(inspected)"])
        }
        Thread.sleep(forTimeInterval: 1.8)
        // YouTube sometimes leaves the sheet open after selecting the already-
        // active channel. Close it explicitly; exact verification below still
        // decides whether the selection was safe and correct.
        try dismissYouTubeAccountSwitcher(app)

        // Offscreen Google-identity changes can leave YouTube on a black
        // channel-loading skeleton for several seconds. Give the selected
        // channel time to render before issuing another navigation tap.
        var verified = try waitForExactHandleUsingOCR(
            normalized: normalized, timeout: 12, minimumVisionY: 0.50, maximumVisionY: 0.94
        )
        if !verified {
            // A relaunch preserves the chosen account but clears YouTube's
            // wedged transition surface. Bound this recovery to one attempt.
            app.terminate()
            Thread.sleep(forTimeInterval: 0.8)
            app.launch()
            guard app.wait(for: .runningForeground, timeout: 12) else {
                throw NSError(domain: "HeissRunner", code: 17, userInfo: [NSLocalizedDescriptionKey: "YouTube did not return after account-transition recovery"])
            }
        }
        surface.coordinate(withNormalizedOffset: point(command, "profile", .init(dx: 0.91, dy: 0.95))).tap()
        Thread.sleep(forTimeInterval: 1.5)
        if !verified {
            verified = try waitForExactHandleUsingOCR(
                normalized: normalized, timeout: 8, minimumVisionY: 0.50, maximumVisionY: 0.94
            )
        }
        if !verified {
            let channel = app.descendants(matching: .any).matching(
                NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "View channel", "Your channel")
            ).firstMatch
            if channel.waitForExistence(timeout: 2), channel.isHittable {
                channel.tap()
                Thread.sleep(forTimeInterval: 1.5)
                verified = try waitForExactHandleUsingOCR(
                    normalized: normalized, timeout: 8, minimumVisionY: 0.50, maximumVisionY: 0.94
                )
            }
        }
        guard verified else {
            let inspected = selection.inspected.enumerated()
                .map { "view\($0.offset + 1): \($0.element)" }
                .joined(separator: "; ")
            throw NSError(domain: "HeissRunner", code: 15, userInfo: [NSLocalizedDescriptionKey: "YouTube selected a row but did not verify exact handle \(handle). OCR switcher views: \(inspected)"])
        }
        activeHandles["youtube"] = handle
        surface.coordinate(withNormalizedOffset: point(command, "home", .init(dx: 0.10, dy: 0.95))).tap()
    }

    private func openYouTubeAccountSwitcher(
        app: XCUIApplication,
        surface: XCUIElement,
        command: [String: Any],
        timeout: TimeInterval
    ) throws -> Bool {
        let switchAccount = app.descendants(matching: .any).matching(
            NSPredicate(
                format: "label ==[c] %@ OR label CONTAINS[c] %@ OR identifier CONTAINS[c] %@",
                "Accounts", "Switch account", "switch-account"
            )
        ).firstMatch
        if switchAccount.waitForExistence(timeout: 2), switchAccount.isHittable {
            switchAccount.tap()
        } else {
            surface.coordinate(withNormalizedOffset: point(command, "accountMenu", .init(dx: 0.30, dy: 0.12))).tap()
        }
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if try screenContainsTextUsingOCR("Other accounts")
                || screenContainsTextUsingOCR("Manage accounts on this device") {
                return true
            }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < deadline
        return false
    }

    private func selectYouTubeAccount(
        surface: XCUIElement,
        normalized: String,
        hints: [String],
        maxViewports: Int
    ) throws -> (selected: Bool, inspected: [String]) {
        var inspected: [String] = []
        for viewport in 0..<maxViewports {
            let observations = try recognizedTextObservationsUsingOCR()
            inspected.append(observations.compactMap { $0.topCandidates(1).first?.string }
                .prefix(12).joined(separator: " | "))
            let eligible = observations.filter {
                let screenY = 1.0 - $0.boundingBox.midY
                return screenY >= 0.12 && screenY <= 0.82
            }
            if let exact = eligible.first(where: { observation in
                observation.topCandidates(3).contains {
                    textContainsExactHandle($0.string, normalized: normalized)
                }
            }) {
                let box = exact.boundingBox
                surface.coordinate(withNormalizedOffset: CGVector(dx: box.midX, dy: 1.0 - box.midY)).tap()
                return (true, inspected)
            }
            for hint in hints {
                if let match = eligible.first(where: { observation in
                    observation.topCandidates(3).contains {
                        $0.string.range(of: hint, options: [.caseInsensitive, .diacriticInsensitive]) != nil
                    }
                }) {
                    let box = match.boundingBox
                    surface.coordinate(withNormalizedOffset: CGVector(dx: box.midX, dy: 1.0 - box.midY)).tap()
                    return (true, inspected)
                }
            }
            if viewport < maxViewports - 1 {
                // Keep both endpoints inside the scrollable account rows and
                // above YouTube's fixed action menu at the bottom.
                // After the first viewport, start higher so the last visible
                // account row cannot absorb every subsequent drag.
                let startY: CGFloat = viewport == 0 ? 0.57 : 0.45
                let start = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: startY))
                let end = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.15))
                start.press(forDuration: 0.10, thenDragTo: end)
                Thread.sleep(forTimeInterval: 1.0)
            }
        }
        return (false, inspected)
    }

    private func dismissYouTubeAccountSwitcher(_ app: XCUIApplication) throws {
        // "Other accounts" scrolls offscreen with the account rows, while the
        // action menu is fixed. Key dismissal to its unique persistent label
        // so a successful offscreen account selection cannot leave the sheet
        // open and turn the following profile tap into "Manage accounts".
        let switcherVisible = try screenContainsTextUsingOCR("Manage accounts on this device")
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
        while Date() < deadline, try screenContainsTextUsingOCR("Manage accounts on this device") {
            Thread.sleep(forTimeInterval: 0.4)
        }
        if try screenContainsTextUsingOCR("Manage accounts on this device") {
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
        // A login such as "arete11plus@gmail.com" is identity metadata, not
        // proof of the public @arete11plus channel. Never let an email's local
        // part satisfy exact public-handle matching.
        let pattern = "(^|[^a-z0-9._])@?\(escaped)(?!@)($|[^a-z0-9._])"
        return raw.lowercased().range(of: pattern, options: .regularExpression) != nil
    }

    private func tapExactHandleUsingOCR(
        surface: XCUIElement,
        normalized: String,
        minimumScreenY: CGFloat = 0.05,
        maximumScreenY: CGFloat = 0.92
    ) throws -> Bool {
        // Account rows live between the status bar and bottom navigation.
        // Cropping prevents a matching handle in the underlying feed from
        // being mistaken for the switcher row.
        guard let match = try recognizedHandleObservation(
            normalized: normalized,
            minimumVisionY: 1.0 - maximumScreenY,
            maximumVisionY: 1.0 - minimumScreenY
        ) else { return false }
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
            _ = try dismissStaleLimitedPhotosSystemPrompt(surface: surface, appearanceTimeout: 1)
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

    private func tapTextUsingOCR(
        surface: XCUIElement,
        expected: String,
        minimumScreenY: CGFloat = 0,
        maximumScreenY: CGFloat = 1
    ) throws -> Bool {
        guard let image = UIImage(data: XCUIScreen.main.screenshot().pngRepresentation)?.cgImage else { return false }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
        guard let observation = (request.results ?? []).first(where: { observation in
            let screenY = 1.0 - observation.boundingBox.midY
            return screenY >= minimumScreenY && screenY <= maximumScreenY
                && observation.topCandidates(3).contains {
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

    private func recognizedTextObservationsUsingOCR() throws -> [VNRecognizedTextObservation] {
        guard let image = UIImage(data: XCUIScreen.main.screenshot().pngRepresentation)?.cgImage else { return [] }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
        return request.results ?? []
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
