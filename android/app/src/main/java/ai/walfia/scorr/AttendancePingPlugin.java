package ai.walfia.scorr;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
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

    @PluginMethod
    public void saveLoginCredentials(PluginCall call) {
        String email = call.getString("email");
        String password = call.getString("password");
        if (email == null || email.isEmpty() || password == null || password.isEmpty()) {
            call.reject("Missing email or password");
            return;
        }
        AttendancePingStore.saveLoginCredentials(getContext(), email.trim(), password);
        call.resolve();
    }

    @PluginMethod
    public void loadLoginCredentials(PluginCall call) {
        JSObject result = new JSObject();
        String email = AttendancePingStore.loginEmail(getContext());
        String password = AttendancePingStore.loginPassword(getContext());
        result.put("email", email != null ? email : "");
        result.put("password", password != null ? password : "");
        call.resolve(result);
    }

    @PluginMethod
    public void clearLoginCredentials(PluginCall call) {
        AttendancePingStore.clearLoginCredentials(getContext());
        call.resolve();
    }

    /** Admin "Test office Wi-Fi" — SSID/BSSID seen on this device. */
    @PluginMethod
    public void probeNetwork(PluginCall call) {
        String ssid = null;
        String bssid = null;
        try {
            Context ctx = getContext().getApplicationContext();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm != null) {
                    Network net = cm.getActiveNetwork();
                    if (net != null) {
                        NetworkCapabilities caps = cm.getNetworkCapabilities(net);
                        if (caps != null) {
                            Object transport = caps.getTransportInfo();
                            if (transport instanceof WifiInfo) {
                                WifiInfo wi = (WifiInfo) transport;
                                ssid = wi.getSSID();
                                bssid = wi.getBSSID();
                            }
                        }
                    }
                }
            }
            if (ssid == null || bssid == null) {
                WifiManager wm = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    WifiInfo info = wm.getConnectionInfo();
                    if (info != null) {
                        if (ssid == null) ssid = info.getSSID();
                        if (bssid == null) bssid = info.getBSSID();
                    }
                }
            }
        } catch (Exception ignored) {
        }
        if (ssid != null) {
            ssid = ssid.replace("\"", "");
            if ("<unknown ssid>".equalsIgnoreCase(ssid)) ssid = null;
        }
        JSObject result = new JSObject();
        result.put("ssid", ssid != null ? ssid : "");
        result.put("bssid", bssid != null ? bssid : "");
        call.resolve(result);
    }
}
