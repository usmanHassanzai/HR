package ai.walfia.scorr;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.Executors;

/**
 * In-app APK updater — download + FileProvider install without uninstalling.
 * Login / Preferences / attendance device token survive package replacement.
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    @PluginMethod
    public void getNativeVersion(PluginCall call) {
        try {
            PackageManager pm = getContext().getPackageManager();
            PackageInfo info;
            if (Build.VERSION.SDK_INT >= 33) {
                info = pm.getPackageInfo(getContext().getPackageName(), PackageManager.PackageInfoFlags.of(0));
            } else {
                info = pm.getPackageInfo(getContext().getPackageName(), 0);
            }
            JSObject out = new JSObject();
            out.put("versionName", info.versionName != null ? info.versionName : "");
            long code = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
            out.put("versionCode", code);
            out.put("packageName", getContext().getPackageName());
            call.resolve(out);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("Missing url");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("Missing url");
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("No activity");
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (!getContext().getPackageManager().canRequestPackageInstalls()) {
                try {
                    Intent settings = new Intent(
                        android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName())
                    );
                    settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(settings);
                } catch (Exception ignored) {
                }
                call.reject("Allow installs from this app in Settings, then tap Install again.");
                return;
            }
        }

        Executors.newSingleThreadExecutor().execute(() -> {
            File outFile = new File(getContext().getCacheDir(), "scorr-update.apk");
            try {
                HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(120000);
                conn.setInstanceFollowRedirects(true);
                conn.connect();
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    call.reject("Download failed HTTP " + code);
                    return;
                }
                try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(outFile)) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                    }
                }
                Uri uri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    outFile
                );
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                JSObject ok = new JSObject();
                ok.put("ok", true);
                call.resolve(ok);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "Download failed");
            }
        });
    }
}
