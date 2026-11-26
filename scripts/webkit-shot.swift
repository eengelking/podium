// Loads a page in the system WebKit (the engine Safari uses, with no extensions) and saves what it draws (#1415).
// For looking for a Safari-only drawing fault that headless Chrome cannot show. Run with: swift scripts/webkit-shot.swift --help
import AppKit
import WebKit

let usage = """
Usage: swift scripts/webkit-shot.swift --url <address> --out <folder> [--width 1440] [--height 900] [--scenario <name>]
                                       [--probe <javascript>]

Loads <address> in a WKWebView window and saves PNG snapshots into <folder>. Scenarios:
  visible   (default) load in a window on screen, snapshot after 3 s and 20 s
  hidden    load while the window is not on screen for 8 s, then show it
  resize    load at 400 px wide, then widen to --width
  zero      load in a view with no size, then give it --width by --height
  drag      take the front, then widen from 400 px to --width in small steps
  jump      take the front, then widen from 400 px to --width in one step, as zoom or full screen does
  jumpback  jump, then narrow again and widen in small steps
Open every saved picture. Each line also prints measured sizes, but text WebKit fails to paint keeps its computed size,
so the numbers alone prove nothing (#1415). A <name>-screen.png of the window itself is taken too, when the terminal may
record the screen. The windows open on your screen.
"""

var options = ["--width": "1440", "--height": "900", "--scenario": "visible"]
var args = Array(CommandLine.arguments.dropFirst())
if args.contains("--help") || args.contains("-h") { print(usage); exit(0) }
let known = ["--url", "--out", "--width", "--height", "--scenario", "--probe"]
while args.count >= 2, known.contains(args[0]) { options[args[0]] = args[1]; args.removeFirst(2) }
// A mistyped option or scenario would otherwise run the default and look like a result.
let scenarios = ["visible", "hidden", "resize", "zero", "drag", "jump", "jumpback"]
guard args.isEmpty, let address = options["--url"], let url = URL(string: address), let folder = options["--out"],
      let width = Double(options["--width"]!), let height = Double(options["--height"]!),
      let scenario = options["--scenario"], scenarios.contains(scenario) else { print(usage); exit(2) }
try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let full = NSRect(x: 40, y: 40, width: width, height: height)
let start: NSRect = scenario == "resize" ? NSRect(x: 40, y: 40, width: 400, height: height) : full
let window = NSWindow(contentRect: start, styleMask: [.titled, .resizable], backing: .buffered, defer: false)
let web = WKWebView(frame: NSRect(origin: .zero, size: scenario == "zero" ? .zero : start.size))
if scenario != "zero" { web.autoresizingMask = [.width, .height] }
window.contentView = NSView(frame: NSRect(origin: .zero, size: start.size))
window.contentView!.addSubview(web)

// The page may move only within the address it was given: a link or a redirect to anywhere else is refused.
final class SameSite: NSObject, WKNavigationDelegate {
  let given: URL
  init(_ given: URL) { self.given = given }
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
    let next = action.request.url
    let same = next?.scheme == given.scheme && next?.host == given.host && next?.port == given.port
    if !same { print("refused to leave for \(next?.absoluteString ?? "an unknown address")") }
    decisionHandler(same ? .allow : .cancel)
  }
}
let sameSite = SameSite(url) // the web view holds its delegate weakly
web.navigationDelegate = sameSite
if scenario != "hidden" { window.orderFrontRegardless() }

func after(_ seconds: Double, _ work: @escaping () -> Void) { DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work) }

func snapshot(_ name: String, then: @escaping () -> Void) {
  let probe = "JSON.stringify({inner:innerWidth,art:document.querySelector('.art-wrap')?.offsetWidth,chip:document.querySelector('.chip')?.offsetWidth,icon:document.querySelector('.chip svg')?.getBoundingClientRect().width,fonts:[...document.querySelectorAll('.chip .lbl, .chip .val, .chip .mono, .chip .mono2')].map(e=>getComputedStyle(e).fontSize)})"
  // What is on the screen, when the terminal may record it; WebKit's own snapshot is drawn afresh.
  let screen = Process()
  screen.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  screen.arguments = ["-x", "-o", "-l\(window.windowNumber)", "\(folder)/\(scenario)-\(name)-screen.png"]
  try? screen.run()
  screen.waitUntilExit()
  web.evaluateJavaScript(options["--probe"] ?? probe) { sizes, _ in
    web.takeSnapshot(with: nil) { image, error in
      if let tiff = image?.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
        let path = "\(folder)/\(scenario)-\(name).png"
        try! png.write(to: URL(fileURLWithPath: path))
        print("saved \(path) measured \(sizes ?? "?")")
      } else {
        print("no snapshot for \(name): \(error?.localizedDescription ?? "unknown")")
      }
      then()
    }
  }
}

web.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))

let shotTwice = {
  snapshot("first") { after(17) { snapshot("later") { exit(0) } } }
}
switch scenario {
case "hidden": after(8) { window.orderFrontRegardless(); after(1, shotTwice) }
case "resize": after(4) { snapshot("narrow") { window.setFrame(full, display: true); after(2, shotTwice) } }
case "zero": after(4) { web.frame = NSRect(origin: .zero, size: full.size); after(2, shotTwice) }
// As a person dragging the window's edge would: the app in front, and many small steps.
case "drag", "jump", "jumpback":
  app.setActivationPolicy(.regular)
  app.activate(ignoringOtherApps: true)
  window.makeKeyAndOrderFront(nil)
  window.setFrame(NSRect(x: 40, y: 40, width: 400, height: height), display: true)
  let steps = scenario == "drag" ? 60 : 1
  for i in 1...steps {
    after(4 + Double(i) * 0.03) {
      window.setFrame(NSRect(x: 40, y: 40, width: 400 + (width - 400) * Double(i) / Double(steps), height: height), display: true)
    }
  }
  if scenario == "jumpback" {
    // Widen in one step, go narrow again, then widen once more in small steps: does a stuck page recover whole?
    after(6) { window.setFrame(NSRect(x: 40, y: 40, width: 400, height: height), display: true) }
    for i in 1...60 {
      after(7 + Double(i) * 0.03) {
        window.setFrame(NSRect(x: 40, y: 40, width: 400 + (width - 400) * Double(i) / 60, height: height), display: true)
      }
    }
  }
  after(11, shotTwice)
default: after(3, shotTwice)
}
after(60) { print("timed out"); exit(1) }
app.run()
