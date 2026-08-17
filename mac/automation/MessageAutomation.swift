import Foundation

guard CommandLine.arguments.count == 3 else {
  fputs("usage: imessage-bridge-automation <E.164 recipient> <body>\n", stderr)
  exit(2)
}

func escapeAppleScript(_ value: String) -> String {
  value
    .replacingOccurrences(of: "\\", with: "\\\\")
    .replacingOccurrences(of: "\"", with: "\\\"")
}

let recipient = escapeAppleScript(CommandLine.arguments[1])
let body = escapeAppleScript(CommandLine.arguments[2])
let source = """
tell application "Messages"
  set targetService to 1st service whose service type = iMessage
  set theBuddy to buddy "\(recipient)" of targetService
  send "\(body)" to theBuddy
end tell
"""

var error: NSDictionary?
guard let script = NSAppleScript(source: source) else {
  fputs("Messages automation failed: unable to create AppleScript\n", stderr)
  exit(1)
}
script.executeAndReturnError(&error)
if let error {
  fputs("Messages automation failed: \(error)\n", stderr)
  exit(1)
}
