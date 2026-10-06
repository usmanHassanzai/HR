package ai.walfia.scorr;

import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "AttendancePing")
public class AttendancePingPlugin extends Plugin {

    private final Handler main = new Handler(Looper.getMainLooper());

    @PluginMethod
    public void startAutoAttendance(PluginCall call) {
        String url = call.getString("supabaseUrl");
        String anon = call.getString("anonKey");
        String deviceToken = call.getString("deviceToken");
        String deviceId = call.getString("deviceId");
        String appVersion = call.getString("appVersion");
        if (url == null || anon == null || deviceToken == null || deviceId == null) {
            call.reject("Missing startAutoAttendance fields (supabaseUrl, anonKey, deviceToken, deviceId)");
            return;
        }
        AttendancePingStore.saveAutoAttendance(
            getContext(), url, anon, deviceToken, deviceId, appVersion
        );
        Executors.newSingleThreadExecutor().execute(() -> {
            String err = AttendanceScheduleController.syncAndArm(getContext());
            main.post(() -> {
                if (err != null) call.reject(err);
                else call.resolve();
            });
        });
    }

    @PluginMethod
    public void stopAutoAttendance(PluginCall call) {
        AttendanceScheduleController.stopAll(getContext());
        call.resolve();
    }

    @PluginMethod
    public void syncSchedule(PluginCall call) {
        if (!AttendancePingStore.enabled(getContext())) {
            call.reject("Auto attendance not enabled");
            return;
        }
        Executors.newSingleThreadExecutor().execute(() -> {
            String err = AttendanceScheduleController.syncAndArm(getContext());
            main.post(() -> {
                if (err != null) {
                    call.reject(err);
                } else {
                    JSObject result = new JSObject();
                    result.put("ok", true);
                    call.resolve(result);
                }
            });
        });
    }

    /** @deprecated JWT forever-ping removed — use startAutoAttendance with device token. */
    @PluginMethod
    public void start(PluginCall call) {
        call.reject("Use startAutoAttendance with a device token (JWT pings are disabled)");
    }

    /** @deprecated */
    @PluginMethod
    public void updateSession(PluginCall call) {
        // No JWT session for auto attendance. Re-sync schedule if already enrolled.
        if (AttendancePingStore.enabled(getContext())) {
            syncSchedule(call);
        } else {
            call.resolve();
        }
    }

    /** Alias for stopAutoAttendance for existing JS callers. */
    @PluginMethod
    public void stop(PluginCall call) {
        stopAutoAttendance(call);
    }
}
