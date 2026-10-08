package ai.walfia.scorr;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;
import androidx.core.content.ContextCompat;
import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofencingClient;
import com.google.android.gms.location.GeofencingRequest;
import com.google.android.gms.location.LocationServices;
import java.util.ArrayList;
import java.util.List;

/**
 * Registers ENTER+EXIT geofences for the active shift window only.
 * Expiration matches window_end_utc; INITIAL_TRIGGER_ENTER (R38–R39).
 */
final class AttendanceGeofenceManager {
    private static final String TAG = "ScorrAttGeofence";
    private static final String GEOFENCE_ACTION = "ai.walfia.scorr.ATTENDANCE_GEOFENCE";
    private static final int PI_REQ = 7301;

    private AttendanceGeofenceManager() {}

    static void registerForActiveWindow(Context ctx, long windowEndMs) {
        Context app = ctx.getApplicationContext();
        if (!hasLocationPermission(app)) {
            Log.w(TAG, "Missing location permission for geofences");
            return;
        }

        List<AttendanceScheduleController.Zone> zones = AttendanceScheduleController.parseZones(app);
        List<Geofence> fences = new ArrayList<>();
        long now = System.currentTimeMillis();
        long expire = Math.max(60_000L, windowEndMs - now);

        for (AttendanceScheduleController.Zone z : zones) {
            if (!z.usesGps()) continue;
            fences.add(new Geofence.Builder()
                .setRequestId(z.zoneId)
                .setCircularRegion(z.lat, z.lng, z.radiusM)
                .setExpirationDuration(expire)
                .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER | Geofence.GEOFENCE_TRANSITION_EXIT)
                .setLoiteringDelay(0)
                .setNotificationResponsiveness(0)
                .build());
        }

        GeofencingClient client = LocationServices.getGeofencingClient(app);
        // Always clear previous fences first.
        PendingIntent pi = geofencePendingIntent(app);
        client.removeGeofences(pi).addOnCompleteListener(task -> {
            if (fences.isEmpty()) {
                Log.d(TAG, "No GPS zones to register");
                return;
            }
            GeofencingRequest request = new GeofencingRequest.Builder()
                .setInitialTrigger(GeofencingRequest.INITIAL_TRIGGER_ENTER)
                .addGeofences(fences)
                .build();
            try {
                client.addGeofences(request, pi)
                    .addOnSuccessListener(v -> Log.i(TAG, "Registered " + fences.size() + " geofences"))
                    .addOnFailureListener(e -> Log.e(TAG, "addGeofences failed", e));
            } catch (SecurityException se) {
                Log.e(TAG, "geofence security", se);
            }
        });
    }

    static void removeAll(Context ctx) {
        Context app = ctx.getApplicationContext();
        try {
            LocationServices.getGeofencingClient(app)
                .removeGeofences(geofencePendingIntent(app))
                .addOnFailureListener(e -> Log.w(TAG, "removeGeofences", e));
        } catch (Exception e) {
            Log.w(TAG, "removeGeofences error", e);
        }
    }

    static PendingIntent geofencePendingIntent(Context app) {
        Intent intent = new Intent(app, AttendanceGeofenceReceiver.class);
        intent.setAction(GEOFENCE_ACTION);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        // Geofencing requires a mutable PendingIntent on API 31+.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            flags |= PendingIntent.FLAG_MUTABLE;
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(app, PI_REQ, intent, flags);
    }

    private static boolean hasLocationPermission(Context app) {
        boolean fine = ContextCompat.checkSelfPermission(app, Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED;
        boolean coarse = ContextCompat.checkSelfPermission(app, Manifest.permission.ACCESS_COARSE_LOCATION)
            == PackageManager.PERMISSION_GRANTED;
        return fine || coarse;
    }
}
