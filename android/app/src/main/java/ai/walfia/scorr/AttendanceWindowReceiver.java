package ai.walfia.scorr;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Fires at window_start_utc / window_end_utc exact alarms.
 */
public class AttendanceWindowReceiver extends BroadcastReceiver {
    private static final String TAG = "ScorrAttWindow";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        Context app = context.getApplicationContext();
        if (!AttendancePingStore.enabled(app)) return;

        String action = intent.getAction();
        long startMs = intent.getLongExtra(AttendanceScheduleController.EXTRA_START_MS, 0L);
        long endMs = intent.getLongExtra(AttendanceScheduleController.EXTRA_END_MS, 0L);
        Log.i(TAG, "alarm action=" + action + " start=" + startMs + " end=" + endMs);

        if (AttendanceScheduleController.ACTION_WINDOW_START.equals(action)) {
            if (endMs <= 0) endMs = startMs + 12 * 60 * 60 * 1000L;
            AttendanceScheduleController.enterWindow(app, startMs > 0 ? startMs : System.currentTimeMillis(), endMs);
        } else if (AttendanceScheduleController.ACTION_WINDOW_END.equals(action)) {
            AttendanceScheduleController.exitWindow(app);
            // Re-arm remaining windows from cache (next days).
            AttendanceScheduleController.armFromCache(app);
        }
    }
}
