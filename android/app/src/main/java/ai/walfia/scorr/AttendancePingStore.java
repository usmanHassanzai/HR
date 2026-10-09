package ai.walfia.scorr;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.util.Log;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKeys;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Secure credentials + schedule cache + offline event queue.
 * Device token lives in EncryptedSharedPreferences (Android Keystore-backed).
 */
final class AttendancePingStore {
    private static final String TAG = "ScorrAttStore";
    private static final String PREFS_SECURE = "scorr_attendance_secure";
    private static final String PREFS_FALLBACK = "scorr_attendance_ping";
    private static final int MAX_QUEUE = 200;

    private AttendancePingStore() {}

    private static SharedPreferences prefs(Context ctx) {
        try {
            String masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC);
            return EncryptedSharedPreferences.create(
                PREFS_SECURE,
                masterKeyAlias,
                ctx.getApplicationContext(),
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            );
        } catch (Exception e) {
            Log.w(TAG, "EncryptedSharedPreferences unavailable, using fallback", e);
            return ctx.getApplicationContext()
                .getSharedPreferences(PREFS_FALLBACK, Context.MODE_PRIVATE);
        }
    }

    static void saveAutoAttendance(
        Context ctx,
        String url,
        String anon,
        String deviceToken,
        String deviceId,
        String appVersion
    ) {
        prefs(ctx).edit()
            .putString("url", url)
            .putString("anon", anon)
            .putString("device_token", deviceToken)
            .putString("device_id", deviceId)
            .putString("app_version", appVersion != null ? appVersion : "")
            .putBoolean("enabled", true)
            .apply();
    }

    /**
     * Clear auto-attendance enrollment only.
     * Remember-me login + MFA trusted-device tokens must survive stop/unenroll
     * and session-timeout sign-out (they have dedicated clear APIs).
     */
    static void clear(Context ctx) {
        SharedPreferences p = prefs(ctx);
        String loginEmail = p.getString("login_email", null);
        String loginPassword = p.getString("login_password", null);
        String trusted = p.getString("trusted_device_token", null);
        p.edit().clear().apply();
        SharedPreferences.Editor restore = prefs(ctx).edit();
        if (loginEmail != null) restore.putString("login_email", loginEmail);
        if (loginPassword != null) restore.putString("login_password", loginPassword);
        if (trusted != null) restore.putString("trusted_device_token", trusted);
        restore.apply();
    }

    static void setEnabled(Context ctx, boolean enabled) {
        prefs(ctx).edit().putBoolean("enabled", enabled).apply();
    }

    static boolean enabled(Context ctx) {
        SharedPreferences p = prefs(ctx);
        return p.getBoolean("enabled", false) && deviceToken(ctx) != null;
    }

    static String url(Context ctx) {
        return prefs(ctx).getString("url", null);
    }

    static String anon(Context ctx) {
        return prefs(ctx).getString("anon", null);
    }

    static String deviceToken(Context ctx) {
        return prefs(ctx).getString("device_token", null);
    }

    /** Remember-me login — Keystore-backed EncryptedSharedPreferences only. */
    static void saveLoginCredentials(Context ctx, String email, String password) {
        prefs(ctx).edit()
            .putString("login_email", email)
            .putString("login_password", password)
            .apply();
    }

    static String loginEmail(Context ctx) {
        return prefs(ctx).getString("login_email", null);
    }

    static String loginPassword(Context ctx) {
        return prefs(ctx).getString("login_password", null);
    }

    static void clearLoginCredentials(Context ctx) {
        prefs(ctx).edit()
            .remove("login_email")
            .remove("login_password")
            .apply();
    }

    /** MFA trusted-device token — Keystore-backed EncryptedSharedPreferences. */
    static void saveTrustedDeviceToken(Context ctx, String token) {
        prefs(ctx).edit().putString("trusted_device_token", token).apply();
    }

    static String trustedDeviceToken(Context ctx) {
        return prefs(ctx).getString("trusted_device_token", null);
    }

    static void clearTrustedDeviceToken(Context ctx) {
        prefs(ctx).edit().remove("trusted_device_token").apply();
    }

    static String deviceId(Context ctx) {
        return prefs(ctx).getString("device_id", null);
    }

    static String appVersion(Context ctx) {
        String v = prefs(ctx).getString("app_version", null);
        return v != null && !v.isEmpty() ? v : "1.3.5";
    }

    static String deviceTimezone() {
        try {
            return TimeZone.getDefault().getID();
        } catch (Exception e) {
            return "UTC";
        }
    }

    static void saveScheduleJson(Context ctx, String json) {
        prefs(ctx).edit().putString("schedule_json", json).apply();
    }

    static String scheduleJson(Context ctx) {
        return prefs(ctx).getString("schedule_json", null);
    }

    static void saveOfficeVersion(Context ctx, long version) {
        prefs(ctx).edit().putLong("office_version", version).apply();
    }

    static long officeVersion(Context ctx) {
        return prefs(ctx).getLong("office_version", 0L);
    }

    static void saveCompanyTz(Context ctx, String tz) {
        if (tz != null) prefs(ctx).edit().putString("company_tz", tz).apply();
    }

    static String companyTz(Context ctx) {
        return prefs(ctx).getString("company_tz", "UTC");
    }

    static void setActiveWindow(Context ctx, long startMs, long endMs) {
        prefs(ctx).edit()
            .putLong("active_window_start_ms", startMs)
            .putLong("active_window_end_ms", endMs)
            .apply();
    }

    static void clearActiveWindow(Context ctx) {
        prefs(ctx).edit()
            .remove("active_window_start_ms")
            .remove("active_window_end_ms")
            .apply();
    }

    static long activeWindowStartMs(Context ctx) {
        return prefs(ctx).getLong("active_window_start_ms", 0L);
    }

    static long activeWindowEndMs(Context ctx) {
        return prefs(ctx).getLong("active_window_end_ms", 0L);
    }

    static boolean isInsideActiveWindow(Context ctx) {
        long now = System.currentTimeMillis();
        long start = activeWindowStartMs(ctx);
        long end = activeWindowEndMs(ctx);
        return start > 0 && end > start && now >= start && now < end;
    }

    static synchronized void enqueueEvent(Context ctx, JSONObject event) {
        try {
            SharedPreferences p = prefs(ctx);
            JSONArray arr = new JSONArray(p.getString("offline_queue", "[]"));
            arr.put(event);
            while (arr.length() > MAX_QUEUE) {
                JSONArray next = new JSONArray();
                for (int i = 1; i < arr.length(); i++) next.put(arr.get(i));
                arr = next;
            }
            p.edit().putString("offline_queue", arr.toString()).apply();
        } catch (Exception e) {
            Log.w(TAG, "enqueue failed", e);
        }
    }

    static synchronized JSONArray drainQueue(Context ctx) {
        try {
            SharedPreferences p = prefs(ctx);
            JSONArray arr = new JSONArray(p.getString("offline_queue", "[]"));
            p.edit().putString("offline_queue", "[]").apply();
            return arr;
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    static synchronized void restoreQueue(Context ctx, JSONArray remaining) {
        try {
            prefs(ctx).edit()
                .putString("offline_queue", remaining != null ? remaining.toString() : "[]")
                .apply();
        } catch (Exception ignored) {
        }
    }

    static void setLastWifi(Context ctx, String ssid, String bssid, boolean connected) {
        prefs(ctx).edit()
            .putString("last_ssid", ssid)
            .putString("last_bssid", bssid)
            .putBoolean("wifi_connected", connected)
            .apply();
    }

    static String lastSsid(Context ctx) {
        return prefs(ctx).getString("last_ssid", null);
    }

    static String lastBssid(Context ctx) {
        return prefs(ctx).getString("last_bssid", null);
    }

    static boolean wifiConnected(Context ctx) {
        return prefs(ctx).getBoolean("wifi_connected", false);
    }

    static void setLastStatusText(Context ctx, String text) {
        if (text != null) prefs(ctx).edit().putString("last_status_text", text).apply();
    }

    static String lastStatusText(Context ctx) {
        return prefs(ctx).getString("last_status_text", null);
    }

    static void setLastServerAction(Context ctx, String action, long atMs) {
        prefs(ctx).edit()
            .putString("last_server_action", action != null ? action : "")
            .putLong("last_server_action_at", atMs)
            .apply();
    }

    static void setLastOutsideOrEdge(Context ctx, boolean outsideOrEdge) {
        prefs(ctx).edit().putBoolean("last_outside_or_edge", outsideOrEdge).apply();
    }

    static boolean lastOutsideOrEdge(Context ctx) {
        return prefs(ctx).getBoolean("last_outside_or_edge", false);
    }

    /** Append a stale-drop log line (capped) so drop frequency is visible. */
    static synchronized void recordStaleDrop(Context ctx, String event, long ageMs, String source) {
        try {
            SharedPreferences p = prefs(ctx);
            JSONArray arr = new JSONArray(p.getString("stale_drop_log", "[]"));
            JSONObject row = new JSONObject();
            row.put("at", System.currentTimeMillis());
            row.put("event", event != null ? event : "");
            row.put("age_ms", ageMs);
            row.put("source", source != null ? source : "");
            arr.put(row);
            while (arr.length() > 100) {
                JSONArray next = new JSONArray();
                for (int i = 1; i < arr.length(); i++) next.put(arr.get(i));
                arr = next;
            }
            p.edit().putString("stale_drop_log", arr.toString()).apply();
            Log.i(TAG, "stale_drop_log size=" + arr.length() + " last=" + row);
        } catch (Exception e) {
            Log.w(TAG, "recordStaleDrop", e);
        }
    }

    /** Best-effort current Wi-Fi SSID/BSSID for immediate EXIT / disconnect events (R69). */
    @SuppressWarnings("deprecation")
    static String[] readCurrentWifiIdentity(Context ctx) {
        String ssid = null;
        String bssid = null;
        Context app = ctx.getApplicationContext();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ConnectivityManager cm = (ConnectivityManager) app.getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm != null) {
                    Network net = cm.getActiveNetwork();
                    if (net != null) {
                        NetworkCapabilities caps = cm.getNetworkCapabilities(net);
                        if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                            Object transport = caps.getTransportInfo();
                            if (transport instanceof WifiInfo) {
                                WifiInfo wi = (WifiInfo) transport;
                                ssid = wi.getSSID();
                                bssid = wi.getBSSID();
                            }
                        }
                    }
                }
            }
            if (ssid == null || bssid == null) {
                WifiManager wm = (WifiManager) app.getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    WifiInfo info = wm.getConnectionInfo();
                    if (info != null) {
                        if (ssid == null) ssid = info.getSSID();
                        if (bssid == null) bssid = info.getBSSID();
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "readCurrentWifiIdentity", e);
        }
        if (ssid != null) {
            String s = ssid.trim();
            if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) {
                s = s.substring(1, s.length() - 1);
            }
            if ("<unknown ssid>".equalsIgnoreCase(s) || s.isEmpty()) s = null;
            ssid = s;
        }
        if (bssid != null) {
            bssid = bssid.trim().toLowerCase(Locale.US);
            if (bssid.isEmpty() || "02:00:00:00:00:00".equals(bssid)) bssid = null;
        }
        return new String[] { ssid, bssid };
    }
}
