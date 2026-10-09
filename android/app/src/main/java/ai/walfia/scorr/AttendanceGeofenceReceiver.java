package ai.walfia.scorr;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofencingEvent;
import java.util.List;

/**
 * Handles GeofencingClient ENTER / EXIT. Server applies exit hysteresis (R40);
 * client still forwards exit events.
 */
public class AttendanceGeofenceReceiver extends BroadcastReceiver {
    private static final String TAG = "ScorrAttGeofenceRx";

    @Override
    public void onReceive(Context context, Intent intent) {
        Context app = context.getApplicationContext();
        if (!AttendancePingStore.enabled(app)) return;
        // Server decides the attendance window — never drop EXIT/ENTER locally.

        GeofencingEvent event = GeofencingEvent.fromIntent(intent);
        if (event == null) return;
        if (event.hasError()) {
            Log.w(TAG, "Geofence error " + event.getErrorCode());
            return;
        }

        int transition = event.getGeofenceTransition();
        String eventName;
        if (transition == Geofence.GEOFENCE_TRANSITION_ENTER) {
            eventName = "enter";
        } else if (transition == Geofence.GEOFENCE_TRANSITION_EXIT) {
            eventName = "exit";
        } else {
            return;
        }

        List<Geofence> triggering = event.getTriggeringGeofences();
        String zoneId = null;
        if (triggering != null && !triggering.isEmpty()) {
            zoneId = triggering.get(0).getRequestId();
        }

        String[] wifi = AttendancePingStore.readCurrentWifiIdentity(app);
        String ssid = wifi[0];
        String bssid = wifi[1];
        if (ssid == null && bssid == null) {
            ssid = AttendancePingStore.lastSsid(app);
            bssid = AttendancePingStore.lastBssid(app);
        }

        if ("exit".equals(eventName)) {
            // Instant EXIT with a fresh GPS reading (not a cached geofence fix).
            AttendancePingService.sendFreshExit(app, zoneId, ssid, bssid);
        } else {
            // ENTER: ensure FGS is up and send a fresh GPS+Wi-Fi combined check.
            AttendancePingService.start(app);
            AttendancePingService.sendFreshEnter(app, zoneId, ssid, bssid);
        }
    }
}
