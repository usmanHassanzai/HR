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
 * Drops queued readings older than 10 minutes; sends only the newest fresh event.
 */
final class AttendanceEventClient {
    private static final String TAG = "ScorrAttEvent";
    private static final String NOTIFY_CHANNEL = "scorr_attendance_events";
    private static final String STATUS_CHANNEL = "scorr_attendance_status";
    private static final int NOTIFY_ID = 42;
    private static final int STATUS_NOTIFY_ID = 41;
    /** Drop queued events older than 10 minutes. */
    private static final long MAX_EVENT_AGE_MS = 10L * 60L * 1000L;
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

    /** Fresh event time: never trust stale GPS fix timestamps (they caused event_too_old). */
    static long freshOccurredMs(Location loc) {
        long now = System.currentTimeMillis();
        if (loc == null) return now;
        long t = loc.getTime();
        if (t <= 0) return now;
        // Accept GPS time only when it is recent; otherwise use device now.
        if (now - t > 2L * 60L * 1000L || t - now > 60L * 1000L) return now;
        return t;
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
        send(ctx, event, zoneId, lat, lng, acc, null, null, freshOccurredMs(loc));
    }

    /** GPS + Wi-Fi in one event when a usable fix is available. */
    static void sendCombined(Context ctx, String event, Location loc, String zoneId,
                             String ssid, String bssid) {
        if (loc == null) {
            sendWifiOnly(ctx, event, ssid, bssid);
            return;
        }
        if (isMockLocation(loc)) {
            Log.w(TAG, "Rejected mock location for event=" + event);
            return;
        }
        Double lat = loc.getLatitude();
        Double lng = loc.getLongitude();
        Float acc = loc.hasAccuracy() ? loc.getAccuracy() : null;
        send(ctx, event, zoneId, lat, lng, acc, ssid, bssid, freshOccurredMs(loc));
    }

    /** Office Wi-Fi event with no GPS (location off / timed out). */
    static void sendWifiOnly(Context ctx, String event, String ssid, String bssid) {
        Context app = ctx.getApplicationContext();
        if (!AttendancePingStore.enabled(app)) return;
        try {
            JSONObject body = new JSONObject();
            body.put("device_token", AttendancePingStore.deviceToken(app));
            body.put("event", event);
            if (ssid != null) body.put("ssid", stripQuotes(ssid));
            if (bssid != null) body.put("bssid", bssid.toLowerCase(Locale.US));
            long now = System.currentTimeMillis();
            body.put("occurred_at_utc_ms", now);
            body.put("device_now_utc_ms", now);
            body.put("device_timezone", AttendancePingStore.deviceTimezone());
            body.put("is_mock", false);
            body.put("gps_available", false);
            body.put("device_id", AttendancePingStore.deviceId(app));
            body.put("platform", "android");
            body.put("app_version", AttendancePingStore.appVersion(app));
            IO.execute(() -> postOrQueue(app, body));
        } catch (Exception e) {
            Log.w(TAG, "build wifi-only event failed", e);
        }
    }

    static void sendWifiEvent(Context ctx, String event, String ssid, String bssid) {
        send(ctx, event, null, null, null, null, ssid, bssid);
    }

    static void send(Context ctx, String event, String zoneId,
                     Double lat, Double lng, Float accuracyM,
                     String ssid, String bssid) {
        send(ctx, event, zoneId, lat, lng, accuracyM, ssid, bssid, null);
    }

    static void send(Context ctx, String event, String zoneId,
                     Double lat, Double lng, Float accuracyM,
                     String ssid, String bssid, Long occurredAtUtcMs) {
        Context app = ctx.getApplicationContext();
        if (!AttendancePingStore.enabled(app)) return;

        long now = System.currentTimeMillis();
        long occurred = occurredAtUtcMs != null && occurredAtUtcMs > 0 ? occurredAtUtcMs : now;
        if (now - occurred > MAX_EVENT_AGE_MS) {
            logStaleDrop(app, event, occurred, now - occurred, "pre-send");
            return;
        }
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
            body.put("occurred_at_utc_ms", occurred);
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

    /** Flush offline queue: drop stale, send newest fresh reading only. */
    static void flushQueue(Context ctx) {
        Context app = ctx.getApplicationContext();
        IO.execute(() -> {
            JSONArray queue = AttendancePingStore.drainQueue(app);
            long now = System.currentTimeMillis();
            JSONObject newest = null;
            long newestOccurred = -1;
            for (int i = 0; i < queue.length(); i++) {
                try {
                    JSONObject body = queue.getJSONObject(i);
                    long occurred = body.optLong("occurred_at_utc_ms", 0L);
                    if (occurred <= 0 || now - occurred > MAX_EVENT_AGE_MS) {
                        logStaleDrop(
                            app,
                            body.optString("event", "?"),
                            occurred,
                            occurred > 0 ? now - occurred : -1,
                            "queue-flush"
                        );
                        continue;
                    }
                    if (occurred >= newestOccurred) {
                        newestOccurred = occurred;
                        newest = body;
                    } else {
                        logStaleDrop(
                            app,
                            body.optString("event", "?"),
                            occurred,
                            now - occurred,
                            "queue-superseded"
                        );
                    }
                } catch (Exception e) {
                    /* drop corrupt */
                }
            }
            if (newest == null) return;
            try {
                newest.put("device_now_utc_ms", System.currentTimeMillis());
                if (!postOnce(app, newest)) {
                    JSONArray failed = new JSONArray();
                    failed.put(newest);
                    AttendancePingStore.restoreQueue(app, failed);
                    updateStatusNotification(app, "No connection - will check when online", null);
                }
            } catch (Exception e) {
                Log.w(TAG, "flush newest failed", e);
            }
        });
    }

    private static void postOrQueue(Context app, JSONObject body) {
        if (!postOnce(app, body)) {
            AttendancePingStore.enqueueEvent(app, body);
            updateStatusNotification(app, "No connection - will check when online", null);
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
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(12000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("apikey", anon);
            conn.setRequestProperty("x-device-token", token);
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
                handleResponse(app, respText, body);
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

    private static void handleResponse(Context app, String respText, JSONObject requestBody) {
        try {
            JSONObject json = new JSONObject(respText);
            if (json.optBoolean("stop_tracking", false)) {
                AttendanceScheduleController.stopAll(app);
                return;
            }
            String action = json.optString("action", "");
            String reason = json.optString("reason", action);
            if ("clock_in".equals(action)) {
                showCheckNotification(app, action, json);
                String src = firstString(json, "attendance_source", "source");
                boolean noGps = "auto_wifi_no_gps".equals(src)
                    || (requestBody != null && !requestBody.has("lat"));
                String msg = noGps
                    ? "Checked in on office Wi-Fi (location is off)"
                    : "Checked in";
                String localTime = firstString(json, "local_time", "local_check_time");
                long occurredMs = parseOccurredMs(json);
                if (localTime == null && occurredMs > 0) {
                    localTime = formatInTz(occurredMs, AttendancePingStore.deviceTimezone());
                }
                if (!noGps && localTime != null) msg = "Checked in at " + localTime;
                updateStatusNotification(app, msg, requestBody);
            } else if ("clock_out".equals(action)) {
                showCheckNotification(app, action, json);
                String localTime = firstString(json, "local_time", "local_check_time");
                long occurredMs = parseOccurredMs(json);
                if (localTime == null && occurredMs > 0) {
                    localTime = formatInTz(occurredMs, AttendancePingStore.deviceTimezone());
                }
                String msg = localTime != null
                    ? "Checked out - left the office radius at " + localTime
                    : "Checked out";
                updateStatusNotification(app, msg, requestBody);
            } else if (!action.isEmpty() && !"none".equals(action) && !"already_clocked_in".equals(action)
                && !"already_checked_in".equals(action)) {
                // Surface exact rejection reason (e.g. not_on_office_wifi, outside_radius).
                showRejectNotification(app, humanReason(reason));
                updateStatusNotification(app, humanReason(reason), requestBody);
            } else {
                updateStatusNotification(app, null, requestBody);
            }
            AttendancePingStore.setLastServerAction(app, action, System.currentTimeMillis());
        } catch (Exception e) {
            Log.w(TAG, "parse response", e);
        }
    }

    private static String humanReason(String reason) {
        if (reason == null || reason.isEmpty()) return "Attendance update";
        switch (reason) {
            case "not_on_office_wifi":
            case "not_on_office_network":
                return "Connect to the office Wi-Fi";
            case "outside_radius":
            case "outside_office":
                return "You are outside the office radius";
            case "gps_unusable":
            case "need_fresh_location":
                return "Location unavailable, try again";
            case "checkin_blocked_shift_ended":
                return "The shift has ended. You cannot check in.";
            case "outside_window":
                return "Outside the attendance window";
            case "event_too_old":
                return "Reading was too old — get a fresh location";
            case "already_clocked_in":
                return "Checked in";
            default:
                // Never show raw database / plpgsql errors.
                if (reason.contains("v_chk") || reason.contains("not assigned")
                    || reason.contains("PL/pgSQL") || reason.contains("SQLSTATE")) {
                    return "Clock out failed, please try again";
                }
                if (reason.contains(" ") || reason.contains("\n")) {
                    return "Clock out failed, please try again";
                }
                return reason.replace('_', ' ');
        }
    }

    private static void showCheckNotification(Context app, String action, JSONObject json) {
        createNotifyChannel(app);
        boolean checkIn = "clock_in".equals(action);
        String title = checkIn ? "Checked in" : "Checked out";

        String localTime = firstString(json,
            "local_time", "local_check_time", "check_local_time", "device_local_time");
        long occurredMs = parseOccurredMs(json);
        if (localTime == null && occurredMs > 0) {
            localTime = formatInTz(occurredMs, AttendancePingStore.deviceTimezone());
        }

        String text;
        if (checkIn) {
            String src = firstString(json, "attendance_source", "source");
            boolean noGps = "auto_wifi_no_gps".equals(src) || "manual_wifi_no_gps".equals(src);
            if (noGps) {
                text = "Checked in on office Wi-Fi (location is off)";
            } else {
                text = localTime != null ? "Checked in at " + localTime : "Checked in";
            }
        } else if (localTime != null) {
            text = "Checked out - left the office radius at " + localTime;
        } else {
            text = "Checked out";
        }

        NotificationCompat.Builder builder = new NotificationCompat.Builder(app, NOTIFY_CHANNEL)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setSmallIcon(R.mipmap.ic_launcher)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT);

        NotificationManager nm = app.getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTIFY_ID + (checkIn ? 1 : 2), builder.build());
    }

    private static void showRejectNotification(Context app, String reason) {
        if (reason == null || reason.isEmpty()) return;
        createNotifyChannel(app);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(app, NOTIFY_CHANNEL)
            .setContentTitle("Attendance check")
            .setContentText(reason)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(reason))
            .setSmallIcon(R.mipmap.ic_launcher)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_LOW);
        NotificationManager nm = app.getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTIFY_ID + 3, builder.build());
    }

    static void updateStatusNotification(Context app, String statusOverride, JSONObject lastBody) {
        createStatusChannel(app);
        String status = statusOverride;
        if (status == null || status.isEmpty()) {
            status = AttendancePingStore.lastStatusText(app);
            if (status == null || status.isEmpty()) status = "Tracking office presence";
        } else {
            AttendancePingStore.setLastStatusText(app, status);
        }

        StringBuilder text = new StringBuilder(status);
        if (lastBody != null) {
            if (lastBody.has("lat") && lastBody.has("lng")) {
                text.append(" · GPS ok");
            }
            long occurred = lastBody.optLong("occurred_at_utc_ms", 0L);
            if (occurred > 0) {
                String t = formatInTz(occurred, AttendancePingStore.deviceTimezone());
                if (t != null) text.append(" · signal ").append(t);
            }
        }

        NotificationCompat.Builder builder = new NotificationCompat.Builder(app, STATUS_CHANNEL)
            .setContentTitle("Scorr attendance")
            .setContentText(text.toString())
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text.toString()))
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW);

        NotificationManager nm = app.getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(STATUS_NOTIFY_ID, builder.build());
    }

    private static void logStaleDrop(Context app, String event, long occurred, long ageMs, String source) {
        Log.i(TAG, "dropped stale event source=" + source
            + " event=" + event
            + " age_ms=" + ageMs
            + " occurred_at_utc_ms=" + occurred);
        AttendancePingStore.recordStaleDrop(app, event, ageMs, source);
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

    private static void createStatusChannel(Context app) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            STATUS_CHANNEL,
            "Attendance location",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Shows current attendance tracking status during your shift.");
        NotificationManager nm = app.getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(channel);
    }
}
