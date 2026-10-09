package com.iwara.tests;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.Bundle;
import org.json.JSONArray;
import org.json.JSONObject;

/** Isolated receiver reports; test APK only, never shipped in the personal APK. */
public final class QueueProbeProvider extends ContentProvider {
    public static final Uri URI = Uri.parse("content://com.iwara.tests.queue-probe");
    private static String mode = "user";
    private static final JSONArray records = new JSONArray();
    public static synchronized String mode() { return mode; }
    public static synchronized void record(JSONObject value) { records.put(value); }
    @Override public boolean onCreate() { return true; }
    @Override public Bundle call(String method,String arg,Bundle extras){if("finish".equals(method))MockPlayer.finishHeld();return new Bundle();}
    @Override public synchronized Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
        synchronized (QueueProbeProvider.class) { MatrixCursor cursor = new MatrixCursor(new String[]{"records"}); cursor.addRow(new Object[]{records.toString()}); return cursor; }
    }
    @Override public synchronized int update(Uri uri, ContentValues values, String selection, String[] args) {
        synchronized (QueueProbeProvider.class) { mode = values.getAsString("mode"); while (records.length() > 0) records.remove(records.length() - 1); } return 1;
    }
    @Override public String getType(Uri uri) { return "application/json"; }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
