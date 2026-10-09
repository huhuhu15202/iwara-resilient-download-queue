package com.iwara.local;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONArray;
import java.io.File;
import java.util.ArrayList;
import java.util.List;

public final class LibraryDb extends SQLiteOpenHelper {
    public LibraryDb(Context context) { super(context, "phone-library.sqlite", null, 4); }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE catalogue(task_id TEXT PRIMARY KEY,video_id TEXT,title TEXT,author TEXT,upload_time INTEGER,views INTEGER,tags TEXT,size INTEGER,sha256 TEXT,sample_sha256 TEXT,download_time INTEGER,source TEXT NOT NULL DEFAULT 'other')");
        db.execSQL("CREATE INDEX catalogue_hash ON catalogue(sha256)");
        db.execSQL("CREATE INDEX catalogue_sample ON catalogue(size,sample_sha256)");
        db.execSQL("CREATE TABLE local_files(uri TEXT PRIMARY KEY,name TEXT,size INTEGER,modified INTEGER,sha256 TEXT,sample_sha256 TEXT,task_id TEXT,match_status TEXT NOT NULL DEFAULT 'pending',hidden INTEGER NOT NULL DEFAULT 0,available INTEGER NOT NULL DEFAULT 1,seen INTEGER,scan_root TEXT)");
        db.execSQL("CREATE TABLE catalogue_meta(key TEXT PRIMARY KEY,value TEXT)");
        db.execSQL("CREATE TABLE scan_roots(uri TEXT PRIMARY KEY,label TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL)");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion < 2) db.execSQL("ALTER TABLE catalogue ADD COLUMN download_time INTEGER");
        if (oldVersion < 3) {
            db.execSQL("ALTER TABLE catalogue ADD COLUMN source TEXT NOT NULL DEFAULT 'other'");
            db.execSQL("UPDATE catalogue SET source='han1' WHERE lower(COALESCE(video_id,'')) LIKE 'han1meview-%'");
            db.execSQL("UPDATE catalogue SET source='iwara' WHERE COALESCE(video_id,'')<>'' AND lower(video_id) NOT LIKE 'han1meview-%' AND lower(video_id) NOT LIKE 'local-%'");
        }
        if (oldVersion < 4) {
            db.execSQL("ALTER TABLE local_files ADD COLUMN scan_root TEXT");
            db.execSQL("CREATE TABLE scan_roots(uri TEXT PRIMARY KEY,label TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL)");
        }
        if (newVersion > 4) throw new IllegalStateException("不支持的数据库版本");
    }
    public static final class ScanRoot {
        public final String uri, label;
        public ScanRoot(String uri, String label) { this.uri=uri; this.label=label; }
    }
    public synchronized List<ScanRoot> scanRoots() {
        List<ScanRoot> result = new ArrayList<>();
        try (Cursor rows = getReadableDatabase().rawQuery("SELECT uri,label FROM scan_roots WHERE enabled=1 ORDER BY updated_at,uri", null)) {
            while (rows.moveToNext()) result.add(new ScanRoot(rows.getString(0), rows.getString(1)));
        }
        return result;
    }
    public synchronized void addScanRoot(String uri, String label) {
        if (uri == null || uri.isEmpty()) throw new IllegalArgumentException("扫描目录 URI 为空");
        ContentValues value = new ContentValues(); value.put("uri", uri); value.put("label", label == null || label.isEmpty() ? "已授权目录" : label);
        value.put("enabled", 1); value.put("updated_at", System.currentTimeMillis());
        getWritableDatabase().insertWithOnConflict("scan_roots", null, value, SQLiteDatabase.CONFLICT_REPLACE);
    }
    public synchronized void removeScanRoot(String uri) { getWritableDatabase().delete("scan_roots", "uri=?", new String[]{uri}); }
    public synchronized int importCatalogue(File file) throws Exception {
        SQLiteDatabase incoming = SQLiteDatabase.openDatabase(file.getPath(), null, SQLiteDatabase.OPEN_READONLY);
        SQLiteDatabase db = getWritableDatabase();
        try {
            if (incoming.getVersion() != 1 && incoming.getVersion() != 2) throw new IllegalArgumentException("资料库版本不支持");
            try (Cursor check = incoming.rawQuery("PRAGMA integrity_check", null)) { if (!check.moveToFirst() || !"ok".equals(check.getString(0))) throw new IllegalArgumentException("资料库损坏"); }
            String[] columns = {"task_id","video_id","title","author","upload_time","views","tags","size","sha256","sample_sha256"};
            boolean hasDownloadTime=false,hasSource=false;try(Cursor schema=incoming.rawQuery("PRAGMA table_info(catalogue)",null)){while(schema.moveToNext()){if("download_time".equals(schema.getString(1)))hasDownloadTime=true;if("source".equals(schema.getString(1)))hasSource=true;}}
            java.util.ArrayList<String> projected=new java.util.ArrayList<>(java.util.Arrays.asList(columns));
            int downloadTimeIndex=-1,sourceIndex=-1;
            if(hasDownloadTime){downloadTimeIndex=projected.size();projected.add("download_time");}
            if(hasSource){sourceIndex=projected.size();projected.add("source");}
            String[] readColumns=projected.toArray(new String[0]);
            db.beginTransaction(); int count = 0;
            try {
                db.delete("catalogue", null, null); db.delete("catalogue_meta", null, null);
                try (Cursor rows = incoming.query("catalogue", readColumns, null, null, null, null, null)) {
                    while (rows.moveToNext()) {
                        if (++count > 50000) throw new IllegalArgumentException("资料库记录过多");
                        ContentValues values = new ContentValues();
                        for (int i = 0; i < columns.length; i++) {
                            if (rows.isNull(i)) values.putNull(columns[i]);
                            else if (i == 4 || i == 5 || i == 7) values.put(columns[i], rows.getLong(i));
                            else values.put(columns[i], rows.getString(i));
                        }
                        for (String column : new String[]{"sha256", "sample_sha256"}) { String value = values.getAsString(column); if (value != null && !value.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("资料指纹无效"); }
                        new JSONArray(values.getAsString("tags"));
                        if(downloadTimeIndex>=0&&!rows.isNull(downloadTimeIndex))values.put("download_time",rows.getLong(downloadTimeIndex));else values.putNull("download_time");
                        String videoId=values.getAsString("video_id");
                        String source=sourceIndex>=0?rows.getString(sourceIndex):null;
                        if(!"iwara".equals(source)&&!"han1".equals(source)&&!"other".equals(source))source=null;
                        if(source==null)source=videoId!=null&&videoId.toLowerCase(java.util.Locale.ROOT).startsWith("han1meview-")?"han1":videoId!=null&&videoId.toLowerCase(java.util.Locale.ROOT).startsWith("local-")?"other":"iwara";
                        values.put("source",source);
                        db.insertOrThrow("catalogue", null, values);
                    }
                }
                try (Cursor rows = incoming.rawQuery("SELECT key,value FROM catalogue_meta", null)) { while (rows.moveToNext()) { ContentValues value = new ContentValues(); value.put("key", rows.getString(0)); value.put("value", rows.getString(1)); db.insertOrThrow("catalogue_meta", null, value); } }
                db.setTransactionSuccessful(); return count;
            } finally { db.endTransaction(); }
        } finally { incoming.close(); }
    }
    public synchronized void discovered(String uri, String name, long size, long modified, long scan) { discovered(uri,name,size,modified,scan,null); }
    public synchronized void discovered(String uri, String name, long size, long modified, long scan, String scanRoot) {
        SQLiteDatabase db = getWritableDatabase(); ContentValues value = new ContentValues();
        value.put("name", name); value.put("size", size); value.put("modified", modified); value.put("seen", scan); value.put("available", 1); value.put("scan_root",scanRoot);
        try (Cursor old = db.rawQuery("SELECT size,modified FROM local_files WHERE uri=?", new String[]{uri})) {
            if (old.moveToFirst()) {
                if (old.getLong(0) != size || old.getLong(1) != modified) { value.putNull("sha256"); value.putNull("sample_sha256"); value.putNull("task_id"); value.put("match_status", "pending"); }
                db.update("local_files", value, "uri=?", new String[]{uri});
            } else { value.put("uri", uri); db.insertOrThrow("local_files", null, value); }
        }
    }
    public synchronized void finishDiscovery(long scan, List<String> roots, boolean mediaStore) {
        ArrayList<String> active = new ArrayList<>();
        if (roots != null) active.addAll(roots);
        if (mediaStore) active.add("media");
        if (active.isEmpty()) return;
        StringBuilder selection = new StringBuilder("seen<>? AND scan_root IN (");
        String[] args = new String[active.size()+1]; args[0]=String.valueOf(scan);
        for (int i=0;i<active.size();i++) { if(i>0)selection.append(','); selection.append('?'); args[i+1]=active.get(i); }
        selection.append(')'); ContentValues value = new ContentValues(); value.put("available",0);
        getWritableDatabase().update("local_files",value,selection.toString(),args);
    }
    public synchronized void fingerprint(String uri, String sample, String full) {
        ContentValues value = new ContentValues(); value.put("sample_sha256", sample); if (full != null) value.put("sha256", full);
        getWritableDatabase().update("local_files", value, "uri=?", new String[]{uri});
    }
    public synchronized void match(String uri, String full, String status) {
        List<String> matches = new ArrayList<>();
        if (full != null) try (Cursor rows = getReadableDatabase().rawQuery("SELECT task_id FROM catalogue WHERE sha256=?", new String[]{full})) { while (rows.moveToNext()) matches.add(rows.getString(0)); }
        ContentValues value = new ContentValues();
        if (matches.size() == 1) { value.put("task_id", matches.get(0)); value.put("match_status", "matched"); }
        else { value.putNull("task_id"); value.put("match_status", matches.size() > 1 ? "conflict" : status); }
        getWritableDatabase().update("local_files", value, "uri=?", new String[]{uri});
    }
    public synchronized boolean hasCandidate(long size, String sample) { try (Cursor rows = getReadableDatabase().rawQuery("SELECT 1 FROM catalogue WHERE size=? AND sample_sha256=? LIMIT 1", new String[]{String.valueOf(size), sample})) { return rows.moveToFirst(); } }
    public synchronized List<String> downloadedTaskIds() {
        List<String> result = new ArrayList<>();
        try (Cursor rows = getReadableDatabase().rawQuery("SELECT DISTINCT task_id FROM local_files WHERE available=1 AND task_id IS NOT NULL AND task_id<>''", null)) {
            while (rows.moveToNext()) result.add(rows.getString(0));
        }
        return result;
    }
    public synchronized void registerDownloadedBatch(List<DownloadedMedia> videos) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            for (DownloadedMedia video : videos) {
                ContentValues catalogue = new ContentValues();
                catalogue.put("task_id", video.taskId); catalogue.put("video_id", video.videoId);
                catalogue.put("title", video.title); catalogue.put("author", video.author);
                if (video.uploadTime >= 0) catalogue.put("upload_time", video.uploadTime); else catalogue.putNull("upload_time");
                if (video.views >= 0) catalogue.put("views", video.views); else catalogue.putNull("views");
                catalogue.put("tags", video.tags); catalogue.put("size", video.size);
                catalogue.put("sha256", video.sha256); catalogue.put("sample_sha256", video.sampleSha256);
                if (video.downloadTime >= 0) catalogue.put("download_time", video.downloadTime); else catalogue.putNull("download_time");
                catalogue.put("source", video.source);
                db.insertWithOnConflict("catalogue", null, catalogue, SQLiteDatabase.CONFLICT_REPLACE);

                ContentValues local = new ContentValues();
                local.put("uri", video.uri); local.put("name", video.name); local.put("size", video.size);
                local.put("modified", video.modified); local.put("sha256", video.sha256); local.put("sample_sha256", video.sampleSha256);
                local.put("task_id", video.taskId); local.put("match_status", "matched");
                local.put("hidden", 0); local.put("available", 1); local.put("seen", System.currentTimeMillis());
                db.insertWithOnConflict("local_files", null, local, SQLiteDatabase.CONFLICT_REPLACE);
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    public synchronized List<Video> all(boolean hidden) {
        List<Video> result = new ArrayList<>();
        String sql = "SELECT l.uri,l.name,l.size,l.modified,l.sha256,l.sample_sha256,l.task_id,l.match_status,c.title,c.author,c.upload_time,c.views,c.tags,c.download_time,c.source FROM local_files l LEFT JOIN catalogue c ON c.task_id=l.task_id WHERE l.hidden=? AND l.available=1 ORDER BY l.modified DESC,l.uri";
        try (Cursor rows = getReadableDatabase().rawQuery(sql, new String[]{hidden ? "1" : "0"})) {
            while (rows.moveToNext()) {
                Video video = new Video(); video.uri = rows.getString(0); video.name = rows.getString(1); video.size = rows.getLong(2); video.modified = rows.getLong(3); video.sha256 = rows.getString(4); video.sample = rows.getString(5); video.taskId = rows.getString(6); video.status = rows.getString(7); video.title = rows.getString(8); video.author = rows.getString(9); video.uploadTime = rows.getLong(10); video.views = rows.isNull(11) ? -1 : rows.getLong(11); video.tags = rows.getString(12);video.downloadTime=rows.isNull(13)?0:rows.getLong(13);video.source=rows.getString(14); result.add(video);
            }
        } return result;
    }
    public synchronized void hidden(String uri, boolean hidden) { ContentValues value = new ContentValues(); value.put("hidden", hidden ? 1 : 0); getWritableDatabase().update("local_files", value, "uri=?", new String[]{uri}); }
    public synchronized void removed(String uri){ContentValues value=new ContentValues();value.put("available",0);getWritableDatabase().update("local_files",value,"uri=?",new String[]{uri});}
    public synchronized int[] catalogueStats() { try (Cursor rows = getReadableDatabase().rawQuery("SELECT COUNT(*),COUNT(sha256) FROM catalogue", null)) { rows.moveToFirst(); return new int[]{rows.getInt(0), rows.getInt(1)}; } }
    public static final class Video {
        public String uri, name, sha256, sample, taskId, status, title, author, tags, source;
        public long size, modified, uploadTime, views, downloadTime;
        public String displayTitle() { return title == null || title.isEmpty() ? name : title; }
    }
    public static final class DownloadedMedia {
        public String taskId, videoId, title, author, tags, source, uri, name, sha256, sampleSha256;
        public long size, modified, uploadTime=-1, views=-1, downloadTime=-1;
    }
}
