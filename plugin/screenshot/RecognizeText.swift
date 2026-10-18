import Foundation
import Vision
import AppKit

struct InputPayload: Decodable {
    let data: String
    let width: Int
    let height: Int
}

struct WordBox: Encodable {
    let text: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct LineBox: Encodable {
    let text: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let words: [WordBox]
}

struct OcrValue: Encodable {
    let width: Int
    let height: Int
    let text: String
    let lines: [LineBox]
}

struct OutputPayload: Encodable {
    let ok: Bool
    let value: OcrValue?
    let error: [String: String]?
}

func emit(_ payload: OutputPayload) -> Never {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(payload), let str = String(data: data, encoding: .utf8) {
        print(str)
    } else {
        print("{\"ok\":false,\"error\":{\"code\":\"ocr-failed\"}}")
    }
    exit(0)
}

let stdinData = FileHandle.standardInput.readDataToEndOfFile()
guard let input = try? JSONDecoder().decode(InputPayload.self, from: stdinData),
      let imgData = Data(base64Encoded: input.data),
      let nsImage = NSImage(data: imgData),
      let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    emit(OutputPayload(ok: false, value: nil, error: ["code": "ocr-failed"]))
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    emit(OutputPayload(ok: false, value: nil, error: ["code": "ocr-failed"]))
}

let observations = request.results ?? []
let w = Double(input.width)
let h = Double(input.height)

var lines: [LineBox] = []
for obs in observations {
    guard let top = obs.topCandidates(1).first else { continue }
    let bbox = obs.boundingBox
    let lx = bbox.origin.x * w
    let ly = (1.0 - bbox.origin.y - bbox.size.height) * h
    let lw = bbox.size.width * w
    let lh = bbox.size.height * h
    lines.append(LineBox(
        text: top.string,
        x: lx,
        y: ly,
        width: lw,
        height: lh,
        words: [WordBox(text: top.string, x: lx, y: ly, width: lw, height: lh)]
    ))
}

lines.sort {
    if abs($0.y - $1.y) > min($0.height, $1.height) * 0.5 {
        return $0.y < $1.y
    }
    return $0.x < $1.x
}

let fullText = lines.map { $0.text }.joined(separator: "\n")
emit(OutputPayload(
    ok: true,
    value: OcrValue(width: input.width, height: input.height, text: fullText, lines: lines),
    error: nil
))
