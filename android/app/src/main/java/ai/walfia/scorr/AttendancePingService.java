package ai.walfia.scorr;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationManager;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import androidx.annotation.Nullable;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class AttendancePingService extends Service {
    private static final String CHANNEL_ID = "scorr_attendance_gps";
    private static final long INTERVAL_MS = 5 * 60 * 1000L;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Runnable tick = this::runPingThenSchedule;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        handler.removeCallbacks(tick);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(tick);
        io.shutdownNow();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void runPingThenSchedule() {
        requestLocation();
        handler.postDelayed(tick, INTERVAL_MS);
    }

    private void requestLocation() {
        if (ActivityCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED
            && ActivityCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_COARSE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        LocationManager lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (lm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            String provider = lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
                ? LocationManager.GPS_PROVIDER
                : LocationManager.NETWORK_PROVIDER;
            lm.getCurrentLocation(provider, new CancellationSignal(), getMainExecutor(), this::sendPing);
            return;
        }
        Location loc = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER);
        if (loc == null) loc = lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
        sendPing(loc);
    }

    private void sendPing(Location loc) {
        if (loc == null) return;
        String base = AttendancePingStore.url(this);
        String anon = AttendancePingStore.anon(this);
        String token = AttendancePingStore.token(this);
        if (base == null || anon == null || token == null) return;
        final double lat = loc.getLatitude();
        final double lng = loc.getLongitude();
        final float acc = loc.hasAccuracy() ? loc.getAccuracy() : 40f;
        io.execute(() -> postRpc(base, anon, token, lat, lng, acc));
    }

    private static void postRpc(String base, String anon, String token, double lat, double lng, float acc) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(base.replaceAll("/$", "") + "/rest/v1/rpc/process_geo_attendance_ping");
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(20000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("apikey", anon);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            String body = "{\"p_latitude\":" + lat + ",\"p_longitude\":" + lng + ",\"p_accuracy\":" + acc + "}";
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(bytes);
            }
            conn.getResponseCode();
        } catch (Exception ignored) {
            /* keep checked in if the ping cannot be sent */
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Attendance location",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Scorr checks whether you are inside the office radius every 5 minutes.");
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(channel);
    }
}
