import Capacitor
import CoreLocation
import Foundation
import NetworkExtension
import UserNotifications

// MARK: - Capacitor bridge (R44 / R71)
//
// Replaces continuous GPS polling with CLLocationManager region monitoring.
 // Device token lives in Keychain (never expires). Events outside attendance
 // window W are dropped on-device. Wi-Fi is a supporting signal only via
 // NEHotspotNetwork.fetchCurrent when region monitoring wakes the app —
 // requires the "Access WiFi Information" entitlement
 // (com.apple.developer.networking.wifi-info). iPhone cannot observe Wi-Fi
 // connect/disconnect in the background.

@objc(AttendancePingPlugin)
public class AttendancePingPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AttendancePingPlugin"
    public let jsName = "AttendancePing"
    public let pluginMethods: [CAPPluginMethod] = [
        .init(name: "startAutoAttendance", returnType: CAPPluginReturnPromise),
        .init(name: "stopAutoAttendance", returnType: CAPPluginReturnPromise),
        .init(name: "syncSchedule", returnType: CAPPluginReturnPromise),
        // Legacy aliases — map to the auto-attendance API
        .init(name: "start", returnType: CAPPluginReturnPromise),
        .init(name: "stop", returnType: CAPPluginReturnPromise),
        .init(name: "updateSession", returnType: CAPPluginReturnPromise),
    ]

    private let engine = AttendanceAutoEngine.shared

    @objc func startAutoAttendance(_ call: CAPPluginCall) {
        guard
            let url = call.getString("supabaseUrl"),
            let anon = call.getString("anonKey"),
            let token = call.getString("deviceToken")
        else {
            call.reject("Missing supabaseUrl, anonKey, or deviceToken")
            return
        }
        let deviceId = call.getString("deviceId")
        let appVersion = call.getString("appVersion")
        engine.start(
            supabaseUrl: url,
            anonKey: anon,
            deviceToken: token,
            deviceId: deviceId,
            appVersion: appVersion
        ) { result in
            switch result {
            case .success:
                call.resolve(["ok": true])
            case .failure(let err):
                call.reject(err.localizedDescription)
            }
        }
    }

    @objc func stopAutoAttendance(_ call: CAPPluginCall) {
        engine.stop(clearToken: true)
        call.resolve(["ok": true])
    }

    @objc func syncSchedule(_ call: CAPPluginCall) {
        engine.syncSchedule { result in
            switch result {
            case .success(let info):
                call.resolve(info)
            case .failure(let err):
                call.reject(err.localizedDescription)
            }
        }
    }

    /// Legacy: prefer startAutoAttendance with deviceToken.
    @objc func start(_ call: CAPPluginCall) {
        if call.getString("deviceToken") != nil {
            startAutoAttendance(call)
            return
        }
        call.reject("Use startAutoAttendance with deviceToken (JWT pings removed)")
    }

    @objc func stop(_ call: CAPPluginCall) {
        stopAutoAttendance(call)
    }

    @objc func updateSession(_ call: CAPPluginCall) {
        // JWT session updates are unused; schedule re-sync keeps device auth fresh.
        engine.syncSchedule { _ in call.resolve() }
    }
}

// MARK: - Keychain (R30 / R44)

enum AttendanceKeychain {
    private static let service = "ai.walfia.scorr.attendance"
    private static let tokenAccount = "device_token"
    private static let deviceIdAccount = "device_id"

    static func saveToken(_ token: String) {
        save(account: tokenAccount, value: token)
    }

    static func loadToken() -> String? {
        load(account: tokenAccount)
    }

    static func clearToken() {
        delete(account: tokenAccount)
    }

    static func saveDeviceId(_ id: String) {
        save(account: deviceIdAccount, value: id)
    }

    static func loadDeviceId() -> String? {
        load(account: deviceIdAccount)
    }

    private static func save(account: String, value: String) {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var attrs = query
        attrs[kSecValueData as String] = data
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(attrs as CFDictionary, nil)
    }

    private static func load(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        guard status == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

// MARK: - Persisted config / schedule

private enum AttendanceStore {
    static let urlKey = "scorr_att_url"
    static let anonKey = "scorr_att_anon"
    static let appVersionKey = "scorr_att_app_version"
    static let scheduleKey = "scorr_att_schedule_json"
    static let skewMsKey = "scorr_att_skew_ms"
    static let companyTzKey = "scorr_att_company_tz"
    static let enabledKey = "scorr_att_enabled"
    static let queueKey = "scorr_att_event_queue"

    static var defaults: UserDefaults { .standard }

    static var supabaseUrl: String? {
        get { defaults.string(forKey: urlKey) }
        set { defaults.set(newValue, forKey: urlKey) }
    }

    static var anonKeyValue: String? {
        get { defaults.string(forKey: anonKey) }
        set { defaults.set(newValue, forKey: anonKey) }
    }

    static var appVersion: String? {
        get { defaults.string(forKey: appVersionKey) }
        set { defaults.set(newValue, forKey: appVersionKey) }
    }

    static var enabled: Bool {
        get { defaults.bool(forKey: enabledKey) }
        set { defaults.set(newValue, forKey: enabledKey) }
    }

    static var skewMs: Int64 {
        get { Int64(defaults.integer(forKey: skewMsKey)) }
        set { defaults.set(Int(newValue), forKey: skewMsKey) }
    }

    static var companyTz: String {
        get { defaults.string(forKey: companyTzKey) ?? "UTC" }
        set { defaults.set(newValue, forKey: companyTzKey) }
    }

    static func saveScheduleJSON(_ data: Data) {
        defaults.set(data, forKey: scheduleKey)
    }

    static func loadScheduleJSON() -> Data? {
        defaults.data(forKey: scheduleKey)
    }

    static func clearAll(clearToken: Bool) {
        defaults.removeObject(forKey: urlKey)
        defaults.removeObject(forKey: anonKey)
        defaults.removeObject(forKey: appVersionKey)
        defaults.removeObject(forKey: scheduleKey)
        defaults.removeObject(forKey: skewMsKey)
        defaults.removeObject(forKey: companyTzKey)
        defaults.removeObject(forKey: enabledKey)
        defaults.removeObject(forKey: queueKey)
        if clearToken {
            AttendanceKeychain.clearToken()
        }
    }
}

// MARK: - Schedule models

private struct AttendanceWindow: Codable {
    let attendance_date: String?
    let shift_id: String?
    let shift_name: String?
    let shift_tz: String?
    let window_start_utc: String?
    let window_end_utc: String?
}

private struct AttendanceZone: Codable {
    let zone_id: String?
    let name: String?
    let latitude: Double?
    let longitude: Double?
    let radius_meters: Double?
    let detection_mode: String?
    let wifi_ssids: [String]?
    let wifi_bssids: [String]?
}

private struct AttendanceSchedule: Codable {
    let ok: Bool?
    let reason: String?
    let stop_tracking: Bool?
    let server_now_utc: String?
    let company_tz: String?
    let windows: [AttendanceWindow]?
    let zones: [AttendanceZone]?
}

private struct QueuedEvent: Codable {
    let event: String
    let zoneId: String?
    let lat: Double?
    let lng: Double?
    let accuracyM: Double?
    let ssid: String?
    let bssid: String?
    let occurredAtUtcMs: Int64
    let isMock: Bool
}

// MARK: - Engine

final class AttendanceAutoEngine: NSObject, CLLocationManagerDelegate {
    static let shared = AttendanceAutoEngine()

    private let manager = CLLocationManager()
    private let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private var schedule: AttendanceSchedule?
    private var regionIds = Set<String>()
    private let lock = NSLock()
    private var posting = false

    private override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.allowsBackgroundLocationUpdates = true
        manager.pausesLocationUpdatesAutomatically = false
        if #available(iOS 11.0, *) {
            manager.showsBackgroundLocationIndicator = false
        }
        if let data = AttendanceStore.loadScheduleJSON() {
            schedule = try? JSONDecoder().decode(AttendanceSchedule.self, from: data)
        }
        requestNotificationPermission()
    }

    /// Resume after process launch if auto attendance was enabled.
    func resumeIfNeeded() {
        guard AttendanceStore.enabled, AttendanceKeychain.loadToken() != nil else { return }
        ensureAlwaysAuthorization()
        applyMonitoringFromSchedule()
        flushQueue()
    }

    /// True when a device token is enrolled for auto attendance.
    var isEnrolled: Bool {
        AttendanceKeychain.loadToken() != nil && AttendanceStore.enabled
    }

    /// Foreground / time-change hook (R34).
    func syncIfEnrolled() {
        guard isEnrolled else { return }
        syncSchedule { _ in }
    }

    func start(
        supabaseUrl: String,
        anonKey: String,
        deviceToken: String,
        deviceId: String?,
        appVersion: String?,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        AttendanceStore.supabaseUrl = supabaseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        AttendanceStore.anonKeyValue = anonKey
        AttendanceStore.appVersion = appVersion
        AttendanceStore.enabled = true
        AttendanceKeychain.saveToken(deviceToken)
        if let deviceId, !deviceId.isEmpty {
            AttendanceKeychain.saveDeviceId(deviceId)
        } else if AttendanceKeychain.loadDeviceId() == nil {
            AttendanceKeychain.saveDeviceId(UUID().uuidString)
        }
        ensureAlwaysAuthorization()
        requestNotificationPermission()
        syncSchedule { result in
            switch result {
            case .success:
                completion(.success(()))
            case .failure(let err):
                completion(.failure(err))
            }
        }
    }

    func stop(clearToken: Bool) {
        stopAllMonitoring()
        AttendanceStore.clearAll(clearToken: clearToken)
        schedule = nil
        AttendanceStore.enabled = false
    }

    func syncSchedule(completion: @escaping (Result<[String: Any], Error>) -> Void) {
        guard
            let base = AttendanceStore.supabaseUrl,
            let anon = AttendanceStore.anonKeyValue,
            let token = AttendanceKeychain.loadToken()
        else {
            completion(.failure(NSError(domain: "ScorrAttendance", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Missing credentials or device token",
            ])))
            return
        }

        guard let url = URL(string: base + "/functions/v1/attendance-schedule") else {
            completion(.failure(NSError(domain: "ScorrAttendance", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Invalid supabaseUrl",
            ])))
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(anon, forHTTPHeaderField: "apikey")
        request.setValue(token, forHTTPHeaderField: "x-device-token")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["device_token": token])

        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            guard let self else { return }
            if let error {
                DispatchQueue.main.async { completion(.failure(error)) }
                return
            }
            guard let data else {
                DispatchQueue.main.async {
                    completion(.failure(NSError(domain: "ScorrAttendance", code: 3, userInfo: [
                        NSLocalizedDescriptionKey: "Empty schedule response",
                    ])))
                }
                return
            }

            do {
                let decoded = try JSONDecoder().decode(AttendanceSchedule.self, from: data)
                if decoded.stop_tracking == true || decoded.ok == false {
                    DispatchQueue.main.async {
                        if decoded.stop_tracking == true {
                            self.stop(clearToken: true)
                        }
                        completion(.success([
                            "ok": false,
                            "reason": decoded.reason ?? "schedule_error",
                            "stop_tracking": decoded.stop_tracking ?? false,
                        ]))
                    }
                    return
                }

                self.lock.lock()
                self.schedule = decoded
                self.lock.unlock()
                AttendanceStore.saveScheduleJSON(data)
                if let companyTz = decoded.company_tz {
                    AttendanceStore.companyTz = companyTz
                }
                if let serverNow = self.parseDate(decoded.server_now_utc) {
                    let skew = Int64(Date().timeIntervalSince(serverNow) * 1000)
                    AttendanceStore.skewMs = skew
                }

                DispatchQueue.main.async {
                    self.applyMonitoringFromSchedule()
                    self.flushQueue()
                    let upcoming = self.upcomingWindows().count
                    let monitoring = !self.regionIds.isEmpty
                    completion(.success([
                        "ok": true,
                        "windows": upcoming,
                        "zones": decoded.zones?.count ?? 0,
                        "monitoring": monitoring,
                        "company_tz": AttendanceStore.companyTz,
                    ]))
                }
            } catch {
                DispatchQueue.main.async { completion(.failure(error)) }
            }
        }.resume()
    }

    // MARK: Monitoring

    private func ensureAlwaysAuthorization() {
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestAlwaysAuthorization()
        case .authorizedWhenInUse:
            manager.requestAlwaysAuthorization()
        default:
            break
        }
    }

    private func applyMonitoringFromSchedule() {
        guard AttendanceStore.enabled else {
            stopAllMonitoring()
            return
        }
        let upcoming = upcomingWindows()
        if upcoming.isEmpty {
            // R44: stopMonitoring when no upcoming shifts
            stopAllMonitoring()
            return
        }
        guard let zones = schedule?.zones, !zones.isEmpty else {
            stopAllMonitoring()
            return
        }

        let status = manager.authorizationStatus
        guard status == .authorizedAlways || status == .authorizedWhenInUse else {
            return
        }

        var nextIds = Set<String>()
        for zone in zones {
            guard
                let id = zone.zone_id,
                let lat = zone.latitude,
                let lng = zone.longitude
            else { continue }
            let radius = max(50, min(zone.radius_meters ?? 150, 500))
            let center = CLLocationCoordinate2D(latitude: lat, longitude: lng)
            let region = CLCircularRegion(center: center, radius: radius, identifier: id)
            region.notifyOnEntry = true
            region.notifyOnExit = true
            manager.startMonitoring(for: region)
            manager.requestState(for: region)
            nextIds.insert(id)
        }

        for existing in manager.monitoredRegions {
            if !nextIds.contains(existing.identifier) {
                manager.stopMonitoring(for: existing)
            }
        }
        regionIds = nextIds
    }

    private func stopAllMonitoring() {
        for region in manager.monitoredRegions {
            manager.stopMonitoring(for: region)
        }
        regionIds.removeAll()
    }

    private func upcomingWindows(from date: Date = Date()) -> [AttendanceWindow] {
        let corrected = correctedNow(from: date)
        let windows = schedule?.windows ?? []
        return windows.filter { win in
            guard let end = parseDate(win.window_end_utc) else { return false }
            return end >= corrected
        }
    }

    private func isInsideWindow(_ date: Date = Date()) -> Bool {
        let corrected = correctedNow(from: date)
        for win in schedule?.windows ?? [] {
            guard
                let start = parseDate(win.window_start_utc),
                let end = parseDate(win.window_end_utc)
            else { continue }
            if corrected >= start && corrected <= end {
                return true
            }
        }
        return false
    }

    private func correctedNow(from date: Date = Date()) -> Date {
        date.addingTimeInterval(-Double(AttendanceStore.skewMs) / 1000.0)
    }

    private func parseDate(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        if let d = isoFrac.date(from: raw) { return d }
        if let d = iso.date(from: raw) { return d }
        // Postgres sometimes returns "2026-10-06 12:00:00+00"
        let alt = raw.replacingOccurrences(of: " ", with: "T")
        if let d = isoFrac.date(from: alt) { return d }
        if let d = iso.date(from: alt) { return d }
        return nil
    }

    // MARK: CLLocationManagerDelegate

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if manager.authorizationStatus == .authorizedAlways
            || manager.authorizationStatus == .authorizedWhenInUse {
            applyMonitoringFromSchedule()
        }
    }

    func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        handleRegionEvent(region: region, event: "enter")
    }

    func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        handleRegionEvent(region: region, event: "exit")
    }

    func locationManager(_ manager: CLLocationManager, didDetermineState state: CLRegionState, for region: CLRegion) {
        switch state {
        case .inside:
            handleRegionEvent(region: region, event: "enter")
        case .outside:
            // Only emit exit when we already have presence context; avoid noise at cold start.
            break
        case .unknown:
            break
        @unknown default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
        NSLog("Scorr attendance region fail %@: %@", region?.identifier ?? "?", error.localizedDescription)
    }

    private var lastEnterSentAt: [String: Date] = [:]

    private func handleRegionEvent(region: CLRegion, event: String) {
        // R10 / R44: drop anything outside W — send nothing
        guard isInsideWindow() else { return }
        guard AttendanceStore.enabled else { return }

        // Debounce requestState-driven enter storms (sync re-arms).
        if event == "enter" {
            let last = lastEnterSentAt[region.identifier] ?? .distantPast
            if Date().timeIntervalSince(last) < 60 {
                return
            }
            lastEnterSentAt[region.identifier] = Date()
        }

        let loc = manager.location
        let isMock: Bool
        if #available(iOS 15.0, *) {
            isMock = loc?.sourceInformation?.isSimulatedBySoftware == true
        } else {
            isMock = false
        }

        fetchWifi { [weak self] ssid, bssid in
            guard let self else { return }
            let payload = QueuedEvent(
                event: event,
                zoneId: region.identifier,
                lat: loc?.coordinate.latitude,
                lng: loc?.coordinate.longitude,
                accuracyM: loc.flatMap { $0.horizontalAccuracy > 0 ? $0.horizontalAccuracy : nil },
                ssid: ssid,
                bssid: bssid,
                occurredAtUtcMs: Int64(Date().timeIntervalSince1970 * 1000),
                isMock: isMock
            )
            self.postEvent(payload)
        }
    }

    // MARK: Wi-Fi supporting signal (R71)
    //
    // Requires Access WiFi Information entitlement + location permission.
    // Only callable while the app has execution time (e.g. region wake).
    // iOS cannot subscribe to Wi-Fi connect/disconnect in the background.

    private func fetchWifi(completion: @escaping (_ ssid: String?, _ bssid: String?) -> Void) {
        if #available(iOS 14.0, *) {
            NEHotspotNetwork.fetchCurrent { network in
                completion(network?.ssid, network?.bssid)
            }
        } else {
            completion(nil, nil)
        }
    }

    // MARK: Edge: auto-attendance-event

    private func postEvent(_ event: QueuedEvent) {
        enqueue(event)
        flushQueue()
    }

    private func enqueue(_ event: QueuedEvent) {
        lock.lock()
        defer { lock.unlock() }
        var queue = loadQueue()
        queue.append(event)
        // Cap queue size
        if queue.count > 100 {
            queue = Array(queue.suffix(100))
        }
        saveQueue(queue)
    }

    private func loadQueue() -> [QueuedEvent] {
        guard let data = AttendanceStore.defaults.data(forKey: AttendanceStore.queueKey) else { return [] }
        return (try? JSONDecoder().decode([QueuedEvent].self, from: data)) ?? []
    }

    private func saveQueue(_ queue: [QueuedEvent]) {
        if let data = try? JSONEncoder().encode(queue) {
            AttendanceStore.defaults.set(data, forKey: AttendanceStore.queueKey)
        }
    }

    private func flushQueue() {
        lock.lock()
        if posting {
            lock.unlock()
            return
        }
        var queue = loadQueue()
        guard !queue.isEmpty else {
            lock.unlock()
            return
        }
        posting = true
        let next = queue.removeFirst()
        saveQueue(queue)
        lock.unlock()

        sendToEdge(next) { [weak self] ok, shouldRequeue, stopTracking, response in
            guard let self else { return }
            self.lock.lock()
            self.posting = false
            if shouldRequeue {
                var q = self.loadQueue()
                q.insert(next, at: 0)
                self.saveQueue(q)
            }
            self.lock.unlock()

            if stopTracking {
                DispatchQueue.main.async { self.stop(clearToken: true) }
                return
            }
            if ok {
                self.notifyIfClocked(response)
            }
            // Continue flushing
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.2) {
                self.flushQueue()
            }
        }
    }

    private func sendToEdge(
        _ event: QueuedEvent,
        completion: @escaping (_ ok: Bool, _ requeue: Bool, _ stop: Bool, _ json: [String: Any]?) -> Void
    ) {
        guard
            let base = AttendanceStore.supabaseUrl,
            let anon = AttendanceStore.anonKeyValue,
            let token = AttendanceKeychain.loadToken(),
            let url = URL(string: base + "/functions/v1/auto-attendance-event")
        else {
            completion(false, true, false, nil)
            return
        }

        let deviceNow = Int64(Date().timeIntervalSince1970 * 1000)
        var body: [String: Any] = [
            "device_token": token,
            "event": event.event,
            "occurred_at_utc_ms": event.occurredAtUtcMs,
            "device_now_utc_ms": deviceNow,
            "device_timezone": TimeZone.current.identifier,
            "is_mock": event.isMock,
            "platform": "ios",
        ]
        if let zoneId = event.zoneId { body["zone_id"] = zoneId }
        if let lat = event.lat { body["lat"] = lat }
        if let lng = event.lng { body["lng"] = lng }
        if let acc = event.accuracyM { body["accuracy_m"] = acc }
        if let ssid = event.ssid { body["ssid"] = ssid }
        if let bssid = event.bssid { body["bssid"] = bssid }
        if let deviceId = AttendanceKeychain.loadDeviceId() { body["device_id"] = deviceId }
        if let ver = AttendanceStore.appVersion { body["app_version"] = ver }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(anon, forHTTPHeaderField: "apikey")
        request.setValue(token, forHTTPHeaderField: "x-device-token")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 25

        URLSession.shared.dataTask(with: request) { data, response, error in
            if error != nil {
                completion(false, true, false, nil)
                return
            }
            let http = response as? HTTPURLResponse
            let json = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) }) as? [String: Any]
            let stop = (json?["stop_tracking"] as? Bool) == true
            let ok = (json?["ok"] as? Bool) == true
            if let code = http?.statusCode, code >= 500 {
                completion(false, true, stop, json)
                return
            }
            // 4xx with stop_tracking → do not requeue
            completion(ok, false, stop, json)
        }.resume()
    }

    // MARK: Local notifications (R43 / R44)

    private func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    private func notifyIfClocked(_ json: [String: Any]?) {
        guard let json else { return }
        let action = (json["action"] as? String) ?? ""
        guard action == "clock_in" || action == "clock_out" else { return }

        let occurredRaw = json["occurred_at"] as? String
        let occurred = parseDate(occurredRaw) ?? Date()
        let localFmt = DateFormatter()
        localFmt.timeZone = .current
        localFmt.dateStyle = .none
        localFmt.timeStyle = .short
        let officeFmt = DateFormatter()
        officeFmt.timeZone = TimeZone(identifier: AttendanceStore.companyTz) ?? .current
        officeFmt.dateStyle = .none
        officeFmt.timeStyle = .short

        let localTime = localFmt.string(from: occurred)
        let officeTime = officeFmt.string(from: occurred)
        let title = action == "clock_in" ? "Checked in" : "Checked out"
        let body = "Local \(localTime) · Office \(officeTime) (\(AttendanceStore.companyTz))"

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default

        let req = UNNotificationRequest(
            identifier: "scorr-att-\(action)-\(Int(occurred.timeIntervalSince1970))",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
    }
}
