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
 * Geofence exit is the fast path. This service also takes a GPS fix every 20 seconds
 * so a leave is seen even when the geofence is late. Battery use stays unrestricted.
 */
public class AttendancePingService extends Service {
    private static final String TAG = "ScorrAttFgs";
    private static final String CHANNEL_ID = "scorr_attendance_gps";
    private static final int NOTIF_ID = 41;
    private static final long INTERVAL_MS = 20 * 1000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable tick = this::runBackupPingThenSchedule;
    private ConnectivityManager.NetworkCallback wifiCallback;
    private boolean wifiWasOnOfficeNet = false;

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
        if (!AttendancePingStore.enabled(this) || !AttendancePingStore.isInsideActiveWindow(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Scorr attendance")
            .setContentText("Tracking office presence during your shift window")
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
        requestLocationPing();
        handler.postDelayed(tick, INTERVAL_MS);
    }

    private void requestLocationPing() {
        requestFreshLocation(this::onLocation, null);
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
            handler.postDelayed(cancel::cancel, 28_000L);
            lm.getCurrentLocation(provider, cancel, getMainExecutor(), onResult::accept);
            return;
        }
        Location loc = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER);
        if (loc == null) loc = lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
        onResult.accept(loc);
    }

    private void onLocation(Location loc) {
        if (loc == null) return;
        if (!AttendancePingStore.isInsideActiveWindow(this)) return;
        if (AttendanceEventClient.isMockLocation(loc)) {
            Log.w(TAG, "Rejected mock location backup ping");
            return;
        }
        String zoneId = nearestZoneId(loc);
        AttendanceEventClient.sendLocationEvent(this, "ping", loc, zoneId);
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
                handler.post(() -> onWifiChanged(true));
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
        if (!AttendancePingStore.isInsideActiveWindow(this)) return;

        String ssid = null;
        String bssid = null;
        if (connected) {
            String[] info = readWifiIdentity();
            ssid = info[0];
            bssid = info[1];
        } else {
            ssid = AttendancePingStore.lastSsid(this);
            bssid = AttendancePingStore.lastBssid(this);
        }

        boolean matchesOffice = connected && matchesOfficeWifi(ssid, bssid);
        boolean was = wifiWasOnOfficeNet || AttendancePingStore.wifiConnected(this);

        if (connected && matchesOffice && !was) {
            AttendancePingStore.setLastWifi(this, ssid, bssid, true);
            wifiWasOnOfficeNet = true;
            AttendanceEventClient.sendWifiEvent(this, "wifi_connected", ssid, bssid);
        } else if ((!connected || !matchesOffice) && was) {
            AttendancePingStore.setLastWifi(this, ssid, bssid, false);
            wifiWasOnOfficeNet = false;
            // R69: on office Wi-Fi loss, get a fresh GPS fix within 30s and decide immediately.
            // Do not attach last office SSID — that + a non-office IP trips fake-hotspot.
            requestGpsThenWifiDisconnect(null, null);
        } else if (connected) {
            AttendancePingStore.setLastWifi(this, ssid, bssid, matchesOffice);
            wifiWasOnOfficeNet = matchesOffice;
        }
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
            "Shown only during your shift window while Scorr watches office GPS and Wi-Fi."
        );
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(channel);
    }
}
