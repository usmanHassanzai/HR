package ai.walfia.scorr;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.location.Location;
import android.os.Build;
import android.util.Log;
import androidx.core.app.NotificationCompat;
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
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Posts auto-attendance events with device-token auth (never JWT).
 * Rejects mock locations, queues offline with UTC timestamps, notifies on clock in/out.
 */
final class AttendanceEventClient {
    private static final String TAG = "ScorrAttEvent";
    private static final String NOTIFY_CHANNEL = "scorr_attendance_events";
    private static final int NOTIFY_ID = 42;
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    private AttendanceEventClient() {}

    static boolean isMockLocation(Location loc) {
        if (loc == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return loc.isMock();
        }
        // noinspection deprecation
        return loc.isFromMockProvider();
    }

    static void sendLocationEvent(Context ctx, String event, Location loc, String zoneId) {
        if (loc == null) return;
        if (isMockLocation(loc)) {
            Log.w(TAG, "Rejected mock location for event=" + event);
            return;
        }
        Double lat = loc.getLatitude();
        Double lng = loc.getLongitude();
        Float acc = loc.hasAccuracy() ? loc.getAccuracy() : null;
        send(ctx, event, zoneId, lat, lng, acc, null, null);
    }

    static void sendWifiEvent(Context ctx, String event, String ssid, String bssid) {
        send(ctx, event, null, null, null, null, ssid, bssid);
    }

    static void send(Context ctx, String event, String zoneId,
                     Double lat, Double lng, Float accuracyM,
                     String ssid, String bssid) {
        Context app = ctx.getApplicationContext();
        if (!AttendancePingStore.enabled(app)) return;
        // Never emit attendance signals outside W (R70).
        if (!AttendancePingStore.isInsideActiveWindow(app)) {
            Log.d(TAG, "Skip event outside window: " + event);
            return;
        }

        long now = System.currentTimeMillis();
        try {
            JSONObject body = new JSONObject();
            body.put("device_token", AttendancePingStore.deviceToken(app));
            body.put("event", event);
            if (zoneId != null) body.put("zone_id", zoneId);
            if (lat != null) body.put("lat", lat);
            if (lng != null) body.put("lng", lng);
            if (accuracyM != null) body.put("accuracy_m", accuracyM.doubleValue());
            if (ssid != null) body.put("ssid", stripQuotes(ssid));
            if (bssid != null) body.put("bssid", bssid.toLowerCase(Locale.US));
            body.put("occurred_at_utc_ms", now);
            body.put("device_now_utc_ms", now);
            body.put("device_timezone", AttendancePingStore.deviceTimezone());
            body.put("is_mock", false);
            body.put("device_id", AttendancePingStore.deviceId(app));
            body.put("platform", "android");
            body.put("app_version", AttendancePingStore.appVersion(app));

            IO.execute(() -> postOrQueue(app, body));
        } catch (Exception e) {
            Log.w(TAG, "build event failed", e);
        }
    }

    static void flushQueue(Context ctx) {
        Context app = ctx.getApplicationContext();
        IO.execute(() -> {
            JSONArray queue = AttendancePingStore.drainQueue(app);
            JSONArray failed = new JSONArray();
            for (int i = 0; i < queue.length(); i++) {
                try {
                    JSONObject body = queue.getJSONObject(i);
                    body.put("device_now_utc_ms", System.currentTimeMillis());
                    if (!postOnce(app, body)) {
                        failed.put(body);
                    }
                } catch (Exception e) {
                    /* drop corrupt */
                }
            }
            if (failed.length() > 0) {
                AttendancePingStore.restoreQueue(app, failed);
            }
        });
    }

    private static void postOrQueue(Context app, JSONObject body) {
        if (!postOnce(app, body)) {
            AttendancePingStore.enqueueEvent(app, body);
        }
    }

    private static boolean postOnce(Context app, JSONObject body) {
        String base = AttendancePingStore.url(app);
        String anon = AttendancePingStore.anon(app);
        String token = AttendancePingStore.deviceToken(app);
        if (base == null || anon == null || token == null) return false;

        HttpURLConnection conn = null;
        try {
            URL url = new URL(base.replaceAll("/$", "") + "/functions/v1/auto-attendance-event");
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(20000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("apikey", anon);
            conn.setRequestProperty("x-device-token", token);
            // Device-token auth only — never send JWT Authorization.
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(bytes);
            }
            int code = conn.getResponseCode();
            String respText = readStream(
                code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream()
            );
            if (code >= 200 && code < 300) {
                handleResponse(app, respText);
                return true;
            }
            if (code == 401) {
                try {
                    JSONObject err = new JSONObject(respText);
                    if (err.optBoolean("stop_tracking", false)) {
                        AttendanceScheduleController.stopAll(app);
                    }
                } catch (Exception ignored) {
                }
            }
            Log.w(TAG, "event HTTP " + code + ": " + respText);
            return false;
        } catch (Exception e) {
            Log.w(TAG, "post failed", e);
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static void handleResponse(Context app, String respText) {
        try {
            JSONObject json = new JSONObject(respText);
            if (json.optBoolean("stop_tracking", false)) {
                AttendanceScheduleController.stopAll(app);
                return;
            }
            String action = json.optString("action", "");
            if ("clock_in".equals(action) || "clock_out".equals(action)) {
                showCheckNotification(app, action, json);
            }
        } catch (Exception e) {
            Log.w(TAG, "parse response", e);
        }
    }

    private static void showCheckNotification(Context app, String action, JSONObject json) {
        createNotifyChannel(app);
        boolean checkIn = "clock_in".equals(action);
        String title = checkIn ? "Checked in" : "Checked out";

        String localTime = firstString(json,
            "local_time", "local_check_time", "check_local_time", "device_local_time");
        String officeTime = firstString(json,
            "office_time", "office_check_time", "check_office_time", "company_local_time");

        long occurredMs = parseOccurredMs(json);
        if (localTime == null && occurredMs > 0) {
            localTime = formatInTz(occurredMs, AttendancePingStore.deviceTimezone());
        }
        if (officeTime == null && occurredMs > 0) {
            officeTime = formatInTz(occurredMs, AttendancePingStore.companyTz(app));
        }

        String notifyMsg = firstString(json, "notify_message");
        StringBuilder text = new StringBuilder();
        if (notifyMsg != null) {
            text.append(notifyMsg);
        } else if (!checkIn && localTime != null) {
            text.append("Checked out at ").append(localTime).append(" — you left the office.");
        } else {
            text.append(checkIn ? "Auto check-in" : "Auto check-out");
            if (localTime != null && officeTime != null && !localTime.equals(officeTime)) {
                text.append(": ").append(localTime).append(" (local) / ").append(officeTime).append(" (office)");
            } else if (localTime != null) {
                text.append(" at ").append(localTime);
            } else if (officeTime != null) {
                text.append(" at ").append(officeTime).append(" (office)");
            }
        }

        NotificationCompat.Builder builder = new NotificationCompat.Builder(app, NOTIFY_CHANNEL)
            .setContentTitle(title)
            .setContentText(text.toString())
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text.toString()))
            .setSmallIcon(R.mipmap.ic_launcher)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT);

        NotificationManager nm = app.getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTIFY_ID + (checkIn ? 1 : 2), builder.build());
    }

    private static String firstString(JSONObject json, String... keys) {
        for (String k : keys) {
            if (json.has(k) && !json.isNull(k)) {
                String v = json.optString(k, "").trim();
                if (!v.isEmpty()) return v;
            }
        }
        return null;
    }

    private static long parseOccurredMs(JSONObject json) {
        if (json.has("occurred_at_utc_ms")) {
            return json.optLong("occurred_at_utc_ms", 0L);
        }
        String iso = json.optString("occurred_at", null);
        if (iso == null || iso.isEmpty()) return System.currentTimeMillis();
        Long ms = AttendanceScheduleController.parseUtcMillis(iso);
        return ms != null ? ms : System.currentTimeMillis();
    }

    private static String formatInTz(long epochMs, String tzId) {
        try {
            SimpleDateFormat fmt = new SimpleDateFormat("h:mm a", Locale.getDefault());
            fmt.setTimeZone(TimeZone.getTimeZone(tzId != null ? tzId : "UTC"));
            return fmt.format(new Date(epochMs));
        } catch (Exception e) {
            return null;
        }
    }

    private static String stripQuotes(String ssid) {
        if (ssid == null) return null;
        String s = ssid.trim();
        if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) {
            return s.substring(1, s.length() - 1);
        }
        if ("<unknown ssid>".equalsIgnoreCase(s)) return null;
        return s;
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

    private static void createNotifyChannel(Context app) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            NOTIFY_CHANNEL,
            "Attendance check-in/out",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("Notifies you when Scorr automatically checks you in or out.");
        NotificationManager nm = app.getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(channel);
    }
}
