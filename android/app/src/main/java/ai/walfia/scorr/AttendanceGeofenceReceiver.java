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
        if (!AttendancePingStore.isInsideActiveWindow(app)) {
            Log.d(TAG, "Ignoring geofence outside window");
            return;
        }

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

        if (event.getTriggeringLocation() != null) {
            AttendanceEventClient.sendLocationEvent(app, eventName, event.getTriggeringLocation(), zoneId);
        } else {
            AttendanceEventClient.send(app, eventName, zoneId, null, null, null, null, null);
        }
    }
}
