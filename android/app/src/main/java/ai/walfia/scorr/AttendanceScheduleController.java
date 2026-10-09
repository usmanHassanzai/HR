package ai.walfia.scorr;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.TimeUnit;

/**
 * Fetches attendance schedule (device token) and arms window start/end alarms.
 * AlarmManager exact alarms preferred; WorkManager is the fallback (R35–R37).
 */
final class AttendanceScheduleController {
    private static final String TAG = "ScorrAttSchedule";
    static final String ACTION_WINDOW_START = "ai.walfia.scorr.ATTENDANCE_WINDOW_START";
    static final String ACTION_WINDOW_END = "ai.walfia.scorr.ATTENDANCE_WINDOW_END";
    static final String EXTRA_START_MS = "window_start_ms";
    static final String EXTRA_END_MS = "window_end_ms";
    private static final int REQ_BASE_START = 7100;
    private static final int REQ_BASE_END = 7200;
    private static final int MAX_WINDOWS = 14;

    private AttendanceScheduleController() {}

    static final class Window {
        final long startMs;
        final long endMs;

        Window(long startMs, long endMs) {
            this.startMs = startMs;
            this.endMs = endMs;
        }
    }

    static final class Zone {
        final String zoneId;
        final double lat;
        final double lng;
        final float radiusM;
        final String detectionMode;
        final JSONArray wifiSsids;
        final JSONArray wifiBssids;

        Zone(String zoneId, double lat, double lng, float radiusM,
             String detectionMode, JSONArray wifiSsids, JSONArray wifiBssids) {
            this.zoneId = zoneId;
            this.lat = lat;
            this.lng = lng;
            this.radiusM = radiusM;
            this.detectionMode = detectionMode != null ? detectionMode : "gps_or_wifi";
            this.wifiSsids = wifiSsids != null ? wifiSsids : new JSONArray();
            this.wifiBssids = wifiBssids != null ? wifiBssids : new JSONArray();
        }

        boolean usesGps() {
            return !"wifi_only".equals(detectionMode);
        }

        boolean usesWifi() {
            return !"gps_only".equals(detectionMode);
        }
    }

    /** Sync schedule then re-arm. Returns null on success, error message otherwise. */
    static String syncAndArm(Context ctx) {
        Context app = ctx.getApplicationContext();
        if (!AttendancePingStore.enabled(app)) {
            return "Auto attendance not enabled";
        }
        String err = fetchAndCacheSchedule(app);
        // Always arm from cache so reboot / offline boot still starts the window FGS.
        armFromCache(app);
        AttendanceEventClient.flushQueue(app);
        return err;
    }

    static String fetchAndCacheSchedule(Context app) {
        String base = AttendancePingStore.url(app);
        String anon = AttendancePingStore.anon(app);
        String token = AttendancePingStore.deviceToken(app);
        if (base == null || anon == null || token == null) {
            return "Missing device credentials";
        }

        HttpURLConnection conn = null;
        try {
            URL url = new URL(base.replaceAll("/$", "") + "/functions/v1/attendance-schedule");
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(20000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("apikey", anon);
            conn.setRequestProperty("x-device-token", token);
            JSONObject req = new JSONObject();
            req.put("device_token", token);
            byte[] bytes = req.toString().getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(bytes);
            }
            int code = conn.getResponseCode();
            String resp = readStream(
                code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream()
            );
            if (code < 200 || code >= 300) {
                try {
                    JSONObject err = new JSONObject(resp);
                    String reason = err.optString("reason", "");
                    if (err.optBoolean("stop_tracking", false) && isHardStopReason(reason)) {
                        stopAll(app);
                    } else if ("outside_window".equals(reason)) {
                        exitWindow(app);
                    }
                } catch (Exception ignored) {
                }
                return "Schedule HTTP " + code;
            }
            JSONObject json = new JSONObject(resp);
            String stopReason = json.optString("reason", "");
            if (!json.optBoolean("ok", true) && json.optBoolean("stop_tracking", false)
                && isHardStopReason(stopReason)) {
                stopAll(app);
                return stopReason.isEmpty() ? "stop_tracking" : stopReason;
            }
            if ("outside_window".equals(stopReason)) {
                exitWindow(app);
                // Keep token; next window start re-arms from cache/alarms.
            }
            long prevVer = AttendancePingStore.officeVersion(app);
            long nextVer = json.optLong("office_version", 0);
            if (nextVer <= 0) {
                try {
                    org.json.JSONArray zones = json.optJSONArray("zones");
                    if (zones != null) {
                        for (int i = 0; i < zones.length(); i++) {
                            nextVer = Math.max(nextVer, zones.getJSONObject(i).optLong("office_version", 0));
                        }
                    }
                } catch (Exception ignored) {
                }
            }
            AttendancePingStore.saveScheduleJson(app, json.toString());
            AttendancePingStore.saveOfficeVersion(app, nextVer);
            String companyTz = json.optString("company_tz", null);
            if (companyTz != null && !companyTz.isEmpty()) {
                AttendancePingStore.saveCompanyTz(app, companyTz);
            }
            if (nextVer > 0 && nextVer != prevVer) {
                // Radius/pin changed — re-arm geofences from the new schedule.
                armFromCache(app);
            }
            return null;
        } catch (Exception e) {
            Log.w(TAG, "schedule fetch failed", e);
            return e.getMessage() != null ? e.getMessage() : "schedule_fetch_failed";
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    static void armFromCache(Context app) {
        cancelAllAlarms(app);
        List<Window> windows = parseWindows(app);
        long now = System.currentTimeMillis();
        Window active = null;
        int armed = 0;
        for (Window w : windows) {
            if (w.endMs <= now) continue;
            if (w.startMs <= now && now < w.endMs) {
                active = w;
            }
            if (w.startMs > now) {
                scheduleExact(app, ACTION_WINDOW_START, w.startMs, w.endMs, REQ_BASE_START + armed);
            }
            scheduleExact(app, ACTION_WINDOW_END, w.endMs, w.endMs, REQ_BASE_END + armed);
            armed++;
            if (armed >= MAX_WINDOWS) break;
        }

        if (active != null) {
            enterWindow(app, active.startMs, active.endMs);
        } else {
            // Ensure we are not tracking outside any window.
            if (!AttendancePingStore.isInsideActiveWindow(app)) {
                AttendanceGeofenceManager.removeAll(app);
                AttendancePingService.stop(app);
                AttendancePingStore.clearActiveWindow(app);
            }
        }
    }

    static void enterWindow(Context app, long startMs, long endMs) {
        AttendancePingStore.setActiveWindow(app, startMs, endMs);
        AttendanceGeofenceManager.registerForActiveWindow(app, endMs);
        AttendancePingService.start(app);
        AttendanceEventClient.flushQueue(app);
    }

    static void exitWindow(Context app) {
        AttendanceGeofenceManager.removeAll(app);
        AttendancePingService.stop(app);
        AttendancePingStore.clearActiveWindow(app);
    }

    static void stopAll(Context app) {
        cancelAllAlarms(app);
        exitWindow(app);
        AttendancePingStore.clear(app);
        try {
            WorkManager.getInstance(app).cancelAllWorkByTag("scorr_attendance");
        } catch (Exception ignored) {
        }
    }

    /** Revoke enrollment only for hard auth/feature failures — never after check-out. */
    private static boolean isHardStopReason(String reason) {
        if (reason == null) return false;
        switch (reason) {
            case "missing_token":
            case "invalid_token":
            case "revoked_token":
            case "user_gone":
            case "feature_off":
            case "work_mode_remote":
                return true;
            default:
                return false;
        }
    }

    static void scheduleExact(Context app, String action, long triggerAtMs, long endMs, int reqCode) {
        if (triggerAtMs <= System.currentTimeMillis()) {
            if (ACTION_WINDOW_START.equals(action)) {
                enterWindow(app, triggerAtMs, endMs);
            } else if (ACTION_WINDOW_END.equals(action)) {
                exitWindow(app);
            }
            return;
        }

        Intent intent = new Intent(app, AttendanceWindowReceiver.class);
        intent.setAction(action);
        intent.putExtra(EXTRA_START_MS, triggerAtMs);
        intent.putExtra(EXTRA_END_MS, endMs);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pi = PendingIntent.getBroadcast(app, reqCode, intent, flags);

        AlarmManager am = (AlarmManager) app.getSystemService(Context.ALARM_SERVICE);
        boolean exactOk = am != null;
        if (exactOk && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            exactOk = am.canScheduleExactAlarms();
        }

        if (exactOk && am != null) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pi);
                } else {
                    am.setExact(AlarmManager.RTC_WAKEUP, triggerAtMs, pi);
                }
                return;
            } catch (SecurityException se) {
                Log.w(TAG, "exact alarm denied, using WorkManager", se);
            }
        }

        // WorkManager fallback
        long delay = Math.max(0L, triggerAtMs - System.currentTimeMillis());
        Data data = new Data.Builder()
            .putString("action", action)
            .putLong(EXTRA_START_MS, triggerAtMs)
            .putLong(EXTRA_END_MS, endMs)
            .build();
        OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(AttendanceScheduleWorker.class)
            .setInitialDelay(delay, TimeUnit.MILLISECONDS)
            .setInputData(data)
            .addTag("scorr_attendance")
            .addTag("scorr_att_" + reqCode)
            .build();
        WorkManager.getInstance(app).enqueueUniqueWork(
            "scorr_att_" + reqCode,
            ExistingWorkPolicy.REPLACE,
            work
        );
    }

    static void cancelAllAlarms(Context app) {
        AlarmManager am = (AlarmManager) app.getSystemService(Context.ALARM_SERVICE);
        for (int i = 0; i < MAX_WINDOWS; i++) {
            cancelOne(app, am, ACTION_WINDOW_START, REQ_BASE_START + i);
            cancelOne(app, am, ACTION_WINDOW_END, REQ_BASE_END + i);
        }
        try {
            WorkManager.getInstance(app).cancelAllWorkByTag("scorr_attendance");
        } catch (Exception ignored) {
        }
    }

    private static void cancelOne(Context app, AlarmManager am, String action, int reqCode) {
        Intent intent = new Intent(app, AttendanceWindowReceiver.class);
        intent.setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pi = PendingIntent.getBroadcast(app, reqCode, intent, flags);
        if (am != null) am.cancel(pi);
        try {
            pi.cancel();
        } catch (Exception ignored) {
        }
    }

    static List<Window> parseWindows(Context app) {
        List<Window> out = new ArrayList<>();
        String raw = AttendancePingStore.scheduleJson(app);
        if (raw == null) return out;
        try {
            JSONObject json = new JSONObject(raw);
            JSONArray windows = json.optJSONArray("windows");
            if (windows == null) return out;
            for (int i = 0; i < windows.length(); i++) {
                JSONObject w = windows.getJSONObject(i);
                Long start = parseUtcMillis(w.optString("window_start_utc", null));
                Long end = parseUtcMillis(w.optString("window_end_utc", null));
                if (start != null && end != null && end > start) {
                    out.add(new Window(start, end));
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "parse windows", e);
        }
        return out;
    }

    static List<Zone> parseZones(Context app) {
        List<Zone> out = new ArrayList<>();
        String raw = AttendancePingStore.scheduleJson(app);
        if (raw == null) return out;
        try {
            JSONObject json = new JSONObject(raw);
            JSONArray zones = json.optJSONArray("zones");
            if (zones == null) return out;
            for (int i = 0; i < zones.length(); i++) {
                JSONObject z = zones.getJSONObject(i);
                String id = z.optString("zone_id", z.optString("id", null));
                if (id == null || id.isEmpty()) continue;
                double lat = z.optDouble("latitude", z.optDouble("lat", Double.NaN));
                double lng = z.optDouble("longitude", z.optDouble("lng", Double.NaN));
                if (Double.isNaN(lat) || Double.isNaN(lng)) continue;
                float radius = (float) z.optDouble("radius_meters", z.optDouble("radius", 150));
                if (radius < 50f) radius = 50f;
                out.add(new Zone(
                    id, lat, lng, radius,
                    z.optString("detection_mode", "gps_or_wifi"),
                    z.optJSONArray("wifi_ssids"),
                    z.optJSONArray("wifi_bssids")
                ));
            }
        } catch (Exception e) {
            Log.w(TAG, "parse zones", e);
        }
        return out;
    }

    static Long parseUtcMillis(String iso) {
        if (iso == null || iso.isEmpty()) return null;
        String normalized = iso.trim();
        if (normalized.indexOf('T') < 0 && normalized.indexOf(' ') > 0) {
            normalized = normalized.replace(' ', 'T');
        }
        // Normalize trailing Z / offsets for SimpleDateFormat (API 24 safe).
        String[] patterns = new String[]{
            "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
            "yyyy-MM-dd'T'HH:mm:ssXXX",
            "yyyy-MM-dd'T'HH:mm:ss.SSSZ",
            "yyyy-MM-dd'T'HH:mm:ssZ",
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
            "yyyy-MM-dd'T'HH:mm:ss'Z'",
            "yyyy-MM-dd'T'HH:mm:ss.SSS",
            "yyyy-MM-dd'T'HH:mm:ss"
        };
        for (String pattern : patterns) {
            try {
                SimpleDateFormat fmt = new SimpleDateFormat(pattern, Locale.US);
                if (pattern.endsWith("'Z'") || pattern.endsWith("Z") || !pattern.contains("X")) {
                    // bare / Z patterns — treat as UTC
                    if (!pattern.contains("X") && !pattern.endsWith("Z")) {
                        fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
                    }
                }
                return fmt.parse(normalized).getTime();
            } catch (Exception ignored) {
            }
        }
        // Last resort: strip timezone and parse as UTC
        try {
            String bare = normalized.replaceAll("([Zz]|[+-]\\d{2}:?\\d{2})$", "");
            SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US);
            fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
            return fmt.parse(bare).getTime();
        } catch (Exception e) {
            Log.w(TAG, "bad timestamp: " + iso);
            return null;
        }
    }

    private static String readStream(InputStream in) {
        if (in == null) return "";
        try (BufferedReader br = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }
}
