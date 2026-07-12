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
                Text("Keep this app open while the Mac farm runs.\nUSB control via Documents inbox.")
                    .font(.caption)
                    .multilineTextAlignment(.center)
                    .padding()
            }
            .padding()
            .onAppear { server.start() }
        }
    }
}
