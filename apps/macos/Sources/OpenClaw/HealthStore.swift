import Foundation
import Network
import Observation
import SwiftUI

struct HealthSnapshot: Codable, Sendable {
    struct ChannelSummary: Codable, Sendable {
        struct Probe: Codable, Sendable {
            struct Bot: Codable, Sendable {
                let username: String?
            }

            struct Webhook: Codable, Sendable {
                let url: String?
            }

            let ok: Bool?
            let status: Int?
            let error: String?
            let elapsedMs: Double?
            let bot: Bot?
            let webhook: Webhook?
        }

        let configured: Bool?
        let linked: Bool?
        let authAgeMs: Double?
        let probe: Probe?
        let lastProbeAt: Double?
    }

    struct SessionInfo: Codable, Sendable {
        let key: String
        let updatedAt: Double?
        let age: Double?
    }

    struct Sessions: Codable, Sendable {
        let path: String
        let count: Int
        let recent: [SessionInfo]
    }

    let ok: Bool?
    let ts: Double
    let durationMs: Double
    let channels: [String: ChannelSummary]
    let channelOrder: [String]?
    let channelLabels: [String: String]?
    let heartbeatSeconds: Int?
    let sessions: Sessions
}

enum HealthState: Equatable {
    case unknown
    case ok
    case linkingNeeded
    case degraded(String)

    var tint: Color {
        switch self {
        case .ok: .green
        case .linkingNeeded: .red
        case .degraded: .orange
        case .unknown: .secondary
        }
    }
}

@MainActor
@Observable
final class HealthStore {
    static let shared = HealthStore()

    private static let logger = Logger(subsystem: "ai.openclaw", category: "health")

    private(set) var snapshot: HealthSnapshot?
    private(set) var lastSuccess: Date?
    private(set) var lastError: String?
    private(set) var isRefreshing = false

    private var loopTask: Task<Void, Never>?
    private let refreshInterval: TimeInterval = 60

    private init() {
        // Avoid background health polling in SwiftUI previews and tests.
        if !ProcessInfo.processInfo.isPreview, !ProcessInfo.processInfo.isRunningTests {
            self.start()
        }
    }

    /// Test-only escape hatch: the HealthStore is a process-wide singleton but
    /// state derivation is pure from `snapshot` + `lastError`.
    func __setSnapshotForTest(_ snapshot: HealthSnapshot?, lastError: String? = nil) {
        self.snapshot = snapshot
        self.lastError = lastError
    }

    func start() {
        guard self.loopTask == nil else { return }
        self.loopTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                await self.refresh()
                try? await Task.sleep(nanoseconds: UInt64(self.refreshInterval * 1_000_000_000))
            }
        }
    }

    func stop() {
        self.loopTask?.cancel()
        self.loopTask = nil
    }

    func refresh(onDemand: Bool = false) async {
        guard !self.isRefreshing else { return }
        self.isRefreshing = true
        defer { self.isRefreshing = false }
        let previousError = self.lastError

        do {
            let data = try await ControlChannel.shared.health(timeout: 15)
            if let decoded = decodeHealthSnapshot(from: data) {
                self.snapshot = decoded
                self.lastSuccess = Date()
                self.lastError = nil
                if previousError != nil {
                    Self.logger.info("health refresh recovered")
                }
            } else {
                self.lastError = "health output not JSON"
                if onDemand { self.snapshot = nil }
                if previousError != self.lastError {
                    Self.logger.warning("health refresh failed: output not JSON")
                }
            }
        } catch {
            let desc = error.localizedDescription
            self.lastError = desc
            if onDemand { self.snapshot = nil }
            if previousError != desc {
                Self.logger.error("health refresh failed \(desc, privacy: .public)")
            }
        }
    }

    private static func isChannelHealthy(_ summary: HealthSnapshot.ChannelSummary) -> Bool {
        guard summary.configured == true else { return false }
        // If probe is missing, treat it as "configured but unknown health" (not a hard fail).
        return summary.probe?.ok ?? true
    }

    private static func describeProbeFailure(_ probe: HealthSnapshot.ChannelSummary.Probe) -> String {
        let elapsed = probe.elapsedMs.map { "\(Int($0))ms" }
        if let error = probe.error, error.lowercased().contains("timeout") || probe.status == nil {
            if let elapsed { return "Health check timed out (\(elapsed))" }
            return "Health check timed out"
        }
        let code = probe.status.map { "status \($0)" } ?? "status unknown"
        let reason = probe.error?.isEmpty == false ? probe.error! : "health probe failed"
        if let elapsed { return "\(reason) (\(code), \(elapsed))" }
        return "\(reason) (\(code))"
    }

    private func resolveLinkChannel(
        _ snap: HealthSnapshot) -> (id: String, summary: HealthSnapshot.ChannelSummary)?
    {
        let order = snap.channelOrder ?? Array(snap.channels.keys)
        for id in order {
            if let summary = snap.channels[id], summary.linked == true {
                return (id: id, summary: summary)
            }
        }
        for id in order {
            if let summary = snap.channels[id], summary.linked != nil {
                return (id: id, summary: summary)
            }
        }
        return nil
    }

    private func resolvePrimaryChannel(
        _ snap: HealthSnapshot) -> (id: String, summary: HealthSnapshot.ChannelSummary)?
    {
        if let link = self.resolveLinkChannel(snap) {
            return link
        }

        let order = snap.channelOrder ?? Array(snap.channels.keys)
        for id in order {
            if let summary = snap.channels[id], summary.configured == true {
                return (id: id, summary: summary)
            }
        }
        for id in order {
            if let summary = snap.channels[id] {
                return (id: id, summary: summary)
            }
        }
        return nil
    }

    private func channelLabel(_ id: String, in snap: HealthSnapshot) -> String {
        snap.channelLabels?[id] ?? id.capitalized
    }

    private func resolveFallbackChannel(
        _ snap: HealthSnapshot,
        excluding id: String?) -> (id: String, summary: HealthSnapshot.ChannelSummary)?
    {
        let order = snap.channelOrder ?? Array(snap.channels.keys)
        for channelId in order {
            if channelId == id { continue }
            guard let summary = snap.channels[channelId] else { continue }
            if Self.isChannelHealthy(summary) {
                return (id: channelId, summary: summary)
            }
        }
        return nil
    }

    var state: HealthState {
        if let error = self.lastError, !error.isEmpty {
            return .degraded(error)
        }
        guard let snap = self.snapshot else { return .unknown }
        guard let primary = self.resolvePrimaryChannel(snap) else {
            return snap.ok == true ? .ok : .unknown
        }
        if primary.summary.linked == false {
            // Linking is optional if any other channel is healthy; don't paint the whole app red.
            let fallback = self.resolveFallbackChannel(snap, excluding: primary.id)
            return fallback != nil ? .degraded("Not linked") : .linkingNeeded
        }
        // Any primary channel can be unhealthy (failed probe / cannot connect).
        if let probe = primary.summary.probe, probe.ok == false {
            return .degraded(Self.describeProbeFailure(probe))
        }
        if primary.summary.configured == true || snap.ok == true {
            return .ok
        }
        return .unknown
    }

    var summaryLine: String {
        if self.isRefreshing { return "Health check running…" }
        if let error = self.lastError { return "Health check failed: \(error)" }
        guard let snap = self.snapshot else { return "Health check pending" }
        guard let primary = self.resolvePrimaryChannel(snap) else {
            return snap.ok == true ? "Gateway connected" : "Health check pending"
        }
        if primary.summary.linked == false {
            if let fallback = self.resolveFallbackChannel(snap, excluding: primary.id) {
                let fallbackLabel = snap.channelLabels?[fallback.id] ?? fallback.id.capitalized
                let fallbackState = (fallback.summary.probe?.ok ?? true) ? "ok" : "degraded"
                return "\(fallbackLabel) \(fallbackState) · Not linked — run openclaw login"
            }
            return "Not linked — run openclaw login"
        }
        if let probe = primary.summary.probe, probe.ok == false {
            let status = probe.status.map(String.init) ?? "?"
            let suffix = probe.status == nil ? "probe degraded" : "probe degraded · status \(status)"
            if primary.summary.linked == true {
                let auth = primary.summary.authAgeMs.map { msToAge($0) } ?? "unknown"
                return "linked · auth \(auth) · \(suffix)"
            }
            let label = self.channelLabel(primary.id, in: snap)
            return "\(label) degraded · \(suffix)"
        }
        if primary.summary.linked == true {
            let auth = primary.summary.authAgeMs.map { msToAge($0) } ?? "unknown"
            return "linked · auth \(auth)"
        }
        let label = self.channelLabel(primary.id, in: snap)
        if primary.summary.configured == true {
            return "\(label) ok"
        }
        return snap.ok == true ? "Gateway connected" : "Health check pending"
    }

    /// Short, human-friendly detail for the last failure, used in the UI.
    var detailLine: String? {
        if let error = self.lastError, !error.isEmpty {
            let lower = error.lowercased()
            if lower.contains("connection refused") {
                let port = GatewayEnvironment.gatewayPort()
                let host = GatewayConnectivityCoordinator.shared.localEndpointHostLabel ?? "127.0.0.1:\(port)"
                return "The gateway control port (\(host)) isn’t listening — restart OpenClaw to bring it back."
            }
            if lower.contains("timeout") {
                return "Timed out waiting for the control server; the gateway may be crashed or still starting."
            }
            return error
        }
        return nil
    }

    func describeFailure(from snap: HealthSnapshot, fallback: String?) -> String {
        if let primary = self.resolvePrimaryChannel(snap), primary.summary.linked == false {
            return "Not linked — run openclaw login"
        }
        if let primary = self.resolvePrimaryChannel(snap),
           let probe = primary.summary.probe,
           probe.ok == false
        {
            return Self.describeProbeFailure(probe)
        }
        if snap.ok == true {
            return "Gateway connected"
        }
        if let fallback, !fallback.isEmpty {
            return fallback
        }
        return "health probe failed"
    }

    var degradedSummary: String? {
        guard case let .degraded(reason) = self.state else { return nil }
        if reason == "[object Object]" || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           let snap = self.snapshot
        {
            return self.describeFailure(from: snap, fallback: reason)
        }
        return reason
    }
}

func msToAge(_ ms: Double) -> String {
    let minutes = Int(round(ms / 60000))
    if minutes < 1 { return "just now" }
    if minutes < 60 { return "\(minutes)m" }
    let hours = Int(round(Double(minutes) / 60))
    if hours < 48 { return "\(hours)h" }
    let days = Int(round(Double(hours) / 24))
    return "\(days)d"
}

/// Decode a health snapshot, tolerating stray log lines before/after the JSON blob.
func decodeHealthSnapshot(from data: Data) -> HealthSnapshot? {
    let decoder = JSONDecoder()
    if let snap = try? decoder.decode(HealthSnapshot.self, from: data) {
        return snap
    }
    guard let text = String(data: data, encoding: .utf8) else { return nil }
    guard let firstBrace = text.firstIndex(of: "{"), let lastBrace = text.lastIndex(of: "}") else {
        return nil
    }
    let slice = text[firstBrace...lastBrace]
    let cleaned = Data(slice.utf8)
    return try? decoder.decode(HealthSnapshot.self, from: cleaned)
}
