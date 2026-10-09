package com.iwara.tests;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.MediaStore;
import com.iwara.local.ConnectionSettings;
import com.iwara.local.LibraryDb;
import com.iwara.local.VideoScanner;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.atomic.AtomicBoolean;

/** This test modifies only an emulator copy, never a computer video. */
public final class LanTest extends Instrumentation {
    private Bundle arguments;
    @Override public void onCreate(Bundle args) { super.onCreate(args); arguments = args; start(); }
    private void require(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
    @Override public void onStart() {
        Bundle result = new Bundle(); Uri copyUri = null; LibraryDb db = null;
        try {
            Context context = getTargetContext(); ContentResolver resolver = context.getContentResolver();
            resolver.delete(MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
                MediaStore.Video.Media.RELATIVE_PATH + "=? AND " + MediaStore.Video.Media.DISPLAY_NAME + " IN (?,?)",
                new String[]{"Movies/IwaraIsolatedTest/", "completely-arbitrary-title.mp4", "renamed-again-with-no-id.mp4"});
            String origin = arguments.getString("origin"), token = arguments.getString("token"), task = arguments.getString("task");
            require(origin != null && token != null && task != null, "Missing isolated test parameters");
            ConnectionSettings settings = new ConnectionSettings(context);
            settings.save(origin + "/playlist?access_token=" + Uri.encode(token), "");
            require(origin.equals(settings.origin()), "Full-link origin parsing");
            require(token.equals(new ConnectionSettings(context).token()), "Keystore token round trip");
            require(!context.getSharedPreferences("connection", Context.MODE_PRIVATE).getString("token", "").contains(token), "Plaintext token persisted");
            for (String host : new String[]{"example.com", "fdexample.com"}) {
                boolean rejected = false;
                try { settings.save("http://" + host, "test"); } catch (IllegalArgumentException expected) { rejected = true; }
                require(rejected, "Public HTTP endpoint accepted");
            }
            Intent launch = new Intent(Intent.ACTION_MAIN); launch.setClassName("com.iwara.local", "com.iwara.local.MainActivity"); launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            Activity activity = startActivitySync(launch); waitForIdleSync();
            java.lang.reflect.Method sync = activity.getClass().getDeclaredMethod("sync"); sync.setAccessible(true);
            java.lang.reflect.Field busy = activity.getClass().getDeclaredField("busy"); busy.setAccessible(true);
            long syncStart = SystemClock.elapsedRealtime();
            runOnMainSync(() -> { try { sync.invoke(activity); } catch (Exception error) { throw new RuntimeException(error); } });
            long deadline = syncStart + 45000; AtomicBoolean working = new AtomicBoolean(true);
            do { Thread.sleep(100); runOnMainSync(() -> { try { working.set(busy.getBoolean(activity)); } catch (Exception error) { throw new RuntimeException(error); } }); } while (working.get() && SystemClock.elapsedRealtime() < deadline);
            require(!working.get(), "App sync timed out"); long syncMs = SystemClock.elapsedRealtime() - syncStart;
            db = new LibraryDb(context); int[] stats = db.catalogueStats();
            require(stats[0] >= 2000 && stats[1] >= 77, "HTTP app sync did not import PC metadata");
            require(db.all(false).stream().allMatch(video -> "unmatched".equals(video.status)), "Synthetic content falsely matched PC metadata");

            HttpURLConnection response = (HttpURLConnection)new URL(origin + "/media/" + Uri.encode(task) + "?profile=local").openConnection();
            response.setRequestProperty("x-iwara-access-token", token); response.setConnectTimeout(10000); response.setReadTimeout(45000); response.setInstanceFollowRedirects(false);
            require(response.getResponseCode() == 200, "Original-file LAN download failed");
            ContentValues values = new ContentValues(); values.put(MediaStore.Video.Media.DISPLAY_NAME, "completely-arbitrary-title.mp4"); values.put(MediaStore.Video.Media.MIME_TYPE, "video/mp4"); values.put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/IwaraIsolatedTest"); values.put(MediaStore.Video.Media.IS_PENDING, 1);
            copyUri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values); require(copyUri != null, "Emulator MediaStore copy failed");
            long bytes = 0, transferStart = SystemClock.elapsedRealtime();
            try (InputStream input = response.getInputStream(); OutputStream output = resolver.openOutputStream(copyUri)) {
                byte[] buffer = new byte[262144]; int n; while ((n = input.read(buffer)) != -1) { bytes += n; require(bytes <= 300L * 1024 * 1024, "Test copy exceeds limit"); output.write(buffer, 0, n); }
            } finally { response.disconnect(); }
            long transferMs = SystemClock.elapsedRealtime() - transferStart;
            require(bytes == Long.parseLong(arguments.getString("size")), "Copy size does not match source");
            values.clear(); values.put(MediaStore.Video.Media.IS_PENDING, 0); resolver.update(copyUri, values, null, null);
            VideoScanner scanner = new VideoScanner(context, db, new AtomicBoolean()); long scanStart = SystemClock.elapsedRealtime(); scanner.scan(null, (message, refresh) -> {}); long firstMs = SystemClock.elapsedRealtime() - scanStart;
            final String copied = copyUri.toString();
            require(db.all(false).stream().anyMatch(video -> copied.equals(video.uri) && task.equals(video.taskId)), "Arbitrary filename failed full-content matching");
            values.clear(); values.put(MediaStore.Video.Media.DISPLAY_NAME, "renamed-again-with-no-id.mp4"); resolver.update(copyUri, values, null, null);
            scanStart = SystemClock.elapsedRealtime(); scanner.scan(null, (message, refresh) -> {}); long renameMs = SystemClock.elapsedRealtime() - scanStart;
            require(db.all(false).stream().anyMatch(video -> copied.equals(video.uri) && task.equals(video.taskId) && "renamed-again-with-no-id.mp4".equals(video.name)), "Rename lost content identity");
            result.putString("result", "PASS: LAN app sync, encrypted token, arbitrary-name full match, renamed copy identity; catalogue=" + stats[0] + ", ready=" + stats[1] + ", syncMs=" + syncMs + ", bytes=" + bytes + ", transferMs=" + transferMs + ", firstScanMs=" + firstMs + ", renameScanMs=" + renameMs);
            // Keep the emulator copy for screenshot validation. It is not a source video.
            copyUri = null;
            finish(Activity.RESULT_OK, result);
        } catch (Throwable error) { result.putString("error", error.getClass().getSimpleName() + ": " + error.getMessage()); finish(Activity.RESULT_CANCELED, result); }
        finally { if (copyUri != null) getTargetContext().getContentResolver().delete(copyUri, null, null); if (db != null) db.close(); }
    }
}
