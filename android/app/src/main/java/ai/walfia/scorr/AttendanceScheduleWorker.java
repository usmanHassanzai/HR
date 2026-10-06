package ai.walfia.scorr;

import android.content.Context;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/**
 * WorkManager fallback when exact AlarmManager scheduling is unavailable.
 */
public class AttendanceScheduleWorker extends Worker {
    private static final String TAG = "ScorrAttWorker";

    public AttendanceScheduleWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context app = getApplicationContext();
        if (!AttendancePingStore.enabled(app)) return Result.success();

        String action = getInputData().getString("action");
        long startMs = getInputData().getLong(AttendanceScheduleController.EXTRA_START_MS, 0L);
        long endMs = getInputData().getLong(AttendanceScheduleController.EXTRA_END_MS, 0L);
        Log.i(TAG, "work action=" + action);

        if (AttendanceScheduleController.ACTION_WINDOW_START.equals(action)) {
            if (endMs <= 0) endMs = System.currentTimeMillis() + 12L * 60 * 60 * 1000;
            AttendanceScheduleController.enterWindow(
                app,
                startMs > 0 ? startMs : System.currentTimeMillis(),
                endMs
            );
        } else if (AttendanceScheduleController.ACTION_WINDOW_END.equals(action)) {
            AttendanceScheduleController.exitWindow(app);
            AttendanceScheduleController.armFromCache(app);
        }
        return Result.success();
    }
}
