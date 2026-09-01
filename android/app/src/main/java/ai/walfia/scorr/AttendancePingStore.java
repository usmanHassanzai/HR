package ai.walfia.scorr;

import android.content.Context;
import android.content.SharedPreferences;

final class AttendancePingStore {
    private static final String PREFS = "scorr_attendance_ping";

    private AttendancePingStore() {}

    static void save(Context ctx, String url, String anon, String token) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString("url", url)
            .putString("anon", anon)
            .putString("token", token)
            .apply();
    }

    static void saveToken(Context ctx, String token) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString("token", token)
            .apply();
    }

    static void clear(Context ctx) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
    }

    static String url(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("url", null);
    }

    static String anon(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("anon", null);
    }

    static String token(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("token", null);
    }
}
