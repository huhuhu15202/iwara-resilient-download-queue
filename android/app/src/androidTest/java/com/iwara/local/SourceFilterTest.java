package com.iwara.local;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.sqlite.SQLiteDatabase;
import android.widget.Button;
import android.widget.GridView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.util.UUID;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class SourceFilterTest {
    @Test public void legacyCatalogueInfersHan1AndKeepsLocalImportsInAll() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        context.deleteDatabase("phone-library.sqlite");
        LibraryDb db = new LibraryDb(context);
        File catalogue = createCatalogue(context, 1);
        try {
            assertEquals(3, db.importCatalogue(catalogue));
            SQLiteDatabase local = db.getReadableDatabase();
            assertEquals("han1", source(local, "han1-row"));
            assertEquals("iwara", source(local, "iwara-row"));
            assertEquals("other", source(local, "local-row"));
        } finally {
            db.close(); catalogue.delete(); context.deleteDatabase("phone-library.sqlite");
        }
    }

    @Test public void sourceButtonsFilterOnlyTheirOwnCataloguedVideos() throws Exception {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        context.deleteDatabase("phone-library.sqlite");
        LibraryDb db = new LibraryDb(context);
        Activity activity = null;
        File catalogue = null;
        try {
            SQLiteDatabase writable = db.getWritableDatabase();
            catalogue = createCatalogue(context, 2);
            assertEquals(3, db.importCatalogue(catalogue));
            addLocalFile(writable, "iwara-id", "Iwara example");
            addLocalFile(writable, "han1meview-123456", "Han1 example");
            addLocalFile(writable, "local-unmatched", "Local example");

            activity = instrumentation.startActivitySync(new Intent(context, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            Activity library = activity;
            instrumentation.waitForIdleSync();
            GridView grid = (GridView) field(library, "grid");
            Button[] sources = (Button[]) field(library, "sourceButtons");
            assertEquals("All must keep unclassified local files visible", 3, grid.getAdapter().getCount());

            instrumentation.runOnMainSync(() -> sources[2].performClick());
            assertEquals("Han1 filter should leave only Han1 rows", 1, grid.getAdapter().getCount());
            instrumentation.runOnMainSync(() -> sources[1].performClick());
            assertEquals("Iwara filter should leave only Iwara rows", 1, grid.getAdapter().getCount());
            instrumentation.runOnMainSync(() -> sources[0].performClick());
            assertEquals("All should restore Iwara, Han1, and other rows", 3, grid.getAdapter().getCount());
        } finally {
            if (activity != null) {
                Activity closing = activity;
                instrumentation.runOnMainSync(closing::finish);
            }
            context.getSharedPreferences("MainActivity", Context.MODE_PRIVATE).edit().remove("source_filter").apply();
            db.close();
            if (catalogue != null) catalogue.delete();
            context.deleteDatabase("phone-library.sqlite");
        }
    }

    private static Object field(Object target, String name) throws Exception {
        java.lang.reflect.Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field.get(target);
    }

    private static File createCatalogue(Context context, int version) {
        File file = new File(context.getCacheDir(), "source-catalogue-" + UUID.randomUUID() + ".sqlite");
        SQLiteDatabase catalogue = SQLiteDatabase.openOrCreateDatabase(file, null);
        if (version == 2) {
            catalogue.execSQL("PRAGMA user_version=2");
            catalogue.execSQL("CREATE TABLE catalogue(task_id TEXT PRIMARY KEY,video_id TEXT,title TEXT,author TEXT,upload_time INTEGER,views INTEGER,tags TEXT,size INTEGER,sha256 TEXT,sample_sha256 TEXT,download_time INTEGER,source TEXT NOT NULL DEFAULT 'other')");
        } else {
            catalogue.execSQL("PRAGMA user_version=1");
            catalogue.execSQL("CREATE TABLE catalogue(task_id TEXT PRIMARY KEY,video_id TEXT,title TEXT,author TEXT,upload_time INTEGER,views INTEGER,tags TEXT,size INTEGER,sha256 TEXT,sample_sha256 TEXT)");
        }
        catalogue.execSQL("CREATE TABLE catalogue_meta(key TEXT PRIMARY KEY,value TEXT)");
        addCatalogueRow(catalogue, "iwara-row", "iwara-id", "Iwara example", "iwara", version);
        addCatalogueRow(catalogue, "han1-row", "han1meview-123456", "Han1 example", "han1", version);
        addCatalogueRow(catalogue, "local-row", "local-unmatched", "Local example", "other", version);
        catalogue.close();
        return file;
    }

    private static void addCatalogueRow(SQLiteDatabase db, String taskId, String videoId, String title, String source, int version) {
        ContentValues catalogue = new ContentValues();
        catalogue.put("task_id", taskId); catalogue.put("video_id", videoId); catalogue.put("title", title);
        catalogue.put("author", "fixture-author"); catalogue.put("tags", "[]"); catalogue.put("size", 0);
        if (version == 2) catalogue.put("source", source);
        db.insertOrThrow("catalogue", null, catalogue);
    }

    private static void addLocalFile(SQLiteDatabase db, String videoId, String title) {
        String taskId = videoId.startsWith("han1meview-") ? "han1-row" : videoId.startsWith("local-") ? "local-row" : "iwara-row";
        ContentValues local = new ContentValues();
        local.put("uri", "content://test/" + videoId); local.put("name", title + ".mp4"); local.put("task_id", taskId);
        local.put("hidden", 0); local.put("available", 1);
        db.insertOrThrow("local_files", null, local);
    }

    private static String source(SQLiteDatabase db, String taskId) {
        try (android.database.Cursor rows = db.rawQuery("SELECT source FROM catalogue WHERE task_id=?", new String[]{taskId})) {
            assertTrue(rows.moveToFirst());
            return rows.getString(0);
        }
    }
}
