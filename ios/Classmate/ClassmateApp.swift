import SwiftUI
import WebKit

@main
struct ClassmateApp: App {
    @StateObject private var portal = ClassmatePortal()

    var body: some Scene {
        WindowGroup {
            ClassmateHome(portal: portal)
        }
    }
}

private struct ClassmateHome: View {
    enum Tab: Hashable { case portal, timetable }

    @ObservedObject var portal: ClassmatePortal
    @State private var selection: Tab = .portal
    @State private var scanning = false

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack {
                ZStack(alignment: .top) {
                    WebsiteView(webView: portal.webView)
                    if portal.loading {
                        ProgressView()
                            .progressViewStyle(.linear)
                            .accessibilityLabel("클래스메이트 불러오는 중")
                    }
                    if portal.failed {
                        ContentUnavailableView {
                            Label("연결할 수 없어요", systemImage: "wifi.exclamationmark")
                        } description: {
                            Text("인터넷 연결을 확인해 주세요. 저장한 시간표는 시간표 탭에서 볼 수 있어요.")
                        } actions: {
                            Button("다시 시도") { portal.reload() }
                                .buttonStyle(.borderedProminent)
                        }
                        .background(.background)
                    }
                }
                .navigationTitle("클래스메이트")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { portal.back() } label: {
                            Label("뒤로", systemImage: "chevron.left")
                        }
                        .disabled(!portal.canGoBack)
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button("학급 QR 스캔", systemImage: "qrcode.viewfinder") { scanning = true }
                            Button("새로고침", systemImage: "arrow.clockwise") { portal.reload() }
                            Button("계정 삭제", systemImage: "person.crop.circle.badge.minus") {
                                portal.go(to: "/account/delete")
                            }
                            Button("이용약관", systemImage: "doc.text") { portal.go(to: "/terms") }
                            Button("개인정보처리방침", systemImage: "hand.raised") { portal.go(to: "/privacy") }
                        } label: {
                            Label("더 보기", systemImage: "ellipsis.circle")
                        }
                    }
                }
            }
            .tabItem { Label("클래스메이트", systemImage: "house") }
            .tag(Tab.portal)

            NavigationStack {
                WeekScheduleView(snapshot: portal.schedule) {
                    selection = .portal
                }
            }
            .tabItem { Label("시간표", systemImage: "calendar") }
            .tag(Tab.timetable)
        }
        .tint(Color(red: 0.12, green: 0.36, blue: 0.82))
        .sheet(isPresented: $scanning) {
            NavigationStack {
                QRScannerScreen { url in
                    scanning = false
                    selection = .portal
                    portal.openInvite(url)
                }
                .navigationTitle("학급 QR 스캔")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("닫기") { scanning = false }
                    }
                }
            }
        }
    }
}

private struct WebsiteView: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

@MainActor
final class ClassmatePortal: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    static let origin = URL(string: "https://classmate.kr")!

    @Published private(set) var loading = false
    @Published private(set) var failed = false
    @Published private(set) var canGoBack = false
    @Published private(set) var schedule = ScheduleSnapshot.restore()

    private(set) var webView: WKWebView!
    private var requestedURL: URL?

    override init() {
        super.init()
        let configuration = WKWebViewConfiguration()
        configuration.applicationNameForUserAgent = "ClassmateIOS/1.0"
        configuration.websiteDataStore = .default()
        configuration.userContentController.add(WeakScriptReceiver(target: self), name: "schedule")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        go(to: "/auth/login")
    }

    func go(to path: String) {
        guard let url = URL(string: path, relativeTo: Self.origin)?.absoluteURL, Self.isLocal(url) else { return }
        load(url)
    }

    func openInvite(_ url: URL) {
        guard Self.isInvite(url) else { return }
        load(url)
    }

    static func isInvite(_ url: URL) -> Bool {
        guard isLocal(url), url.path == "/join",
              let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return false }
        return ["c", "t"].allSatisfy { key in
            query.contains { $0.name == key && !($0.value ?? "").isEmpty }
        }
    }

    func reload() {
        if let url = webView.url ?? requestedURL { load(url) }
    }

    func back() { webView.goBack() }

    private func load(_ url: URL) {
        requestedURL = url
        failed = false
        webView.load(URLRequest(url: url))
    }

    private static func isLocal(_ url: URL) -> Bool {
        url.scheme == "https" && url.host == origin.host && (url.port == nil || url.port == 443)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if Self.isLocal(url) { return .allow }
        if action.targetFrame?.isMainFrame == false,
           url.scheme == "https",
           url.host == "classmate-mvp-9f855.firebaseapp.com",
           url.path == "/__/auth/iframe" { return .allow }
        if action.navigationType == .linkActivated, ["https", "mailto"].contains(url.scheme ?? "") {
            await UIApplication.shared.open(url)
        }
        return .cancel
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        if Self.isLocal(url) {
            load(url)
        } else if url.scheme == "https" || url.scheme == "mailto" {
            UIApplication.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        loading = true
        failed = false
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loading = false
        canGoBack = webView.canGoBack
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        navigationFailed(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        navigationFailed(error)
    }

    private func navigationFailed(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        loading = false
        failed = true
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loading = false
        failed = true
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let source = message.frameInfo.securityOrigin
        guard message.name == "schedule", message.frameInfo.isMainFrame,
              source.protocol == "https", source.host == Self.origin.host,
              source.port == 0 || source.port == 443,
              let payload = message.body as? [String: Any] else { return }
        if payload["signedOut"] as? Bool == true {
            schedule = nil
            ScheduleSnapshot.clear()
            return
        }
        if let data = try? JSONSerialization.data(withJSONObject: payload),
           let incoming = try? JSONDecoder().decode(ScheduleSnapshot.self, from: data),
           incoming != schedule {
            schedule = incoming
            incoming.save()
        }
    }
}

@MainActor
private final class WeakScriptReceiver: NSObject, WKScriptMessageHandler {
    weak var target: ClassmatePortal?
    init(target: ClassmatePortal) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
