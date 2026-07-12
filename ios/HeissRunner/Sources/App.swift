import SwiftUI

@main
struct HeissRunnerApp: App {
    @StateObject private var server = ControlServer.shared
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 16) {
                Text("Heiss Runner")
                    .font(.largeTitle.bold())
                Text(server.statusText)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Text("The Mac launches the signed XCTest automation runner.\nYou can leave this app after trusting the developer certificate.")
                    .font(.caption)
                    .multilineTextAlignment(.center)
                    .padding()
            }
            .padding()
            .onAppear { server.start() }
        }
    }
}
