package com.agenthub.dshmulti;

import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * The computers this app can reach. One DSH process per computer, one entry per
 * DSH: `hosts` holds the ordered list as a JSON array, `server` stays the origin
 * on screen right now, and everything else (gateway cookie, notification epoch
 * and cursor) lives under `h.<origin>.<field>` so two hosts never overwrite
 * each other's stream state.
 *
 * A build from before multi-host has only `server`/`cookie`/`epoch`/`n`; the
 * first read migrates those into one entry and leaves the old keys untouched so
 * a downgrade still works.
 */
final class Hosts {
    static final String KEY = "hosts";
    static final String ACTIVE = "server";

    static final class Host {
        final String origin;
        String label;

        Host(String origin, String label) {
            this.origin = origin;
            this.label = label == null ? "" : label;
        }

        /** What the phone shows above the conversation: "工作室" or the bare address. */
        String title() {
            if (!label.isEmpty()) return label;
            return origin.replaceFirst("(?i)^https?://", "");
        }
    }

    private Hosts() {
    }

    static String field(String origin, String name) {
        return "h." + origin + "." + name;
    }

    static List<Host> read(SharedPreferences p) {
        List<Host> out = new ArrayList<>();
        String raw = p.getString(KEY, "");
        if (raw == null || raw.isEmpty()) {
            migrate(p);
            raw = p.getString(KEY, "");
        }
        if (raw == null || raw.isEmpty()) return out;
        try {
            JSONArray a = new JSONArray(raw);
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.optJSONObject(i);
                if (o == null) continue;
                String origin = o.optString("origin", "");
                if (origin.isEmpty()) continue;
                out.add(new Host(origin, o.optString("label", "")));
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    static void write(SharedPreferences p, List<Host> list) {
        JSONArray a = new JSONArray();
        for (Host h : list) {
            try {
                a.put(new JSONObject().put("origin", h.origin).put("label", h.label));
            } catch (Exception ignored) {
            }
        }
        p.edit().putString(KEY, a.toString()).apply();
    }

    /** Add or relabel one host; returns after the list and the active origin are saved. */
    static void add(SharedPreferences p, String origin, String label) {
        List<Host> list = read(p);
        Host found = find(list, origin);
        if (found == null) list.add(new Host(origin, label));
        else found.label = label == null ? "" : label;
        write(p, list);
        activate(p, origin);
    }

    static void remove(SharedPreferences p, String origin) {
        List<Host> list = read(p);
        list.removeIf(h -> h.origin.equals(origin));
        write(p, list);
        p.edit()
                .remove(field(origin, "cookie"))
                .remove(field(origin, "epoch"))
                .remove(field(origin, "n"))
                .apply();
        if (origin.equals(p.getString(ACTIVE, ""))) {
            if (list.isEmpty()) p.edit().remove(ACTIVE).apply();
            else p.edit().putString(ACTIVE, list.get(0).origin).apply();
        }
    }

    static Host find(List<Host> list, String origin) {
        for (Host h : list) if (h.origin.equals(origin)) return h;
        return null;
    }

    /**
     * The origin on screen. Falls back to the first saved host so a build that
     * predates the list keeps working, and honours a build-time default last.
     */
    static String active(SharedPreferences p, String fallback) {
        String saved = p.getString(ACTIVE, "");
        if (saved != null && !saved.isEmpty()) return saved;
        List<Host> list = read(p);
        if (!list.isEmpty()) return list.get(0).origin;
        return fallback == null ? "" : fallback;
    }

    static void activate(SharedPreferences p, String origin) {
        p.edit().putString(ACTIVE, origin).apply();
    }

    /** The gateway cookie the WebView currently holds for this host. */
    static String cookie(SharedPreferences p, String origin) {
        return p.getString(field(origin, "cookie"), "");
    }

    private static void migrate(SharedPreferences p) {
        String legacy = p.getString(ACTIVE, "");
        if (legacy == null || legacy.isEmpty()) return;
        write(p, List.of(new Host(legacy, "")));
        SharedPreferences.Editor e = p.edit();
        String cookie = p.getString("cookie", "");
        if (cookie != null && !cookie.isEmpty()) e.putString(field(legacy, "cookie"), cookie);
        String epoch = p.getString("epoch", "");
        if (epoch != null && !epoch.isEmpty()) e.putString(field(legacy, "epoch"), epoch);
        long n = p.getLong("n", -1);
        if (n >= 0) e.putLong(field(legacy, "n"), n);
        e.apply();
    }
}
