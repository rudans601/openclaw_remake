import Foundation

enum MacNodeScreenCommand: String, Codable, Sendable {
    case snapshot = "screen.snapshot"
    case click = "screen.click"
    case type = "screen.type"
    case record = "screen.record"
}

struct MacNodeScreenSnapshotParams: Codable, Sendable, Equatable {
    var screenIndex: Int?
    var format: String?
    var maxWidth: Int?
    var quality: Double?
}

struct MacNodeScreenRecordParams: Codable, Sendable, Equatable {
  var screenIndex: Int?
  var durationMs: Int?
  var fps: Double?
  var format: String?
  var includeAudio: Bool?
}

struct MacNodeScreenClickParams: Codable, Sendable, Equatable {
    var x: Double
    var y: Double
    var button: String?
    var clickCount: Int?
    var moveOnly: Bool?
    var screenIndex: Int?
}

struct MacNodeScreenTypeParams: Codable, Sendable, Equatable {
    var text: String
    var submit: Bool?
    var intervalMs: Double?
    var screenIndex: Int?
}
