package ai.walfia.scorr;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AttendancePing")
public class AttendancePingPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        String url = call.getString("supabaseUrl");
        String anon = call.getString("anonKey");
        String token = call.getString("accessToken");
        if (url == null || anon == null || token == null) {
            call.reject("Missing attendance ping credentials");
            return;
        }
        AttendancePingStore.save(getContext(), url, anon, token);
        Context ctx = getContext();
        Intent intent = new Intent(ctx, AttendancePingService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(intent);
        } else {
            ctx.startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void updateSession(PluginCall call) {
        String token = call.getString("accessToken");
        if (token == null) {
            call.reject("Missing access token");
            return;
        }
        AttendancePingStore.saveToken(getContext(), token);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), AttendancePingService.class));
        AttendancePingStore.clear(getContext());
        call.resolve();
    }
}
