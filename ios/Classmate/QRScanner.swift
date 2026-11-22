import AVFoundation
import SwiftUI

struct QRScannerScreen: View {
    let onInvite: (URL) -> Void
    @State private var status = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var invalid = false

    var body: some View {
        Group {
            switch status {
            case .authorized:
                QRScannerView { value in
                    if let url = URL(string: value), ClassmatePortal.isInvite(url) {
                        onInvite(url)
                    } else {
                        invalid = true
                    }
                } onFailure: {
                    status = .restricted
                }
                .overlay(alignment: .bottom) {
                    Text(invalid ? "클래스메이트 학급 초대 QR을 비춰 주세요." : "선생님이 보내 준 학급 초대 QR을 비춰 주세요.")
                        .padding()
                        .background(.regularMaterial, in: .rect(cornerRadius: 14))
                        .padding()
                }
            case .notDetermined:
                ProgressView()
                    .task {
                        _ = await AVCaptureDevice.requestAccess(for: .video)
                        status = AVCaptureDevice.authorizationStatus(for: .video)
                    }
            default:
                ContentUnavailableView("카메라를 사용할 수 없어요", systemImage: "camera", description:
                    Text("설정에서 카메라 접근을 허용하거나 선생님이 보내 준 학급 초대 링크를 열어 주세요."))
            }
        }
    }
}

private struct QRScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void
    let onFailure: () -> Void

    func makeUIViewController(context: Context) -> Controller {
        let controller = Controller()
        controller.onScan = onScan
        controller.onFailure = onFailure
        return controller
    }

    func updateUIViewController(_ controller: Controller, context: Context) {}

    final class Controller: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        private let session = AVCaptureSession()
        private let cameraQueue = DispatchQueue(label: "kr.classmate.qr")
        private var preview: AVCaptureVideoPreviewLayer?
        private var lastCode: String?
        var onScan: ((String) -> Void)?
        var onFailure: (() -> Void)?

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let camera = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: camera),
                  session.canAddInput(input) else { onFailure?(); return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { onFailure?(); return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            view.layer.addSublayer(layer)
            preview = layer
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            guard preview != nil else { return }
            cameraQueue.async { [session] in session.startRunning() }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            cameraQueue.async { [session] in session.stopRunning() }
        }

        nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
                                        from connection: AVCaptureConnection) {
            guard let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
            Task { @MainActor in
                guard value != lastCode else { return }
                lastCode = value
                onScan?(value)
            }
        }
    }
}
