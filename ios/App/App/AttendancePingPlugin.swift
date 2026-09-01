import Capacitor
import CoreLocation
import Foundation

@objc(AttendancePingPlugin)
public class AttendancePingPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AttendancePingPlugin"
    public let jsName = "AttendancePing"
    public let pluginMethods: [CAPPluginMethod] = [
        .init(name: "start", returnType: CAPPluginReturnPromise),
        .init(name: "stop", returnType: CAPPluginReturnPromise),
        .init(name: "updateSession", returnType: CAPPluginReturnPromise)
    ]

    private let tracker = AttendanceLocationTracker.shared

    @objc func start(_ call: CAPPluginCall) {
        guard
            let url = call.getString("supabaseUrl"),
            let anon = call.getString("anonKey"),
            let token = call.getString("accessToken")
        else {
            call.reject("Missing attendance ping credentials")
            return
        }
        tracker.start(url: url, anon: anon, token: token)
        call.resolve()
    }

    @objc func updateSession(_ call: CAPPluginCall) {
        guard let token = call.getString("accessToken") else {
            call.reject("Missing access token")
            return
        }
        tracker.updateToken(token)
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        tracker.stop()
        call.resolve()
    }
}

final class AttendanceLocationTracker: NSObject, CLLocationManagerDelegate {
    static let shared = AttendanceLocationTracker()
    private let manager = CLLocationManager()
    private var lastPingAt: Date = .distantPast
    private let interval: TimeInterval = 5 * 60

    private override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.distanceFilter = 40
        manager.allowsBackgroundLocationUpdates = true
        manager.pausesLocationUpdatesAutomatically = false
        if #available(iOS 11.0, *) {
            manager.showsBackgroundLocationIndicator = true
        }
    }

    func start(url: String, anon: String, token: String) {
        _ = url
        _ = anon
        _ = token
        stop()
    }

    func updateToken(_ token: String) {
        UserDefaults.standard.set(token, forKey: "scorr_att_token")
    }

    func stop() {
        manager.stopUpdatingLocation()
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: "scorr_att_url")
        defaults.removeObject(forKey: "scorr_att_anon")
        defaults.removeObject(forKey: "scorr_att_token")
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        pingIfDue(locations.last)
    }

    private func pingIfDue(_ location: CLLocation?) {
        guard let location, Date().timeIntervalSince(lastPingAt) >= interval || lastPingAt == .distantPast else {
            return
        }
        lastPingAt = Date()
        post(location)
    }

    private func post(_ location: CLLocation) {
        let defaults = UserDefaults.standard
        guard
            let base = defaults.string(forKey: "scorr_att_url"),
            let anon = defaults.string(forKey: "scorr_att_anon"),
            let token = defaults.string(forKey: "scorr_att_token")
        else { return }
        let trimmed = base.hasSuffix("/") ? String(base.dropLast()) : base
        guard let url = URL(string: trimmed + "/rest/v1/rpc/process_geo_attendance_ping") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(anon, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let acc = location.horizontalAccuracy > 0 ? location.horizontalAccuracy : 40
        let body = """
        {"p_latitude":\(location.coordinate.latitude),"p_longitude":\(location.coordinate.longitude),"p_accuracy":\(acc)}
        """
        request.httpBody = body.data(using: .utf8)
        URLSession.shared.dataTask(with: request).resume()
    }
}
