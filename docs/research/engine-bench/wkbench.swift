// usage: wkbench <baseURL> <outJsonl> <winW> <winH> <query>...
// Loads each query in a system WKWebView (the engine Tauri uses on macOS), polls window.__done, appends window.__result.
import AppKit
import WebKit

let args = CommandLine.arguments
let base = args[1], out = args[2]
let winW = Double(args[3])!, winH = Double(args[4])!
var queries = Array(args[5...])
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: winW, height: winH), styleMask: [.titled], backing: .buffered, defer: false)
win.title = "herdr-3d bench (closes itself)"
let cfg = WKWebViewConfiguration()
if ProcessInfo.processInfo.environment["UNLOCK120"] != nil {
  // Private API (same approach as tauri-plugin-macos-fps): disable "Prefer Page Rendering Updates near 60fps".
  let prefs = cfg.preferences
  if let feats = (WKPreferences.self as AnyObject).perform(NSSelectorFromString("_features"))?.takeUnretainedValue() as? [NSObject] {
    for f in feats where (f.value(forKey: "key") as? String) == "PreferPageRenderingUpdatesNear60FPSEnabled" {
      let sel = NSSelectorFromString("_setEnabled:forFeature:")
      typealias Fn = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
      let imp = prefs.method(for: sel)!
      unsafeBitCast(imp, to: Fn.self)(prefs, sel, false, f)
      FileHandle.standardError.write("unlocked 120: \(f.value(forKey: "key")!)\n".data(using: .utf8)!)
    }
  }
}
let wv = WKWebView(frame: win.contentView!.bounds, configuration: cfg)
wv.autoresizingMask = [.width, .height]
win.contentView!.addSubview(wv)
win.orderFrontRegardless()
FileManager.default.createFile(atPath: out, contents: nil)
let fh = FileHandle(forWritingAtPath: out)!
fh.seekToEndOfFile()

func next() {
  guard !queries.isEmpty else { app.terminate(nil); return }
  let q = queries.removeFirst()
  wv.load(URLRequest(url: URL(string: base + "/?" + q)!))
  poll(q, Date())
}
func poll(_ q: String, _ t0: Date) {
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
    wv.evaluateJavaScript("window.__done ? JSON.stringify(Object.assign(window.__result, {log: window.__log || []})) : null") { res, _ in
      if let s = res as? String {
        let line = s.dropLast() + ",\"query\":\"\(q)\",\"engine\":\"WKWebView\",\"wallS\":\(Date().timeIntervalSince(t0))}\n"
        fh.write(line.data(using: .utf8)!); print(line, terminator: ""); next()
      } else if Date().timeIntervalSince(t0) > 300 {
        fh.write("{\"query\":\"\(q)\",\"error\":\"timeout\"}\n".data(using: .utf8)!); next()
      } else { poll(q, t0) }
    }
  }
}
next()
app.run()
