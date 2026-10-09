package com.iwara.local;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.MediaStore;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.ByteArrayOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketException;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import static org.junit.Assert.*;

/** Runs against the isolated Node sender on the host (10.0.2.2), never the production service. */
@RunWith(AndroidJUnit4.class)
public final class MobileRandomDownloadE2ETest {
    private static final String ORIGIN = "http://10.0.2.2:18879";
    private static final String TOKEN = "mobile-e2e-only-token";

    @Test public void realHttpTransfersTwelvePackagesRecoversInterruptionAndThenTransfersMultiVideoBatch() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        context.deleteDatabase("phone-library.sqlite");
        LibraryDb db = new LibraryDb(context);
        ContentResolver resolver = context.getContentResolver();
        ArrayList<Uri> inserted = new ArrayList<>();
        try {
            Set<String> completedTasks = new HashSet<>();
            for (int round = 0; round < 12; round++) {
                String source = round % 2 == 0 ? "iwara" : "han1";
                JSONObject plan = createPlan(db, source, 1);
                assertEquals(source, plan.getString("source"));
                assertEquals(1, plan.getInt("selectedCount"));
                JSONObject batch = plan.getJSONArray("batches").getJSONObject(0);
                Uri downloaded = transfer(batch, context, db);
                inserted.add(downloaded);
                assertSenderCompleted(batch);
                LibraryDb.Video row = rowForUri(db, downloaded);
                assertEquals(source, row.source);
                assertEquals("matched", row.status);
                assertTrue("UTF-8 video names must survive ZIP transfer", row.name.contains("隔离样例"));
                assertMetadataAndFingerprints(resolver, row);
                assertTrue("sender should return unique IDs while the phone excludes its completed task IDs", completedTasks.add(row.taskId));
            }
            assertEquals("at least ten independently planned and transferred HTTP batches", 12, completedTasks.size());

            String[] excludeBase = new String[24]; for (int i = 0; i < excludeBase.length; i++) excludeBase[i] = String.format(Locale.ROOT, "fixture-%s-%02d", i % 2 == 1 ? "han" : "iwara", i);
            JSONObject interruptedPlan = createPlan(db, "all", 1, excludeBase);
            JSONObject interruptedBatch = interruptedPlan.getJSONArray("batches").getJSONObject(0);
            Set<String> beforeFailure = new HashSet<>(db.downloadedTaskIds());
            HttpURLConnection interrupted = openBatch(interruptedBatch);
            long interruptedLength = interrupted.getContentLengthLong();
            MobileBatchDownloader receiver = new MobileBatchDownloader(context, db, new AtomicBoolean(false), null, true);
            try (InputStream input = new ThrowAfterBytes(interrupted.getInputStream(), 32 * 1024)) {
                receiver.receive(input, interruptedLength, (received, total, current) -> {});
                fail("network interruption should not be accepted as a completed transfer");
            } catch (IOException expected) {
                assertTrue(expected.getMessage().contains("E2E injected transport interruption"));
            } finally { interrupted.disconnect(); }
            assertEquals("failed HTTP transfer must not create a ledger row", beforeFailure, new HashSet<>(db.downloadedTaskIds()));
            assertEquals("interrupted transfer must remove pending MediaStore output", 0, pendingTransferCount(resolver));

            waitForInterrupted(interruptedBatch);
            // The same capability can be retried after the sender releases its interrupted transfer lock.
            Uri recovered = transfer(interruptedBatch, context, db);
            inserted.add(recovered);
            assertSenderCompleted(interruptedBatch);
            assertMetadataAndFingerprints(resolver, rowForUri(db, recovered));

            JSONObject multiPlan = createPlan(db, "all", 3);
            JSONArray batches = multiPlan.getJSONArray("batches");
            assertEquals(1, batches.length());
            assertEquals(3, batches.getJSONObject(0).getInt("fileCount"));
            JSONObject multiBatch = batches.getJSONObject(0);
            Uri[] three = transferMulti(multiBatch, context, db);
            assertSenderCompleted(multiBatch);
            for (Uri uri : three) { inserted.add(uri); assertMetadataAndFingerprints(resolver, rowForUri(db, uri)); }
            assertEquals("one ZIP containing three selected videos should register three rows", 16, db.downloadedTaskIds().size());
            assertEquals("no unfinished receive artifacts should remain", 0, pendingTransferCount(resolver));
        } finally {
            for (Uri uri : inserted) try { resolver.delete(uri, null, null); } catch (Exception ignored) {}
            db.close();
            context.deleteDatabase("phone-library.sqlite");
        }
    }

    private static JSONObject createPlan(LibraryDb db, String source, int count, String... alsoExclude) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(ORIGIN + "/api/mobile/random-download").openConnection();
        connection.setRequestMethod("POST"); connection.setConnectTimeout(10_000); connection.setReadTimeout(30_000);
        connection.setRequestProperty("content-type", "application/json"); connection.setRequestProperty("x-iwara-access-token", TOKEN);
        connection.setDoOutput(true);
        JSONObject body = new JSONObject(); body.put("source", source); body.put("count", count);
        JSONArray excluded = new JSONArray(); for (String id : db.downloadedTaskIds()) excluded.put(id); for (String id : alsoExclude) excluded.put(id); body.put("excludeTaskIds", excluded);
        byte[] bytes = body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
        int status = connection.getResponseCode();
        if (status != 200) throw new IOException("plan HTTP " + status + ": " + readText(connection.getErrorStream()));
        JSONObject plan;
        try (InputStream input = connection.getInputStream()) { plan = new JSONObject(readText(input)); }
        finally { connection.disconnect(); }
        return plan;
    }

    private static Uri transfer(JSONObject batch, Context context, LibraryDb db) throws Exception {
        Set<String> before = new HashSet<>(db.downloadedTaskIds());
        HttpURLConnection connection = openBatch(batch);
        try {
            long expected = connection.getContentLengthLong();
            assertEquals(batch.getLong("archiveBytes"), expected);
            MobileBatchDownloader receiver = new MobileBatchDownloader(context, db, new AtomicBoolean(false), null, true);
            try (InputStream input = connection.getInputStream()) {
                assertEquals(1, receiver.receive(input, expected, (received, total, current) -> {}));
            }
        } finally { connection.disconnect(); }
        for (LibraryDb.Video row : db.all(false)) if (!before.contains(row.taskId)) return Uri.parse(row.uri);
        throw new AssertionError("successful transfer was not added to the phone ledger");
    }

    private static Uri[] transferMulti(JSONObject batch, Context context, LibraryDb db) throws Exception {
        Set<String> before = new HashSet<>(db.downloadedTaskIds());
        HttpURLConnection connection = openBatch(batch);
        try {
            MobileBatchDownloader receiver = new MobileBatchDownloader(context, db, new AtomicBoolean(false), null, true);
            try (InputStream input = connection.getInputStream()) {
                assertEquals(3, receiver.receive(input, connection.getContentLengthLong(), (received, total, current) -> {}));
            }
        } finally { connection.disconnect(); }
        ArrayList<Uri> result = new ArrayList<>();
        for (LibraryDb.Video video : db.all(false)) if (!before.contains(video.taskId)) result.add(Uri.parse(video.uri));
        assertEquals(3, result.size()); return result.toArray(new Uri[0]);
    }

    private static HttpURLConnection openBatch(JSONObject batch) throws Exception {
        String route = batch.getString("url"); assertTrue(route.matches("/batch-download/[a-f0-9]{36}\\.zip"));
        HttpURLConnection connection = (HttpURLConnection) new URL(ORIGIN + route).openConnection();
        connection.setConnectTimeout(10_000); connection.setReadTimeout(120_000); connection.setRequestProperty("x-test-e2e", "1");
        int status = connection.getResponseCode();
        if (status != 200) { String error = readText(connection.getErrorStream()); connection.disconnect(); throw new IOException("ZIP HTTP " + status + ": " + error); }
        assertTrue("sender must serve ZIP", connection.getContentType().toLowerCase(Locale.ROOT).startsWith("application/zip"));
        return connection;
    }

    private static JSONObject batchStatus(JSONObject batch) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(ORIGIN + "/api/batch-download/status?id=" + batch.getString("downloadId")).openConnection();
        connection.setConnectTimeout(10_000); connection.setReadTimeout(10_000); connection.setRequestProperty("x-iwara-access-token", TOKEN);
        int code = connection.getResponseCode(); if (code != 200) throw new IOException("batch status HTTP " + code + ": " + readText(connection.getErrorStream()));
        try (InputStream input = connection.getInputStream()) { return new JSONObject(readText(input)); }
        finally { connection.disconnect(); }
    }

    private static void assertSenderCompleted(JSONObject batch) throws Exception {
        JSONObject status = batchStatus(batch);
        assertEquals("completed", status.getString("state"));
        assertEquals(status.getLong("archiveBytes"), status.getLong("bytesSent"));
    }

    private static void waitForInterrupted(JSONObject batch) throws Exception {
        for (int attempt = 0; attempt < 30; attempt++) {
            if ("interrupted".equals(batchStatus(batch).optString("state"))) return;
            Thread.sleep(50);
        }
        fail("sender did not mark interrupted E2E transfer as interrupted");
    }

    private static LibraryDb.Video rowForUri(LibraryDb db, Uri uri) {
        for (LibraryDb.Video row : db.all(false)) if (uri.toString().equals(row.uri)) return row;
        throw new AssertionError("downloaded file is absent from the phone ledger: " + uri);
    }

    private static void assertMetadataAndFingerprints(ContentResolver resolver, LibraryDb.Video row) throws Exception {
        assertNotNull(row.sha256); assertEquals(64, row.sha256.length());
        assertNotNull(row.sample); assertEquals(64, row.sample.length());
        assertTrue("metadata should be carried with each downloaded item", row.title.contains("sha256="));
        String expected = row.title.substring(row.title.lastIndexOf("sha256=") + 7);
        assertEquals(expected, row.sha256);
        Fingerprints.Source source = () -> { InputStream input = resolver.openInputStream(Uri.parse(row.uri)); if (input == null) throw new IOException("downloaded file unavailable"); return input; };
        assertEquals(row.sample, Fingerprints.sample(source, row.size, () -> false));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        LibraryDb metadataDb = new LibraryDb(context);
        try {
            long[] actualMetadata = new VideoScanner(context, metadataDb, new AtomicBoolean(false)).metadata(Uri.parse(row.uri));
            assertEquals(row.size, actualMetadata[0]); assertEquals(row.modified, actualMetadata[1]);
        } finally { metadataDb.close(); }
    }

    private static int pendingTransferCount(ContentResolver resolver) {
        try (Cursor rows = resolver.query(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, new String[]{MediaStore.Video.Media._ID}, MediaStore.Video.Media.DISPLAY_NAME + " LIKE ?", new String[]{".iwara-transfer-%"}, null)) {
            return rows == null ? -1 : rows.getCount();
        }
    }

    private static String readText(InputStream input) throws Exception {
        if (input == null) return "";
        try (InputStream stream = input; ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = stream.read(buffer)) != -1) { if (bytes.size() + count > 1024 * 1024) throw new IOException("test response too large"); bytes.write(buffer, 0, count); }
            return bytes.toString("UTF-8");
        }
    }

    private static final class ThrowAfterBytes extends FilterInputStream {
        private long left;
        ThrowAfterBytes(InputStream input, long limit) { super(input); left = limit; }
        @Override public int read() throws IOException { if (left <= 0) throw new SocketException("E2E injected transport interruption"); int value = super.read(); if (value >= 0) left--; return value; }
        @Override public int read(byte[] buffer, int offset, int length) throws IOException {
            if (left <= 0) throw new SocketException("E2E injected transport interruption");
            int count = super.read(buffer, offset, (int)Math.min(length, left)); if (count > 0) left -= count; return count;
        }
    }
}
