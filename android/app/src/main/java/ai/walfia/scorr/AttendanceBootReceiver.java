package ai.walfia.scorr;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import java.util.concurrent.Executors;

/**
 * Re-sync schedule and re-arm after boot, app update, or clock/timezone changes (R41).
 */
public class AttendanceBootReceiver extends BroadcastReceiver {
    private static final String TAG = "ScorrAttBoot";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        Context app = context.getApplicationContext();
        if (!AttendancePingStore.enabled(app)) {
            Log.d(TAG, "skip " + intent.getAction() + " — auto attendance off");
            return;
        }

        String action = intent.getAction();
        Log.i(TAG, "re-sync for " + action);
        final BroadcastReceiver.PendingResult pending = goAsync();
        Executors.newSingleThreadExecutor().execute(() -> {
            try {
                if ("scorr.action.RESTART_FGS".equals(action)) {
                    // Swipe-away delayed restart — keep FGS + heartbeats without a full sync wait.
                    AttendanceScheduleController.armFromCache(app);
                    if (AttendancePingStore.isInsideActiveWindow(app)) {
                        AttendancePingService.start(app);
                    }
                    return;
                }
                AttendanceScheduleController.syncAndArm(app);
                // After reboot / app update: if already inside W, FGS must be running now.
                if (AttendancePingStore.isInsideActiveWindow(app)) {
                    AttendancePingService.start(app);
                }
            } finally {
                pending.finish();
            }
        });
    }
}
