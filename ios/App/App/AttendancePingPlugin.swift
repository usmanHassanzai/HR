import BackgroundTasks
import Capacitor
import CoreLocation
import Foundation
import Network
import NetworkExtension
import UserNotifications

private let kBgAppRefreshTaskId = "ai.walfia.scorr.attendance.refresh"

// MARK: - Capacitor bridge (R44 / R71)
//
// Region monitoring + significant-location-change + NWPathMonitor (no 30–60s
// background polling — iOS limit). Device token lives in Keychain (never
// expires). Server decides the attendance window — clients never drop events
// for being outside W. Wi-Fi SSID/BSSID via NEHotspotNetwork.fetchCurrent when
// entitled; otherwise the edge function uses the request public IP.

@objc(AttendancePingPlugin)
public class AttendancePingPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AttendancePingPlugin"
    public let jsName = "AttendancePing"
    public let pluginMethods: [CAPPluginMethod] = [
        .init(name: "startAutoAttendance", returnType: CAPPluginReturnPromise),
        .init(name: "stopAutoAttendance", returnType: CAPPluginReturnPromise),
        .init(name: "syncSchedule", returnType: CAPPluginReturnPromise),
        .init(name: "saveLoginCredentials", returnType: CAPPluginReturnPromise),
        .init(name: "loadLoginCredentials", returnType: CAPPluginReturnPromise),
        .init(name: "clearLoginCredentials", returnType: CAPPluginReturnPromise),
        .init(name: "saveTrustedDeviceToken", returnType: CAPPluginReturnPromise),
        .init(name: "loadTrustedDeviceToken", returnType: CAPPluginReturnPromise),
        .init(name: "clearTrustedDeviceToken", returnType: CAPPluginReturnPromise),
        .init(name: "openAppSettings", returnType: CAPPluginReturnPromise),
        .init(name: "openBatterySettings", returnType: CAPPluginReturnPromise),
        .init(name: "openNotificationSettings", returnType: CAPPluginReturnPromise),
        .init(name: "getPermissionSnapshot", returnType: CAPPluginReturnPromise),
        .init(name: "requestNotifications", returnType: CAPPluginReturnPromise),
        .init(name: "requestAlwaysLocation", returnType: CAPPluginReturnPromise),
        .init(name: "probeNetwork", returnType: CAPPluginReturnPromise),
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

    @objc func saveLoginCredentials(_ call: CAPPluginCall) {
        guard
            let email = call.getString("email"), !email.isEmpty,
            let password = call.getString("password"), !password.isEmpty
        else {
            call.reject("Missing email or password")
            return
        }
        AttendanceKeychain.saveLoginEmail(email.trimmingCharacters(in: .whitespacesAndNewlines))
        AttendanceKeychain.saveLoginPassword(password)
        call.resolve(["ok": true])
    }

    @objc func loadLoginCredentials(_ call: CAPPluginCall) {
        call.resolve([
            "email": AttendanceKeychain.loadLoginEmail() ?? "",
            "password": AttendanceKeychain.loadLoginPassword() ?? "",
        ])
    }

    @objc func clearLoginCredentials(_ call: CAPPluginCall) {
        AttendanceKeychain.clearLoginCredentials()
        call.resolve(["ok": true])
    }

    @objc func saveTrustedDeviceToken(_ call: CAPPluginCall) {
        guard let token = call.getString("token"), !token.isEmpty else {
            call.reject("Missing token")
            return
        }
        AttendanceKeychain.saveTrustedDeviceToken(token)
        call.resolve(["ok": true])
    }

    @objc func loadTrustedDeviceToken(_ call: CAPPluginCall) {
        call.resolve(["token": AttendanceKeychain.loadTrustedDeviceToken() ?? ""])
    }

    @objc func clearTrustedDeviceToken(_ call: CAPPluginCall) {
        AttendanceKeychain.clearTrustedDeviceToken()
        call.resolve(["ok": true])
    }

    @objc func openAppSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
            }
            call.resolve(["ok": true])
        }
    }

    @objc func openBatterySettings(_ call: CAPPluginCall) {
        openAppSettings(call)
    }

    @objc func openNotificationSettings(_ call: CAPPluginCall) {
        openAppSettings(call)
    }

    @objc func getPermissionSnapshot(_ call: CAPPluginCall) {
        let mgr = CLLocationManager()
        let status = mgr.authorizationStatus
        let loc: String
        let bg: String
        switch status {
        case .authorizedAlways:
            loc = "granted"; bg = "granted"
        case .authorizedWhenInUse:
            loc = "granted"; bg = "denied"
        case .denied, .restricted:
            loc = "denied"; bg = "denied"
        default:
            loc = "prompt"; bg = "prompt"
        }
        var precise = true
        if #available(iOS 14.0, *) {
            precise = mgr.accuracyAuthorization == .fullAccuracy
        }
        let refresh: String
        switch UIApplication.shared.backgroundRefreshStatus {
        case .available: refresh = "on"
        case .denied: refresh = "off"
        case .restricted: refresh = "off"
        @unknown default: refresh = "off"
        }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            var notif = "prompt"
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral: notif = "granted"
            case .denied: notif = "denied"
            default: notif = "prompt"
            }
            call.resolve([
                "location": loc,
                "backgroundLocation": bg,
                "precise": precise,
                "backgroundAppRefresh": refresh,
                "locationServicesEnabled": CLLocationManager.locationServicesEnabled(),
                "notifications": notif,
                "batteryUnrestricted": true,
                "manufacturer": "Apple",
                "authorization": status == .authorizedWhenInUse ? "when_in_use" : (status == .authorizedAlways ? "always" : loc),
            ])
        }
    }

    @objc func requestNotifications(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            call.resolve(["status": granted ? "granted" : "denied"])
        }
    }

    /// Wizard step: escalate When-In-Use → Always (iOS shows the Always prompt after When-In-Use).
    @objc func requestAlwaysLocation(_ call: CAPPluginCall) {
        engine.requestAlwaysAuthorizationForSetup { status in
            let loc: String
            let bg: String
            let overall: String
            switch status {
            case .authorizedAlways:
                loc = "granted"; bg = "granted"; overall = "granted"
            case .authorizedWhenInUse:
                loc = "granted"; bg = "denied"; overall = "when_in_use"
            case .denied, .restricted:
                loc = "denied"; bg = "denied"; overall = "denied"
            default:
                loc = "prompt"; bg = "prompt"; overall = "prompt"
            }
            call.resolve([
                "status": overall,
                "location": loc,
                "backgroundLocation": bg,
            ])
        }
    }

    @objc func probeNetwork(_ call: CAPPluginCall) {
        if #available(iOS 14.0, *) {
            NEHotspotNetwork.fetchCurrent { network in
                let ssid = network?.ssid ?? ""
                let bssid = network?.bssid ?? ""
                if !ssid.isEmpty || !bssid.isEmpty {
                    AttendanceAutoEngine.shared.rememberWifi(ssid: ssid.isEmpty ? nil : ssid, bssid: bssid.isEmpty ? nil : bssid)
                }
                call.resolve([
                    "ssid": ssid,
                    "bssid": bssid,
                ])
            }
        } else {
            call.resolve(["ssid": "", "bssid": ""])
        }
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
    private static let loginEmailAccount = "login_email"
    private static let loginPasswordAccount = "login_password"
    private static let trustedDeviceTokenAccount = "trusted_device_token"

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

    static func saveLoginEmail(_ email: String) {
        save(account: loginEmailAccount, value: email)
    }

    static func saveLoginPassword(_ password: String) {
        save(account: loginPasswordAccount, value: password)
    }

    static func loadLoginEmail() -> String? {
        load(account: loginEmailAccount)
    }

    static func loadLoginPassword() -> String? {
        load(account: loginPasswordAccount)
    }

    static func clearLoginCredentials() {
        delete(account: loginEmailAccount)
        delete(account: loginPasswordAccount)
    }

    static func saveTrustedDeviceToken(_ token: String) {
        save(account: trustedDeviceTokenAccount, value: token)
    }

    static func loadTrustedDeviceToken() -> String? {
        load(account: trustedDeviceTokenAccount)
    }

    static func clearTrustedDeviceToken() {
        delete(account: trustedDeviceTokenAccount)
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
    static let officeVersionKey = "scorr_att_office_version"
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

    static var officeVersion: Int64 {
        get { Int64(defaults.integer(forKey: officeVersionKey)) }
        set { defaults.set(Int(newValue), forKey: officeVersionKey) }
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
    let office_version: Int64?
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
    let office_version: Int64?
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
    /// false when location off/unavailable; omit GPS fields when false.
    let gpsAvailable: Bool?
    let locationFixUtcMs: Int64?
    let preciseLocation: Bool?

    init(
        event: String,
        zoneId: String?,
        lat: Double?,
        lng: Double?,
        accuracyM: Double?,
        ssid: String?,
        bssid: String?,
        occurredAtUtcMs: Int64,
        isMock: Bool,
        gpsAvailable: Bool? = nil,
        locationFixUtcMs: Int64? = nil,
        preciseLocation: Bool? = nil
    ) {
        self.event = event
        self.zoneId = zoneId
        self.lat = lat
        self.lng = lng
        self.accuracyM = accuracyM
        self.ssid = ssid
        self.bssid = bssid
        self.occurredAtUtcMs = occurredAtUtcMs
        self.isMock = isMock
        self.locationFixUtcMs = locationFixUtcMs
        self.preciseLocation = preciseLocation
        if let gpsAvailable {
            self.gpsAvailable = gpsAvailable
        } else {
            self.gpsAvailable = lat != nil && lng != nil
        }
    }
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
    /// Last SSID/BSSID seen (R69 EXIT fallback when fetchCurrent is empty mid-transition).
    private var lastSsid: String?
    private var lastBssid: String?
    private var alwaysAuthCompletions: [(CLAuthorizationStatus) -> Void] = []
    private var pathMonitor: NWPathMonitor?
    private var lastPathSatisfied: Bool?
    private var lastNetworkCheckAt = Date.distantPast
    private var pendingNetworkDeadline: DispatchWorkItem?
    private var pendingNetworkSsid: String?
    private var pendingNetworkBssid: String?
    private var exitRetryAttempt = 0
    private var exitRetryBest: CLLocation?
    private var exitRetryDeadline: DispatchWorkItem?
    private var wifiRetryWork: DispatchWorkItem?

    private static func isHardStopReason(_ reason: String) -> Bool {
        switch reason {
        case "missing_token", "invalid_token", "revoked_token",
             "user_gone", "feature_off", "work_mode_remote":
            return true
        default:
            return false
        }
    }

    private func scheduleWifiRetryLoop() {
        cancelWifiRetryLoop()
        let work = DispatchWorkItem { [weak self] in
            guard let self, AttendanceStore.enabled else { return }
            self.sendNetworkTriggeredCheck()
            self.scheduleWifiRetryLoop()
        }
        wifiRetryWork = work
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 30, execute: work)
    }

    private func cancelWifiRetryLoop() {
        wifiRetryWork?.cancel()
        wifiRetryWork = nil
    }

    private override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.allowsBackgroundLocationUpdates = true
        manager.pausesLocationUpdatesAutomatically = false
        if #available(iOS 11.0, *) {
            manager.showsBackgroundLocationIndicator = false
        }
        if let data = AttendanceStore.loadScheduleJSON() {
            schedule = try? JSONDecoder().decode(AttendanceSchedule.self, from: data)
        }
        lastSsid = AttendanceStore.defaults.string(forKey: "scorr_att_last_ssid")
        lastBssid = AttendanceStore.defaults.string(forKey: "scorr_att_last_bssid")
        requestNotificationPermission()
    }

    func rememberWifi(ssid: String?, bssid: String?) {
        if let ssid, !ssid.isEmpty {
            lastSsid = ssid
            AttendanceStore.defaults.set(ssid, forKey: "scorr_att_last_ssid")
        }
        if let bssid, !bssid.isEmpty {
            lastBssid = bssid
            AttendanceStore.defaults.set(bssid, forKey: "scorr_att_last_bssid")
        }
    }

    func requestAlwaysAuthorizationForSetup(completion: @escaping (CLAuthorizationStatus) -> Void) {
        let status = manager.authorizationStatus
        if status == .authorizedAlways {
            completion(status)
            return
        }
        alwaysAuthCompletions.append(completion)
        if status == .notDetermined {
            manager.requestWhenInUseAuthorization()
        } else {
            manager.requestAlwaysAuthorization()
        }
    }

    /// Resume after process launch if auto attendance was enabled.
    func resumeIfNeeded() {
        guard AttendanceStore.enabled, AttendanceKeychain.loadToken() != nil else { return }
        ensureAlwaysAuthorization()
        // Re-arm from cached schedule after reboot / app update even if fetch fails.
        applyMonitoringFromSchedule()
        startPathMonitor()
        flushQueue()
        syncSchedule { _ in }
    }

    /// True when a device token is enrolled for auto attendance.
    var isEnrolled: Bool {
        AttendanceKeychain.loadToken() != nil && AttendanceStore.enabled
    }

    /// Foreground / time-change hook (R34).
    func syncIfEnrolled() {
        guard isEnrolled else { return }
        syncSchedule { _ in }
        // App open / become-active: fresh presence check (network + location).
        sendPresenceCheck(reason: "app_open")
        AttendanceAutoEngine.scheduleBgAppRefresh()
    }

    /// Fresh check: network info + location (or gps_available=false).
    func sendPresenceCheck(reason: String) {
        guard isEnrolled else { return }
        flushQueue()
        NEHotspotNetwork.fetchCurrent { [weak self] network in
            guard let self else { return }
            let ssid = network?.ssid
            let bssid = network?.bssid
            self.rememberWifi(ssid: ssid, bssid: bssid)
            let status = self.manager.authorizationStatus
            let locOk = status == .authorizedAlways || status == .authorizedWhenInUse
            if locOk && CLLocationManager.locationServicesEnabled() {
                self.pendingNetworkSsid = ssid ?? self.lastSsid
                self.pendingNetworkBssid = bssid ?? self.lastBssid
                self.manager.desiredAccuracy = kCLLocationAccuracyBest
                if #available(iOS 14.0, *) {
                    // Prefer full accuracy when available.
                }
                self.manager.requestLocation()
                let work = DispatchWorkItem { [weak self] in
                    self?.finishPendingNetwork(loc: nil)
                }
                self.pendingNetworkDeadline?.cancel()
                self.pendingNetworkDeadline = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
            } else {
                self.postWifiOnlyPing(ssid: ssid ?? self.lastSsid, bssid: bssid ?? self.lastBssid)
            }
            NSLog("[scorr-att] presence check reason=%@", reason)
        }
    }

    static func registerBgAppRefresh() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: kBgAppRefreshTaskId, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            scheduleBgAppRefresh()
            refresh.expirationHandler = {
                refresh.setTaskCompleted(success: false)
            }
            AttendanceAutoEngine.shared.sendPresenceCheck(reason: "bg_app_refresh")
            // Give the network/location request a short window, then complete.
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 8) {
                refresh.setTaskCompleted(success: true)
            }
        }
    }

    static func scheduleBgAppRefresh() {
        let req = BGAppRefreshTaskRequest(identifier: kBgAppRefreshTaskId)
        req.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do {
            try BGTaskScheduler.shared.submit(req)
        } catch {
            NSLog("[scorr-att] BGAppRefresh schedule failed: %@", error.localizedDescription)
        }
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
        startPathMonitor()
        // Arm from cache first (reboot / offline), then refresh schedule.
        applyMonitoringFromSchedule()
        syncSchedule { result in
            switch result {
            case .success:
                completion(.success(()))
            case .failure:
                // Token enrolled; cache regions already armed — do not fail enrollment.
                completion(.success(()))
            }
        }
    }

    func stop(clearToken: Bool) {
        stopPathMonitor()
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
            DispatchQueue.main.async {
                self.applyMonitoringFromSchedule()
                completion(.failure(NSError(domain: "ScorrAttendance", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "Missing credentials or device token",
                ])))
            }
            return
        }

        guard let url = URL(string: base + "/functions/v1/attendance-schedule") else {
            DispatchQueue.main.async {
                self.applyMonitoringFromSchedule()
                completion(.failure(NSError(domain: "ScorrAttendance", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: "Invalid supabaseUrl",
                ])))
            }
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
                DispatchQueue.main.async {
                    // Schedule fetch failed — keep regions from cache.
                    self.applyMonitoringFromSchedule()
                    self.startPathMonitor()
                    self.flushQueue()
                    completion(.failure(error))
                }
                return
            }
            guard let data else {
                DispatchQueue.main.async {
                    self.applyMonitoringFromSchedule()
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
                        let reason = decoded.reason ?? "schedule_error"
                        // Only clear enrollment for hard failures — never after check-out / outside_window.
                        if decoded.stop_tracking == true && Self.isHardStopReason(reason) {
                            self.stop(clearToken: true)
                        } else {
                            // Pause regions for this window; keep token + network monitor for next shift.
                            self.stopAllMonitoring()
                            self.startPathMonitor()
                        }
                        completion(.success([
                            "ok": false,
                            "reason": reason,
                            "stop_tracking": decoded.stop_tracking ?? false,
                        ]))
                    }
                    return
                }

                let prevVer = AttendanceStore.officeVersion
                let nextVer = decoded.office_version
                    ?? decoded.zones?.compactMap(\.office_version).max()
                    ?? 0
                self.lock.lock()
                self.schedule = decoded
                self.lock.unlock()
                AttendanceStore.saveScheduleJSON(data)
                AttendanceStore.officeVersion = nextVer
                if let companyTz = decoded.company_tz {
                    AttendanceStore.companyTz = companyTz
                }
                if let serverNow = self.parseDate(decoded.server_now_utc) {
                    let skew = Int64(Date().timeIntervalSince(serverNow) * 1000)
                    AttendanceStore.skewMs = skew
                }

                DispatchQueue.main.async {
                    // Always re-apply regions so radius/pin changes take effect.
                    self.applyMonitoringFromSchedule()
                    self.startPathMonitor()
                    self.flushQueue()
                    let upcoming = self.upcomingWindows().count
                    let monitoring = !self.regionIds.isEmpty
                    completion(.success([
                        "ok": true,
                        "windows": upcoming,
                        "zones": decoded.zones?.count ?? 0,
                        "monitoring": monitoring,
                        "company_tz": AttendanceStore.companyTz,
                        "office_version": nextVer,
                        "office_version_changed": nextVer > 0 && nextVer != prevVer,
                    ]))
                }
            } catch {
                DispatchQueue.main.async {
                    self.applyMonitoringFromSchedule()
                    completion(.failure(error))
                }
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
        guard let zones = schedule?.zones, !zones.isEmpty else {
            // Keep significant-change + network triggers even without zone cache.
            let status = manager.authorizationStatus
            if status == .authorizedAlways || status == .authorizedWhenInUse {
                manager.startMonitoringSignificantLocationChanges()
            }
            startPathMonitor()
            return
        }
        if upcoming.isEmpty {
            // No upcoming windows — keep network monitor; drop region fences until next schedule.
            for region in manager.monitoredRegions {
                manager.stopMonitoring(for: region)
            }
            regionIds.removeAll()
            startPathMonitor()
            return
        }

        let status = manager.authorizationStatus
        guard status == .authorizedAlways || status == .authorizedWhenInUse else {
            startPathMonitor()
            return
        }
        // Backup trigger when region monitoring is delayed (background).
        manager.startMonitoringSignificantLocationChanges()
        startPathMonitor()

        var nextIds = Set<String>()
        for zone in zones {
            guard
                let id = zone.zone_id,
                let lat = zone.latitude,
                let lng = zone.longitude
            else { continue }
            let saved = zone.radius_meters ?? 150
            let cap = manager.maximumRegionMonitoringDistance
            let radius = min(max(saved, 1), cap > 0 ? cap : saved)
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
        exitRetryDeadline?.cancel()
        exitRetryDeadline = nil
        pendingNetworkDeadline?.cancel()
        pendingNetworkDeadline = nil
        pendingExitZoneId = nil
        pendingEnterZoneId = nil
        for region in manager.monitoredRegions {
            manager.stopMonitoring(for: region)
        }
        manager.stopMonitoringSignificantLocationChanges()
        regionIds.removeAll()
    }

    private func startPathMonitor() {
        guard AttendanceStore.enabled else { return }
        if pathMonitor != nil { return }
        let mon = NWPathMonitor()
        pathMonitor = mon
        mon.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let satisfied = path.status == .satisfied
            let prev = self.lastPathSatisfied
            self.lastPathSatisfied = satisfied
            if !satisfied {
                // Wi-Fi and cellular both unavailable — exact disconnect time.
                if prev != false {
                    DispatchQueue.main.async { self.saveConnectionLost() }
                }
                return
            }
            // First observation, or transition from unsatisfied → satisfied, or Wi-Fi path.
            let becameAvailable = prev == false
            let wifi = path.usesInterfaceType(.wifi)
            if becameAvailable || wifi {
                DispatchQueue.main.async {
                    self.flushQueue()
                    self.sendNetworkTriggeredCheck()
                }
            }
        }
        mon.start(queue: DispatchQueue.global(qos: .utility))
    }

    private func stopPathMonitor() {
        pathMonitor?.cancel()
        pathMonitor = nil
        lastPathSatisfied = nil
    }

    /// Network change / Wi-Fi connect: fresh GPS+Wi-Fi in one event, or Wi-Fi-only if GPS unavailable.
    private func sendNetworkTriggeredCheck() {
        guard AttendanceStore.enabled else { return }
        let now = Date()
        if now.timeIntervalSince(lastNetworkCheckAt) < 30 { return }
        lastNetworkCheckAt = now

        let status = manager.authorizationStatus
        let servicesOn = CLLocationManager.locationServicesEnabled()
        if !servicesOn || status == .denied || status == .restricted {
            fetchWifi(preferCachedFallback: true) { [weak self] ssid, bssid in
                guard let self else { return }
                self.postWifiOnlyPing(ssid: ssid, bssid: bssid)
            }
            return
        }

        pendingNetworkDeadline?.cancel()
        fetchWifi(preferCachedFallback: true) { [weak self] ssid, bssid in
            guard let self else { return }
            self.pendingNetworkSsid = ssid
            self.pendingNetworkBssid = bssid
            self.manager.desiredAccuracy = kCLLocationAccuracyBest
            self.manager.requestLocation()
            let work = DispatchWorkItem { [weak self] in
                self?.finishPendingNetwork(loc: nil)
            }
            self.pendingNetworkDeadline = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
        }
    }

    private func finishPendingNetwork(loc: CLLocation?) {
        // Only finish once per pending network check.
        let wasPending = pendingNetworkDeadline != nil || pendingNetworkSsid != nil || pendingNetworkBssid != nil
        guard wasPending || loc != nil else { return }
        pendingNetworkDeadline?.cancel()
        pendingNetworkDeadline = nil
        let ssid = pendingNetworkSsid
        let bssid = pendingNetworkBssid
        pendingNetworkSsid = nil
        pendingNetworkBssid = nil
        let checkout = checkoutUsableLocation(loc)
        let acc = loc?.horizontalAccuracy ?? -1
        // Still send a reading for presence when accuracy <= 100, but mark
        // non-checkout-usable fixes so the edge strips them for Rule 5.
        let presenceOk = loc != nil && acc >= 0 && acc <= 100
        if let loc, presenceOk {
            let simulated: Bool
            if #available(iOS 15.0, *) {
                simulated = loc.sourceInformation?.isSimulatedBySoftware == true
            } else {
                simulated = false
            }
            if simulated { return }
            let sendGps = checkout.ok
            postEvent(QueuedEvent(
                event: "ping",
                zoneId: regionIds.first,
                lat: sendGps ? loc.coordinate.latitude : nil,
                lng: sendGps ? loc.coordinate.longitude : nil,
                accuracyM: sendGps ? acc : nil,
                ssid: ssid,
                bssid: bssid,
                occurredAtUtcMs: Self.freshOccurredMs(for: loc),
                isMock: false,
                gpsAvailable: sendGps,
                locationFixUtcMs: checkout.fixMs,
                preciseLocation: isPreciseLocationOn()
            ))
        } else {
            postWifiOnlyPing(ssid: ssid, bssid: bssid)
        }
    }

    private func postWifiOnlyPing(ssid: String?, bssid: String?) {
        postEvent(QueuedEvent(
            event: "ping",
            zoneId: regionIds.first,
            lat: nil,
            lng: nil,
            accuracyM: nil,
            ssid: ssid,
            bssid: bssid,
            occurredAtUtcMs: Self.freshOccurredMs(for: nil),
            isMock: false,
            gpsAvailable: false
        ))
    }

    private func saveConnectionLost() {
        guard AttendanceStore.enabled else { return }
        postEvent(QueuedEvent(
            event: "connection_lost",
            zoneId: nil,
            lat: nil,
            lng: nil,
            accuracyM: nil,
            ssid: nil,
            bssid: nil,
            occurredAtUtcMs: Self.freshOccurredMs(for: nil),
            isMock: false,
            gpsAvailable: false
        ))
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
        let status = manager.authorizationStatus
        if status == .authorizedWhenInUse && !alwaysAuthCompletions.isEmpty {
            // Escalate to Always after When-In-Use for the setup wizard.
            manager.requestAlwaysAuthorization()
            return
        }
        if !alwaysAuthCompletions.isEmpty {
            let pending = alwaysAuthCompletions
            alwaysAuthCompletions.removeAll()
            for cb in pending { cb(status) }
        }
        if status == .authorizedAlways || status == .authorizedWhenInUse {
            applyMonitoringFromSchedule()
        }
    }

    func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        handleRegionEvent(region: region, event: "enter")
    }

    func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        // R69: EXIT must attach Wi-Fi promptly so the server can confirm leave vs GPS drift.
        handleRegionEvent(region: region, event: "exit", prioritizeWifi: true)
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

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        // Pending network-triggered check (≤3s GPS, else Wi-Fi-only).
        if pendingNetworkDeadline != nil {
            if loc.horizontalAccuracy >= 0 && loc.horizontalAccuracy <= 100 {
                finishPendingNetwork(loc: loc)
            }
            return
        }
        // Pending ENTER: usable fix within 3s window → send with GPS.
        if pendingEnterZoneId != nil {
            if loc.horizontalAccuracy >= 0 && loc.horizontalAccuracy <= 100 {
                finishPendingEnter(loc: loc)
            }
            return
        }
        // Pending EXIT: up to 3 fresh readings within ~15s until accuracy ≤ 50 m.
        if pendingExitZoneId != nil {
            handleExitLocationUpdate(loc)
            return
        }
        // Significant-location-change backup: wake + send GPS+Wi-Fi check.
        guard AttendanceStore.enabled else { return }
        let age = Date().timeIntervalSince(loc.timestamp)
        guard age < 120, loc.horizontalAccuracy >= 0, loc.horizontalAccuracy <= 100 else {
            // Unusable fix: Wi-Fi-only (debounced) so office Wi-Fi check-in still works.
            if age < 120, Date().timeIntervalSince(lastNetworkCheckAt) >= 30 {
                lastNetworkCheckAt = Date()
                fetchWifi(preferCachedFallback: true) { [weak self] ssid, bssid in
                    self?.postWifiOnlyPing(ssid: ssid, bssid: bssid)
                }
            }
            return
        }
        fetchWifi(preferCachedFallback: true) { [weak self] ssid, bssid in
            guard let self else { return }
            let simulated: Bool
            if #available(iOS 15.0, *) {
                simulated = loc.sourceInformation?.isSimulatedBySoftware == true
            } else {
                simulated = false
            }
            if simulated { return }
            let payload = QueuedEvent(
                event: "ping",
                zoneId: self.regionIds.first,
                lat: loc.coordinate.latitude,
                lng: loc.coordinate.longitude,
                accuracyM: loc.horizontalAccuracy,
                ssid: ssid,
                bssid: bssid,
                occurredAtUtcMs: Self.freshOccurredMs(for: loc),
                isMock: false,
                gpsAvailable: true
            )
            self.postEvent(payload)
        }
    }

    /// Prefer device now when CoreLocation fix timestamp is stale (avoids event_too_old).
    private static func freshOccurredMs(for loc: CLLocation?) -> Int64 {
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        guard let loc else { return nowMs }
        let t = Int64(loc.timestamp.timeIntervalSince1970 * 1000)
        let age = nowMs - t
        if age > 2 * 60 * 1000 || age < -60 * 1000 { return nowMs }
        return nowMs // event time is always fresh; location_fix_utc_ms carries the fix age
    }

    private func isPreciseLocationOn() -> Bool {
        if #available(iOS 14.0, *) {
            return manager.accuracyAuthorization == .fullAccuracy
        }
        return true
    }

    /// GPS usable for Rule 5 check-out: fresh (<=60s), precise, accuracy <= 50 m.
    private func checkoutUsableLocation(_ loc: CLLocation?) -> (ok: Bool, fixMs: Int64?) {
        guard let loc else { return (false, nil) }
        let fixMs = Int64(loc.timestamp.timeIntervalSince1970 * 1000)
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        let age = nowMs - fixMs
        if age > 60_000 || age < -60_000 { return (false, fixMs) }
        if !isPreciseLocationOn() { return (false, fixMs) }
        let acc = loc.horizontalAccuracy
        if acc < 0 || acc > 50 { return (false, fixMs) }
        return (true, fixMs)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if pendingNetworkDeadline != nil {
            finishPendingNetwork(loc: nil)
            return
        }
        if pendingEnterZoneId != nil {
            finishPendingEnter(loc: nil)
            return
        }
        if pendingExitZoneId != nil {
            // Keep retrying until the 3-attempt budget is spent.
            scheduleNextExitRetry()
        }
    }

    func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
        NSLog("Scorr attendance region fail %@: %@", region?.identifier ?? "?", error.localizedDescription)
    }

    private var lastEnterSentAt: [String: Date] = [:]
    private var lastExitSentAt: [String: Date] = [:]
    private var pendingExitZoneId: String?
    private var pendingExitSsid: String?
    private var pendingExitBssid: String?
    private var pendingEnterZoneId: String?
    private var pendingEnterSsid: String?
    private var pendingEnterBssid: String?
    private var pendingEnterDeadline: DispatchWorkItem?

    private func handleRegionEvent(region: CLRegion, event: String, prioritizeWifi: Bool = false) {
        // Server decides the attendance window — never drop ENTER/EXIT locally.
        guard AttendanceStore.enabled else { return }

        // Debounce requestState-driven enter storms (sync re-arms).
        if event == "enter" {
            let last = lastEnterSentAt[region.identifier] ?? .distantPast
            if Date().timeIntervalSince(last) < 60 {
                return
            }
            lastEnterSentAt[region.identifier] = Date()
        }
        // R69: allow EXIT promptly; light debounce only against duplicate wakes.
        if event == "exit" {
            let last = lastExitSentAt[region.identifier] ?? .distantPast
            if Date().timeIntervalSince(last) < 8 {
                return
            }
            lastExitSentAt[region.identifier] = Date()
        }

        let loc = manager.location
        if event == "exit" {
            let acc = loc?.horizontalAccuracy ?? -1
            if acc < 0 || acc > 50 {
                fetchWifi(preferCachedFallback: true) { [weak self] ssid, bssid in
                    guard let self else { return }
                    self.beginExitWithRetries(
                        zoneId: region.identifier,
                        ssid: ssid,
                        bssid: bssid,
                        seed: loc
                    )
                }
                return
            }
        }

        // Check-in: wait ≤3s for usable GPS, else send Wi-Fi-only (gps_available=false).
        if event == "enter" {
            let acc = loc?.horizontalAccuracy ?? -1
            let usable = loc != nil && acc >= 0 && acc <= 100
            if !usable {
                pendingEnterDeadline?.cancel()
                pendingEnterZoneId = region.identifier
                manager.desiredAccuracy = kCLLocationAccuracyBest
                fetchWifi(preferCachedFallback: true) { [weak self] ssid, bssid in
                    guard let self else { return }
                    self.pendingEnterSsid = ssid
                    self.pendingEnterBssid = bssid
                    self.manager.requestLocation()
                    let work = DispatchWorkItem { [weak self] in
                        self?.finishPendingEnter(loc: nil)
                    }
                    self.pendingEnterDeadline = work
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
                }
                return
            }
        }

        let isMock: Bool
        if #available(iOS 15.0, *) {
            isMock = loc?.sourceInformation?.isSimulatedBySoftware == true
        } else {
            isMock = false
        }

        let finish: (String?, String?) -> Void = { [weak self] ssid, bssid in
            guard let self else { return }
            let hasGps = loc != nil && (loc?.horizontalAccuracy ?? -1) >= 0
            let payload = QueuedEvent(
                event: event,
                zoneId: region.identifier,
                lat: hasGps ? loc?.coordinate.latitude : nil,
                lng: hasGps ? loc?.coordinate.longitude : nil,
                accuracyM: hasGps ? loc.flatMap { $0.horizontalAccuracy > 0 ? $0.horizontalAccuracy : nil } : nil,
                ssid: ssid,
                bssid: bssid,
                occurredAtUtcMs: Self.freshOccurredMs(for: loc),
                isMock: isMock,
                gpsAvailable: hasGps
            )
            self.postEvent(payload)
        }

        // R69 EXIT: read Wi-Fi immediately; fall back to last known if fetch is empty.
        fetchWifi(preferCachedFallback: prioritizeWifi) { ssid, bssid in
            finish(ssid, bssid)
        }
    }

    private func finishPendingEnter(loc: CLLocation?) {
        guard let zoneId = pendingEnterZoneId else { return }
        pendingEnterDeadline?.cancel()
        pendingEnterDeadline = nil
        pendingEnterZoneId = nil
        let ssid = pendingEnterSsid
        let bssid = pendingEnterBssid
        pendingEnterSsid = nil
        pendingEnterBssid = nil
        let acc = loc?.horizontalAccuracy ?? -1
        let usable = loc != nil && acc >= 0 && acc <= 100
        let simulated: Bool
        if #available(iOS 15.0, *), let loc {
            simulated = loc.sourceInformation?.isSimulatedBySoftware == true
        } else {
            simulated = false
        }
        if simulated {
            return
        }
        let payload = QueuedEvent(
            event: "enter",
            zoneId: zoneId,
            lat: usable ? loc?.coordinate.latitude : nil,
            lng: usable ? loc?.coordinate.longitude : nil,
            accuracyM: usable ? acc : nil,
            ssid: ssid,
            bssid: bssid,
            occurredAtUtcMs: Self.freshOccurredMs(for: usable ? loc : nil),
            isMock: false,
            gpsAvailable: usable
        )
        postEvent(payload)
    }

    /// EXIT: up to 3 fresh readings within ~15s until accuracy ≤ 50 m (Android parity).
    private func beginExitWithRetries(zoneId: String, ssid: String?, bssid: String?, seed: CLLocation?) {
        pendingExitZoneId = zoneId
        pendingExitSsid = ssid
        pendingExitBssid = bssid
        exitRetryAttempt = 0
        exitRetryBest = nil
        if let seed, seed.horizontalAccuracy >= 0 {
            exitRetryBest = seed
            if seed.horizontalAccuracy <= 50 {
                finishExit(loc: seed)
                return
            }
        }
        scheduleNextExitRetry()
    }

    private func scheduleNextExitRetry() {
        guard pendingExitZoneId != nil else { return }
        exitRetryDeadline?.cancel()
        if exitRetryAttempt >= 3 {
            finishExit(loc: exitRetryBest)
            return
        }
        exitRetryAttempt += 1
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.requestLocation()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if self.pendingExitZoneId == nil { return }
            if self.exitRetryAttempt >= 3 {
                self.finishExit(loc: self.exitRetryBest)
            } else {
                self.scheduleNextExitRetry()
            }
        }
        exitRetryDeadline = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: work)
    }

    private func handleExitLocationUpdate(_ loc: CLLocation) {
        if loc.horizontalAccuracy < 0 { return }
        let simulated: Bool
        if #available(iOS 15.0, *) {
            simulated = loc.sourceInformation?.isSimulatedBySoftware == true
        } else {
            simulated = false
        }
        if simulated { return }
        if exitRetryBest == nil || loc.horizontalAccuracy < (exitRetryBest?.horizontalAccuracy ?? .greatestFiniteMagnitude) {
            exitRetryBest = loc
        }
        if loc.horizontalAccuracy <= 50 {
            finishExit(loc: loc)
            return
        }
        // Wait for next retry step / deadline.
    }

    private func finishExit(loc: CLLocation?) {
        guard let zoneId = pendingExitZoneId else { return }
        exitRetryDeadline?.cancel()
        exitRetryDeadline = nil
        pendingExitZoneId = nil
        let ssid = pendingExitSsid
        let bssid = pendingExitBssid
        pendingExitSsid = nil
        pendingExitBssid = nil
        exitRetryAttempt = 0
        let best = loc ?? exitRetryBest
        exitRetryBest = nil
        let checkout = checkoutUsableLocation(best)
        let acc = best?.horizontalAccuracy ?? -1
        // Only send GPS for EXIT check-out when fresh, precise, and ≤ 50 m.
        if checkout.ok, let best {
            postEvent(QueuedEvent(
                event: "exit",
                zoneId: zoneId,
                lat: best.coordinate.latitude,
                lng: best.coordinate.longitude,
                accuracyM: acc,
                ssid: ssid,
                bssid: bssid,
                occurredAtUtcMs: Self.freshOccurredMs(for: best),
                isMock: false,
                gpsAvailable: true,
                locationFixUtcMs: checkout.fixMs,
                preciseLocation: isPreciseLocationOn()
            ))
        } else {
            // Stale / imprecise / no GPS — Wi-Fi/IP only; do not false check-out.
            postEvent(QueuedEvent(
                event: "exit",
                zoneId: zoneId,
                lat: nil,
                lng: nil,
                accuracyM: nil,
                ssid: ssid,
                bssid: bssid,
                occurredAtUtcMs: Self.freshOccurredMs(for: nil),
                isMock: false,
                gpsAvailable: false,
                locationFixUtcMs: checkout.fixMs,
                preciseLocation: isPreciseLocationOn()
            ))
        }
    }

    // MARK: Wi-Fi supporting signal (R71)
    //
    // Requires Access WiFi Information entitlement + location permission.
    // Only callable while the app has execution time (e.g. region wake).
    // iOS cannot subscribe to Wi-Fi connect/disconnect in the background.

    private func fetchWifi(
        preferCachedFallback: Bool = false,
        completion: @escaping (_ ssid: String?, _ bssid: String?) -> Void
    ) {
        if #available(iOS 14.0, *) {
            NEHotspotNetwork.fetchCurrent { [weak self] network in
                let ssid = network?.ssid
                let bssid = network?.bssid
                if let self {
                    if let ssid, !ssid.isEmpty { self.rememberWifi(ssid: ssid, bssid: bssid) }
                    else if let bssid, !bssid.isEmpty { self.rememberWifi(ssid: nil, bssid: bssid) }
                    if preferCachedFallback, (ssid == nil || ssid?.isEmpty == true), (bssid == nil || bssid?.isEmpty == true) {
                        completion(self.lastSsid, self.lastBssid)
                        return
                    }
                }
                completion(ssid, bssid)
            }
        } else {
            completion(preferCachedFallback ? lastSsid : nil, preferCachedFallback ? lastBssid : nil)
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
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        let maxAge: Int64 = 10 * 60 * 1000
        var connectionLost: QueuedEvent?
        var fresh: [QueuedEvent] = []
        for ev in queue {
            if ev.event.lowercased() == "connection_lost" {
                if connectionLost == nil || ev.occurredAtUtcMs <= connectionLost!.occurredAtUtcMs {
                    connectionLost = ev
                }
                continue
            }
            let age = nowMs - ev.occurredAtUtcMs
            if age > maxAge {
                NSLog("[scorr-att] dropped stale event source=ios-queue event=%@ age_ms=%lld", ev.event, age)
                continue
            }
            fresh.append(ev)
        }
        // Keep only the newest fresh reading.
        fresh.sort { $0.occurredAtUtcMs > $1.occurredAtUtcMs }
        if fresh.count > 1 {
            for dropped in fresh.dropFirst() {
                NSLog("[scorr-att] dropped stale event source=ios-superseded event=%@ age_ms=%lld", dropped.event, nowMs - dropped.occurredAtUtcMs)
            }
            fresh = Array(fresh.prefix(1))
        }
        // Send connection_lost first, then newest reading.
        var ordered: [QueuedEvent] = []
        if let connectionLost { ordered.append(connectionLost) }
        ordered.append(contentsOf: fresh)
        saveQueue(ordered)
        guard let next = ordered.first else {
            lock.unlock()
            return
        }
        posting = true
        saveQueue(Array(ordered.dropFirst()))
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

            let action = (response?["action"] as? String) ?? ""
            let reason = (response?["reason"] as? String) ?? action
            if stopTracking && Self.isHardStopReason(reason) {
                DispatchQueue.main.async { self.stop(clearToken: true) }
                return
            }
            if ok {
                self.notifyIfClocked(response)
                self.applyOfficeVersionFromResponse(response)
            } else if let response {
                self.notifyIfClocked(response)
            }
            if action == "clock_out"
                || action == "not_on_office_wifi"
                || action == "not_on_office_network" {
                // Keep ENTER/EXIT regions + path monitor; retry return quickly.
                DispatchQueue.main.async {
                    self.applyMonitoringFromSchedule()
                    self.startPathMonitor()
                }
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1.5) {
                    self.sendNetworkTriggeredCheck()
                }
                // Inside radius but not on office Wi-Fi yet: retry every 30s.
                if action == "not_on_office_wifi" || action == "not_on_office_network" {
                    self.scheduleWifiRetryLoop()
                }
            }
            if action == "clock_in" {
                self.cancelWifiRetryLoop()
            }
            // Continue flushing
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.2) {
                self.flushQueue()
            }
        }
    }

    private func applyOfficeVersionFromResponse(_ json: [String: Any]?) {
        guard let json else { return }
        var next: Int64 = 0
        if let n = json["office_version"] as? Int64 { next = n }
        else if let n = json["office_version"] as? Int { next = Int64(n) }
        else if let n = json["office_version"] as? Double { next = Int64(n) }
        else if let zones = json["zones"] as? [[String: Any]] {
            for z in zones {
                if let n = z["office_version"] as? Int64 { next = max(next, n) }
                else if let n = z["office_version"] as? Int { next = max(next, Int64(n)) }
            }
        }
        guard next > 0 else { return }
        let prev = AttendanceStore.officeVersion
        if next != prev {
            AttendanceStore.officeVersion = next
            DispatchQueue.main.async {
                self.syncSchedule { _ in }
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
        // Always stamp a fresh device now; never send a stale GPS timestamp alone.
        let occurred = min(max(event.occurredAtUtcMs, deviceNow - 2 * 60 * 1000), deviceNow + 60 * 1000)
        var body: [String: Any] = [
            "device_token": token,
            "event": event.event,
            "occurred_at_utc_ms": occurred,
            "device_now_utc_ms": deviceNow,
            "device_timezone": TimeZone.current.identifier,
            "is_mock": event.isMock,
            "platform": "ios",
            "app_version": AttendanceStore.appVersion ?? "1.3.18",
            "precise_location": event.preciseLocation ?? isPreciseLocationOn(),
        ]
        if let fixMs = event.locationFixUtcMs {
            body["location_fix_utc_ms"] = fixMs
        }
        var gpsOk = event.gpsAvailable ?? (event.lat != nil && event.lng != nil)
        // Defense: strip stale / imprecise coords before they can trigger Rule 5.
        if gpsOk, let fixMs = event.locationFixUtcMs, occurred - fixMs > 60_000 {
            gpsOk = false
        }
        if gpsOk, let acc = event.accuracyM, acc > 50 {
            gpsOk = false
        }
        if gpsOk, (event.preciseLocation ?? isPreciseLocationOn()) == false {
            gpsOk = false
        }
        body["gps_available"] = gpsOk
        if let zoneId = event.zoneId { body["zone_id"] = zoneId }
        if gpsOk, let lat = event.lat { body["lat"] = lat }
        if gpsOk, let lng = event.lng { body["lng"] = lng }
        if gpsOk, let acc = event.accuracyM { body["accuracy_m"] = acc }
        if let ssid = event.ssid { body["ssid"] = ssid }
        if let bssid = event.bssid { body["bssid"] = bssid }
        if let deviceId = AttendanceKeychain.loadDeviceId() { body["device_id"] = deviceId }

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
        let reason = (json["reason"] as? String) ?? action

        let occurredRaw = json["occurred_at"] as? String
        let occurred = parseDate(occurredRaw) ?? Date()
        let localFmt = DateFormatter()
        localFmt.timeZone = .current
        localFmt.dateStyle = .none
        localFmt.timeStyle = .short
        let localTime = localFmt.string(from: occurred)

        let title: String
        let body: String
        if action == "clock_in" {
            title = "Checked in"
            if let notify = json["notify_message"] as? String, !notify.isEmpty {
                body = notify
            } else {
                let src = (json["attendance_source"] as? String) ?? ""
                if src == "auto_wifi_no_gps" || src == "manual_wifi_no_gps" {
                    body = "Checked in on office Wi-Fi (location is off)"
                } else {
                    body = "Checked in at \(localTime)"
                }
            }
        } else if action == "clock_out" {
            title = "Checked out"
            if let notify = json["notify_message"] as? String, !notify.isEmpty {
                body = notify
            } else {
                body = "Checked out - left the office radius at \(localTime)"
            }
        } else if action == "already_clocked_out",
                  let notify = json["notify_message"] as? String, !notify.isEmpty {
            title = "Attendance check"
            body = notify
        } else if let notify = json["notify_message"] as? String, !notify.isEmpty,
                  reason != "already_checked_in", reason != "already_clocked_in", reason != "none" {
            title = "Attendance check"
            body = notify
        } else if let ok = json["ok"] as? Bool, !ok, !reason.isEmpty,
                  reason != "already_checked_in", reason != "already_clocked_in", reason != "none" {
            title = "Attendance check"
            body = humanReason(reason, forAction: action)
        } else {
            return
        }

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

    private func humanReason(_ reason: String, forAction action: String = "") -> String {
        switch reason {
        case "not_on_office_wifi", "not_on_office_network":
            return "Connect to the office Wi-Fi"
        case "outside_radius", "outside_office":
            return "You are outside the office radius"
        case "gps_unusable", "need_fresh_location":
            return "Location unavailable, try again"
        case "checkin_blocked_shift_ended":
            return "The shift has ended. You cannot check in."
        case "outside_window":
            return "Outside the attendance window"
        case "event_too_old":
            return "Reading was too old — get a fresh location"
        default:
            let looksRaw = reason.contains("v_chk") || reason.contains("not assigned")
                || reason.contains("PL/pgSQL") || reason.contains("SQLSTATE")
                || reason.contains(" ") || reason.contains("\n")
            if looksRaw {
                NSLog("[scorr-att] raw server error action=%@ reason=%@", action, reason)
                if action == "clock_out" || reason.lowercased().contains("clock out") {
                    return "Clock out failed, please try again"
                }
                return "Check-in failed, please try again"
            }
            return reason.replacingOccurrences(of: "_", with: " ")
        }
    }
}
