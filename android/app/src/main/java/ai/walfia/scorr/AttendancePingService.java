package ai.walfia.scorr;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import java.util.Locale;

/**
 * Foreground service active ONLY during the shift window.
 * Checked out: Wi-Fi / radius check-in probe ~every 1s.
 * Checked in: leave + session-verify only (slower; no check-in spam).
 * Geofence EXIT remains instant via wifi/network callbacks.
 */
public class AttendancePingService extends Service {
    private static final String TAG = "ScorrAttFgs";
    private static final String CHANNEL_ID = "scorr_attendance_gps";
    private static final int NOTIF_ID = 41;
    /** Aggressive re-entry / first check-in while session is closed. */
    private static final long INTERVAL_CHECKIN_PROBE_MS = 1000L;
    /** Leave + session-verify while an open session exists (battery). */
    private static final long INTERVAL_CHECKED_IN_MS = 30 * 1000L;
    /** Treat within this many meters of the radius edge as "near edge". */
    private static final float EDGE_MARGIN_M = 150f;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable tick = this::runBackupPingThenSchedule;
    private ConnectivityManager.NetworkCallback wifiCallback;
    private boolean wifiWasOnOfficeNet = false;
    private boolean locationPingInflight = false;
    private long lastCheckedInProbeAt = 0L;

    static void start(Context ctx) {
        Context app = ctx.getApplicationContext();
        if (!AttendancePingStore.enabled(app)) return;
        if (!AttendancePingStore.isInsideActiveWindow(app)) return;
        Intent intent = new Intent(app, AttendancePingService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                app.startForegroundService(intent);
            } else {
                app.startService(intent);
            }
        } catch (Exception e) {
            Log.e(TAG, "Unable to start attendance FGS", e);
        }
    }

    static void stop(Context ctx) {
        ctx.getApplicationContext().stopService(new Intent(ctx.getApplicationContext(), AttendancePingService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Wi-Fi OR office-radius auto check-in (Android). iOS stays off in JS/native bridge.
        if (!AttendancePingStore.enabled(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        // Allow a one-shot EXIT even slightly outside the cached local window;
        // the server is the source of truth for W.
        boolean freshExit = intent != null && "scorr.action.FRESH_EXIT".equals(intent.getAction());
        if (!freshExit && !AttendancePingStore.isInsideActiveWindow(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Scorr attendance")
            .setContentText("Wi-Fi first, then office radius during your shift window")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(NOTIF_ID, notification);
            }
        } catch (SecurityException se) {
            Log.e(TAG, "startForeground denied — missing location permission?", se);
            stopSelf();
            return START_NOT_STICKY;
        }

        AttendanceEventClient.updateStatusNotification(
            this, "Wi-Fi first, then office radius during your shift window", null
        );
        AttendanceEventClient.flushQueue(this);
        if (freshExit) {
            handleFreshExitIntent(intent);
        }
        handler.removeCallbacks(tick);
        handler.post(tick);
        registerWifiCallback();
        handler.postDelayed(this::ensureStillInWindow, 30_000L);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        unregisterWifiCallback();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void ensureStillInWindow() {
        if (!AttendancePingStore.isInsideActiveWindow(this)) {
            Log.i(TAG, "Window ended — stopping FGS");
            stopSelf();
            return;
        }
        handler.postDelayed(this::ensureStillInWindow, 60_000L);
    }

    private void runBackupPingThenSchedule() {
        if (!AttendancePingStore.isInsideActiveWindow(this)) {
            stopSelf();
            return;
        }
        maybeResyncSchedule();
        // Always wake ~1s so checkout → re-entry resumes immediately.
        // While open: leave + session-verify only (gated); no check-in spam.
        if (AttendancePingStore.isAlreadyCheckedInForActiveWindow(this)) {
            long now = System.currentTimeMillis();
            if (now - lastCheckedInProbeAt >= INTERVAL_CHECKED_IN_MS) {
                lastCheckedInProbeAt = now;
                requestLeaveProbe();
                // Session-verify discovers manual/other-device checkout while still
                // in radius/Wi-Fi so local suppress clears and 1s re-entry resumes.
                sendSessionVerifyHeartbeat();
            }
            handler.postDelayed(tick, INTERVAL_CHECKIN_PROBE_MS);
            return;
        }
        lastCheckedInProbeAt = 0L;
        requestLocationPing();
        handler.postDelayed(tick, INTERVAL_CHECKIN_PROBE_MS);
    }

    /** Heartbeat with Wi-Fi (+ GPS when available) always reaches the server. */
    private void sendSessionVerifyHeartbeat() {
        String[] info = readWifiIdentity();
        String ssid = info[0];
        String bssid = info[1];
        if (ssid == null && bssid == null) {
            ssid = AttendancePingStore.lastSsid(this);
            bssid = AttendancePingStore.lastBssid(this);
        }
        if (locationServicesEnabled()) {
            final String ssidF = ssid;
            final String bssidF = bssid;
            requestFreshLocation(loc -> {
                if (loc != null && !AttendanceEventClient.isMockLocation(loc)) {
                    String zoneId = nearestZoneId(loc);
                    Double lat = loc.getLatitude();
                    Double lng = loc.getLongitude();
                    Float acc = loc.hasAccuracy() ? loc.getAccuracy() : null;
                    long readingMs = loc.getTime() > 0 ? loc.getTime() : System.currentTimeMillis();
                    AttendanceEventClient.send(
                        this, "heartbeat", zoneId, lat, lng, acc, ssidF, bssidF, readingMs
                    );
                } else {
                    AttendanceEventClient.sendWifiEvent(this, "heartbeat", ssidF, bssidF);
                }
            }, () -> AttendanceEventClient.sendWifiEvent(this, "heartbeat", ssidF, bssidF));
        } else {
            AttendanceEventClient.sendWifiEvent(this, "heartbeat", ssid, bssid);
        }
    }

    private long lastScheduleResyncAt = 0L;
    /** Pull session_open so manual checkout clears local suppress without waiting 15m. */
    private static final long SCHEDULE_RESYNC_MS = 60L * 1000L;

    private void maybeResyncSchedule() {
        long now = System.currentTimeMillis();
        if (now - lastScheduleResyncAt < SCHEDULE_RESYNC_MS) return;
        lastScheduleResyncAt = now;
        new Thread(() -> {
            try {
                AttendanceScheduleController.syncAndArm(AttendancePingService.this);
            } catch (Exception e) {
                Log.w(TAG, "mid-window schedule resync failed", e);
            }
        }, "scorr-att-sched").start();
    }

    /**
     * While open: GPS outside all office radii → exit; else soft Wi-Fi disconnect
     * is handled by the network callback.
     */
    private void requestLeaveProbe() {
        if (!locationServicesEnabled()) {
            AttendanceEventClient.updateStatusNotification(
                this, "Checked in — leave check every 30s", null
            );
            return;
        }
        requestFreshLocation(loc -> {
            if (loc == null || AttendanceEventClient.isMockLocation(loc)) return;
            if (!isClearlyOutsideAllGpsZones(loc)) {
                AttendanceEventClient.updateStatusNotification(
                    this, "Checked in — leave check every 30s", null
                );
                return;
            }
            AttendancePingStore.setLastOutsideOrEdge(this, true);
            String zoneId = nearestZoneId(loc);
            Double lat = loc.getLatitude();
            Double lng = loc.getLongitude();
            Float acc = loc.hasAccuracy() ? loc.getAccuracy() : null;
            long readingMs = loc.getTime() > 0 ? loc.getTime() : System.currentTimeMillis();
            AttendanceEventClient.send(this, "exit", zoneId, lat, lng, acc, null, null, readingMs);
            AttendanceEventClient.updateStatusNotification(
                this, "Left office radius — checking out", null
            );
        }, () -> AttendanceEventClient.updateStatusNotification(
            this, "Checked in — leave check every 30s", null
        ));
    }

    /** True when a usable GPS fix is beyond every GPS zone radius (past edge margin). */
    private boolean isClearlyOutsideAllGpsZones(Location loc) {
        boolean sawGpsZone = false;
        for (AttendanceScheduleController.Zone z : AttendanceScheduleController.parseZones(this)) {
            if (!z.usesGps()) continue;
            sawGpsZone = true;
            float[] results = new float[1];
            Location.distanceBetween(loc.getLatitude(), loc.getLongitude(), z.lat, z.lng, results);
            float radius = z.radiusM > 0 ? z.radiusM : 100f;
            if (results[0] <= radius) return false;
        }
        // No GPS zones configured → cannot decide leave by radius.
        return sawGpsZone;
    }

    private void requestLocationPing() {
        // Skip while checked in — leave path owns probes; avoid ping spam.
        if (AttendancePingStore.isAlreadyCheckedInForActiveWindow(this)) return;
        // Soft-fail GPS: when location services are off, still try office Wi-Fi / IP.
        if (!locationServicesEnabled()) {
            sendWifiOnlyCheckinIfCandidate();
            return;
        }
        // ~1s loop: single fresh read (no multi-retry stacking); OS may coalesce GPS.
        if (locationPingInflight) return;
        locationPingInflight = true;
        // Unstick if the provider never answers (battery / Doze).
        handler.postDelayed(() -> {
            if (locationPingInflight) locationPingInflight = false;
        }, 10_000L);
        requestFreshLocation(loc -> {
            locationPingInflight = false;
            if (AttendancePingStore.isAlreadyCheckedInForActiveWindow(this)) return;
            if (loc != null && !AttendanceEventClient.isMockLocation(loc)) {
                dispatchPing(loc);
            } else {
                sendWifiOnlyCheckinIfCandidate();
            }
        }, () -> {
            locationPingInflight = false;
            sendWifiOnlyCheckinIfCandidate();
        });
    }

    /** True when GPS or network location provider is on. */
    private boolean locationServicesEnabled() {
        LocationManager lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (lm == null) return false;
        try {
            return lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
                || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception e) {
            return false;
        }
    }

    /** When GPS is unavailable, send a Wi-Fi event so the server can match SSID/BSSID/IP. */
    private void sendWifiOnlyCheckinIfCandidate() {
        if (!isWifiConnected()) return;
        if (AttendancePingStore.isAlreadyCheckedInForActiveWindow(this)) return;
        String[] info = readWifiIdentity();
        String ssid = info[0];
        String bssid = info[1];
        if (ssid == null && bssid == null) {
            ssid = AttendancePingStore.lastSsid(this);
            bssid = AttendancePingStore.lastBssid(this);
        }
        if (matchesOfficeWifi(ssid, bssid) || hasWifiConfiguredZones()) {
            AttendanceEventClient.sendWifiEvent(this, "wifi_connected", ssid, bssid);
        }
    }

    private boolean hasWifiConfiguredZones() {
        for (AttendanceScheduleController.Zone z : AttendanceScheduleController.parseZones(this)) {
            if (z.usesWifi()) return true;
        }
        return false;
    }

    /** Instant EXIT: fresh high-accuracy GPS (≤50 m, up to 3 tries) then send. */
    static void sendFreshExit(Context ctx, String zoneId, String ssid, String bssid) {
        Context app = ctx.getApplicationContext();
        AttendancePingService.start(app);
        // Prefer the running service path so retries share the same location helper.
        Intent boot = new Intent(app, AttendancePingService.class);
        boot.setAction("scorr.action.FRESH_EXIT");
        boot.putExtra("zone_id", zoneId);
        boot.putExtra("ssid", ssid);
        boot.putExtra("bssid", bssid);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                app.startForegroundService(boot);
            } else {
                app.startService(boot);
            }
        } catch (Exception e) {
            Log.w(TAG, "sendFreshExit start failed", e);
            AttendanceEventClient.send(app, "exit", zoneId, null, null, null, ssid, bssid, null);
        }
    }

    private void handleFreshExitIntent(Intent intent) {
        String zoneId = intent != null ? intent.getStringExtra("zone_id") : null;
        String ssid = intent != null ? intent.getStringExtra("ssid") : null;
        String bssid = intent != null ? intent.getStringExtra("bssid") : null;
        requestFreshLocationWithRetries(loc -> {
            if (loc != null && !AttendanceEventClient.isMockLocation(loc)) {
                Double lat = loc.getLatitude();
                Double lng = loc.getLongitude();
                Float acc = loc.hasAccuracy() ? loc.getAccuracy() : null;
                long readingMs = loc.getTime() > 0 ? loc.getTime() : System.currentTimeMillis();
                String z = zoneId != null ? zoneId : nearestZoneId(loc);
                AttendanceEventClient.send(this, "exit", z, lat, lng, acc, ssid, bssid, readingMs);
                AttendancePingStore.setLastOutsideOrEdge(this, true);
            } else {
                AttendanceEventClient.send(this, "exit", zoneId, null, null, null, ssid, bssid, null);
            }
        }, () -> AttendanceEventClient.send(this, "exit", zoneId, null, null, null, ssid, bssid, null), 50f);
    }

    /**
     * R69: after office Wi-Fi disconnect, try a fresh GPS fix (≤30s) then send
     * wifi_disconnected with coordinates so the server can immediate-checkout,
     * stay-in (GPS inside), or start the 15-minute grace (GPS unavailable).
     */
    private void requestGpsThenWifiDisconnect(String ssid, String bssid) {
        final boolean[] done = { false };
        Runnable fallback = () -> {
            if (done[0]) return;
            done[0] = true;
            AttendanceEventClient.sendWifiEvent(this, "wifi_disconnected", ssid, bssid);
        };
        handler.postDelayed(fallback, 30_000L);
        requestFreshLocation(loc -> {
            if (done[0]) return;
            done[0] = true;
            handler.removeCallbacks(fallback);
            if (loc != null && !AttendanceEventClient.isMockLocation(loc)) {
                String zoneId = nearestZoneId(loc);
                Double lat = loc.getLatitude();
                Double lng = loc.getLongitude();
                Float acc = loc.hasAccuracy() ? loc.getAccuracy() : null;
                AttendanceEventClient.send(
                    this, "wifi_disconnected", zoneId, lat, lng, acc, ssid, bssid
                );
            } else {
                AttendanceEventClient.sendWifiEvent(this, "wifi_disconnected", ssid, bssid);
            }
        }, fallback);
    }

    private void requestFreshLocation(
        java.util.function.Consumer<Location> onResult,
        @Nullable Runnable onDenied
    ) {
        if (ActivityCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED
            && ActivityCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_COARSE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            if (onDenied != null) onDenied.run();
            else onResult.accept(null);
            return;
        }
        LocationManager lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (lm == null) {
            if (onDenied != null) onDenied.run();
            else onResult.accept(null);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            String provider = lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
                ? LocationManager.GPS_PROVIDER
                : LocationManager.NETWORK_PROVIDER;
            CancellationSignal cancel = new CancellationSignal();
            handler.postDelayed(cancel::cancel, 8_000L);
            lm.getCurrentLocation(provider, cancel, getMainExecutor(), onResult::accept);
            return;
        }
        Location loc = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER);
        if (loc == null) loc = lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
        onResult.accept(loc);
    }

    /**
     * Up to 3 fresh readings within ~15s until accuracy is at or under maxAccuracyM.
     */
    private void requestFreshLocationWithRetries(
        java.util.function.Consumer<Location> onResult,
        @Nullable Runnable onDenied,
        float maxAccuracyM
    ) {
        final Location[] best = { null };
        final int[] attempt = { 0 };
        final Runnable[] step = { null };
        step[0] = () -> {
            attempt[0]++;
            requestFreshLocation(loc -> {
                if (loc != null && !AttendanceEventClient.isMockLocation(loc)) {
                    if (best[0] == null
                        || (loc.hasAccuracy() && (!best[0].hasAccuracy()
                            || loc.getAccuracy() < best[0].getAccuracy()))) {
                        best[0] = loc;
                    }
                    if (loc.hasAccuracy() && loc.getAccuracy() <= maxAccuracyM) {
                        onResult.accept(loc);
                        return;
                    }
                }
                if (attempt[0] < 3) {
                    handler.postDelayed(step[0], 4_000L);
                } else if (best[0] != null) {
                    onResult.accept(best[0]);
                } else if (onDenied != null) {
                    onDenied.run();
                } else {
                    onResult.accept(null);
                }
            }, () -> {
                if (attempt[0] < 3) {
                    handler.postDelayed(step[0], 4_000L);
                } else if (onDenied != null) {
                    onDenied.run();
                } else {
                    onResult.accept(best[0]);
                }
            });
        };
        step[0].run();
    }

    private void dispatchPing(Location loc) {
        if (AttendancePingStore.isAlreadyCheckedInForActiveWindow(this)) return;
        String zoneId = nearestZoneId(loc);
        boolean outsideOrEdge = isOutsideOrNearEdge(loc);
        AttendancePingStore.setLastOutsideOrEdge(this, outsideOrEdge);
        AttendanceEventClient.sendLocationEvent(this, "ping", loc, zoneId);
        AttendanceEventClient.updateStatusNotification(
            this,
            outsideOrEdge
                ? "Outside / near edge — seeking check-in every 1s"
                : "Inside office — seeking check-in every 1s",
            null
        );
    }

    private boolean isOutsideOrNearEdge(Location loc) {
        float bestDist = Float.MAX_VALUE;
        float bestRadius = 100f;
        for (AttendanceScheduleController.Zone z : AttendanceScheduleController.parseZones(this)) {
            if (!z.usesGps()) continue;
            float[] results = new float[1];
            Location.distanceBetween(loc.getLatitude(), loc.getLongitude(), z.lat, z.lng, results);
            if (results[0] < bestDist) {
                bestDist = results[0];
                bestRadius = z.radiusM > 0 ? z.radiusM : 100f;
            }
        }
        if (bestDist == Float.MAX_VALUE) return true;
        return bestDist > bestRadius - EDGE_MARGIN_M;
    }

    private String nearestZoneId(Location loc) {
        String best = null;
        double bestDist = Double.MAX_VALUE;
        for (AttendanceScheduleController.Zone z : AttendanceScheduleController.parseZones(this)) {
            if (!z.usesGps()) continue;
            float[] results = new float[1];
            Location.distanceBetween(loc.getLatitude(), loc.getLongitude(), z.lat, z.lng, results);
            if (results[0] < bestDist) {
                bestDist = results[0];
                best = z.zoneId;
            }
        }
        return best;
    }

    private void registerWifiCallback() {
        unregisterWifiCallback();
        ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (cm == null) return;

        NetworkRequest request = new NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .build();

        wifiCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                handler.post(() -> {
                    AttendanceEventClient.flushQueue(AttendancePingService.this);
                    if (!AttendancePingStore.isAlreadyCheckedInForActiveWindow(AttendancePingService.this)) {
                        requestLocationPing();
                    }
                    onWifiChanged(true);
                });
            }

            @Override
            public void onLost(Network network) {
                handler.post(() -> onWifiChanged(false));
            }

            @Override
            public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
                handler.post(() -> onWifiChanged(true));
            }
        };

        try {
            cm.registerNetworkCallback(request, wifiCallback);
            // Seed current state
            handler.post(() -> onWifiChanged(isWifiConnected()));
        } catch (Exception e) {
            Log.w(TAG, "registerNetworkCallback failed", e);
        }
    }

    private void unregisterWifiCallback() {
        if (wifiCallback == null) return;
        ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (cm != null) {
            try {
                cm.unregisterNetworkCallback(wifiCallback);
            } catch (Exception ignored) {
            }
        }
        wifiCallback = null;
    }

    private boolean isWifiConnected() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        Network net = cm.getActiveNetwork();
        if (net == null) return false;
        NetworkCapabilities caps = cm.getNetworkCapabilities(net);
        return caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
    }

    private void onWifiChanged(boolean connected) {
        // Do not gate on local window — server rejects outside-window events.
        if (AttendancePingStore.consumeOfficeWifiEdgeReset(this)) {
            wifiWasOnOfficeNet = false;
        }

        String ssid = null;
        String bssid = null;
        if (connected) {
            String[] info = readWifiIdentity();
            ssid = info[0];
            bssid = info[1];
            // Android often hides SSID when location services are off — reuse last office identity.
            if (ssid == null && bssid == null) {
                String lastS = AttendancePingStore.lastSsid(this);
                String lastB = AttendancePingStore.lastBssid(this);
                if (matchesOfficeWifi(lastS, lastB)) {
                    ssid = lastS;
                    bssid = lastB;
                }
            }
        } else {
            ssid = AttendancePingStore.lastSsid(this);
            bssid = AttendancePingStore.lastBssid(this);
        }

        boolean matchesOffice = connected && matchesOfficeWifi(ssid, bssid);
        // SSID unreadable (location off) but Wi-Fi up and office has Wi-Fi zones → let server match IP.
        boolean wifiCandidate = matchesOffice
            || (connected && ssid == null && bssid == null && hasWifiConfiguredZones());
        boolean was = wifiWasOnOfficeNet || AttendancePingStore.wifiConnected(this);

        if (connected && wifiCandidate && !was) {
            AttendancePingStore.setLastWifi(this, ssid, bssid, true);
            wifiWasOnOfficeNet = true;
            if (!AttendancePingStore.isAlreadyCheckedInForActiveWindow(this)) {
                // Prefer attaching GPS so radius OR Wi-Fi can both satisfy server check-in.
                // Soft-fail GPS when location services are off — send Wi-Fi immediately.
                requestGpsThenWifiEvent("wifi_connected", ssid, bssid);
            }
        } else if ((!connected || !wifiCandidate) && was) {
            AttendancePingStore.setLastWifi(this, ssid, bssid, false);
            wifiWasOnOfficeNet = false;
            // Early check-out during shift: server does not require office Wi-Fi/radius.
            if (AttendancePingStore.isAlreadyCheckedInForActiveWindow(this)) {
                AttendanceEventClient.sendWifiEvent(this, "wifi_disconnected", ssid, bssid);
            }
        } else if (connected) {
            AttendancePingStore.setLastWifi(this, ssid, bssid, wifiCandidate);
            wifiWasOnOfficeNet = wifiCandidate;
        }
    }

    private void requestGpsThenWifiEvent(String eventName, String ssid, String bssid) {
        // Location off: do not wait on GPS — Wi-Fi / IP check-in must proceed.
        if (!locationServicesEnabled()) {
            AttendanceEventClient.sendWifiEvent(this, eventName, ssid, bssid);
            return;
        }
        final boolean[] done = { false };
        Runnable fallback = () -> {
            if (done[0]) return;
            done[0] = true;
            // Soft-fail GPS: still send SSID/BSSID so Wi-Fi-only check-in works.
            AttendanceEventClient.sendWifiEvent(this, eventName, ssid, bssid);
        };
        handler.postDelayed(fallback, 12_000L);
        requestFreshLocationWithRetries(loc -> {
            if (done[0]) return;
            done[0] = true;
            handler.removeCallbacks(fallback);
            if (loc != null && !AttendanceEventClient.isMockLocation(loc)) {
                String zoneId = nearestZoneId(loc);
                Double lat = loc.getLatitude();
                Double lng = loc.getLongitude();
                Float acc = loc.hasAccuracy() ? loc.getAccuracy() : null;
                long readingMs = loc.getTime() > 0 ? loc.getTime() : System.currentTimeMillis();
                AttendanceEventClient.send(
                    this, eventName, zoneId, lat, lng, acc, ssid, bssid, readingMs
                );
            } else {
                AttendanceEventClient.sendWifiEvent(this, eventName, ssid, bssid);
            }
        }, fallback, 50f);
    }

    private boolean matchesOfficeWifi(String ssid, String bssid) {
        if (ssid == null && bssid == null) return false;
        String ssidNorm = ssid != null ? ssid.trim() : null;
        String bssidNorm = bssid != null ? bssid.trim().toLowerCase(Locale.US) : null;

        for (AttendanceScheduleController.Zone z : AttendanceScheduleController.parseZones(this)) {
            if (!z.usesWifi()) continue;
            // BSSID match preferred
            if (bssidNorm != null && z.wifiBssids != null) {
                for (int i = 0; i < z.wifiBssids.length(); i++) {
                    String want = z.wifiBssids.optString(i, "").trim().toLowerCase(Locale.US);
                    if (!want.isEmpty() && want.equals(bssidNorm)) return true;
                }
            }
            if (ssidNorm != null && z.wifiSsids != null) {
                for (int i = 0; i < z.wifiSsids.length(); i++) {
                    String want = z.wifiSsids.optString(i, "").trim();
                    if (!want.isEmpty() && want.equalsIgnoreCase(ssidNorm)) return true;
                }
            }
            // Zone uses wifi but has no SSID/BSSID list — treat any Wi-Fi as candidate;
            // server validates public IP.
            if ((z.wifiSsids == null || z.wifiSsids.length() == 0)
                && (z.wifiBssids == null || z.wifiBssids.length() == 0)) {
                return true;
            }
        }
        // gps_only offices or no SSID/BSSID match
        return false;
    }

    @SuppressWarnings("deprecation")
    private String[] readWifiIdentity() {
        String ssid = null;
        String bssid = null;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
                if (cm != null) {
                    Network net = cm.getActiveNetwork();
                    if (net != null) {
                        NetworkCapabilities caps = cm.getNetworkCapabilities(net);
                        if (caps != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                            // Transport info may expose WifiInfo on API 29+
                            try {
                                Object transport = caps.getTransportInfo();
                                if (transport instanceof WifiInfo) {
                                    WifiInfo wi = (WifiInfo) transport;
                                    ssid = wi.getSSID();
                                    bssid = wi.getBSSID();
                                }
                            } catch (Exception ignored) {
                            }
                        }
                    }
                }
            }
            if (ssid == null || bssid == null) {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    WifiInfo info = wm.getConnectionInfo();
                    if (info != null) {
                        if (ssid == null) ssid = info.getSSID();
                        if (bssid == null) bssid = info.getBSSID();
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "wifi identity", e);
        }
        if (ssid != null) {
            ssid = ssid.trim();
            if (ssid.length() >= 2 && ssid.startsWith("\"") && ssid.endsWith("\"")) {
                ssid = ssid.substring(1, ssid.length() - 1);
            }
            if ("<unknown ssid>".equalsIgnoreCase(ssid)) ssid = null;
        }
        return new String[]{ssid, bssid};
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Attendance location",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription(
            "Shown only during your shift window while Scorr watches office Wi-Fi and radius."
        );
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(channel);
    }
}
