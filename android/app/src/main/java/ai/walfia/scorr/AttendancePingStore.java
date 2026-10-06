package ai.walfia.scorr;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import org.json.JSONArray;
import org.json.JSONObject;
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
            MasterKey key = new MasterKey.Builder(ctx.getApplicationContext())
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build();
            return EncryptedSharedPreferences.create(
                ctx.getApplicationContext(),
                PREFS_SECURE,
                key,
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

    static void clear(Context ctx) {
        prefs(ctx).edit().clear().apply();
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
}
