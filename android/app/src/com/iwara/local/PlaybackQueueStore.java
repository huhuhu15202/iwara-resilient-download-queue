package com.iwara.local;

import android.content.Context;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;

/** Private, atomic storage keeps large URI lists out of Android Intent extras. */
public final class PlaybackQueueStore {
    private static final String PREFS = "playback_session";
    private PlaybackQueueStore() {}

    public static synchronized void save(Context context, PlaybackQueue queue) throws Exception {
        File directory = new File(context.getFilesDir(), "playback-queues");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("无法保存播放队列");
        AtomicFile file = new AtomicFile(new File(directory, queue.id + ".json"));
        FileOutputStream output = file.startWrite();
        try {
            output.write(queue.toJson().toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            file.finishWrite(output);
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("active_id", queue.id).apply();
        } catch (Exception error) {
            file.failWrite(output);
            throw error;
        }
    }

    public static PlaybackQueue load(Context context, String id) throws Exception {
        if (id == null || !id.matches("[0-9a-fA-F-]{36}")) throw new IllegalArgumentException("播放队列编号无效");
        File filePath = new File(new File(context.getFilesDir(), "playback-queues"), id + ".json");
        AtomicFile file = new AtomicFile(filePath);
        try (FileInputStream input = file.openRead()) {
            byte[] buffer = new byte[65536];
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
            int length;
            while ((length = input.read(buffer)) != -1) {
                if (bytes.size() + length > 8 * 1024 * 1024) throw new IllegalArgumentException("播放列表数据过大");
                bytes.write(buffer, 0, length);
            }
            return PlaybackQueue.fromJson(new JSONObject(bytes.toString("UTF-8")));
        }
    }

    public static String activeId(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("active_id", "");
    }

    public static synchronized void clear(Context context, String id) {
        if (id == null || id.isEmpty()) return;
        File file = new File(new File(context.getFilesDir(), "playback-queues"), id + ".json");
        new AtomicFile(file).delete();
        android.content.SharedPreferences preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (id.equals(preferences.getString("active_id", "")))
            preferences.edit().remove("active_id").apply();
    }
}
