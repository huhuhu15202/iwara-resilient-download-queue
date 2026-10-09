package com.iwara.local;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import java.io.InputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

public final class VideoScanner {
    public interface Progress { void changed(String message, boolean refresh); }
    private final ContentResolver resolver;
    private final LibraryDb db;
    private final AtomicBoolean cancelled;
    private final Context context;
    public VideoScanner(Context context, LibraryDb db, AtomicBoolean cancelled) { this.context = context.getApplicationContext(); this.resolver = context.getContentResolver(); this.db = db; this.cancelled = cancelled; }
    private void check() throws InterruptedException { if (cancelled.get() || Thread.currentThread().isInterrupted()) throw new InterruptedException("扫描已暂停"); }
    public void scan(Uri directory, Progress progress) throws Exception {
        long session = System.currentTimeMillis();
        if (directory == null) scanMediaStore(session); else scanTree(directory, session);
        check(); db.finishDiscovery(session); progress.changed("已扫描文件，正在匹配资料…", true);
        match(progress);
    }
    private void scanMediaStore(long session) throws Exception {
        Uri collection = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
        String[] columns = {MediaStore.Video.Media._ID, MediaStore.Video.Media.DISPLAY_NAME, MediaStore.Video.Media.SIZE, MediaStore.Video.Media.DATE_MODIFIED};
        try (Cursor rows = resolver.query(collection, columns, null, null, null)) {
            if (rows == null) throw new IllegalStateException("无法读取媒体库");
            while (rows.moveToNext()) { check(); db.discovered(ContentUris.withAppendedId(collection, rows.getLong(0)).toString(), rows.getString(1), rows.getLong(2), rows.getLong(3) * 1000, session); }
        }
    }
    private void scanTree(Uri tree, long session) throws Exception {
        ArrayDeque<String> pending = new ArrayDeque<>(); pending.push(DocumentsContract.getTreeDocumentId(tree));
        String[] columns = {DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED};
        while (!pending.isEmpty()) {
            check(); Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, pending.pop());
            try (Cursor rows = resolver.query(children, columns, null, null, null)) {
                if (rows == null) throw new IllegalStateException("目录读取失败");
                while (rows.moveToNext()) {
                    check(); String id = rows.getString(0), name = rows.getString(1), mime = rows.getString(2);
                    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) pending.push(id);
                    else if ((mime != null && mime.startsWith("video/")) || (name != null && name.toLowerCase(java.util.Locale.ROOT).matches(".*\\.(mp4|mkv|webm|mov|avi|m4v)$")))
                        db.discovered(DocumentsContract.buildDocumentUriUsingTree(tree, id).toString(), name, rows.isNull(3) ? -1 : rows.getLong(3), rows.getLong(4), session);
                }
            }
        }
    }
    public long[] metadata(Uri uri) throws Exception {
        if (DocumentsContract.isDocumentUri(context, uri)) { // SAF and MediaStore expose different column names.
            try (Cursor rows = resolver.query(uri, new String[]{DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED}, null, null, null)) { if (rows != null && rows.moveToFirst()) return new long[]{rows.isNull(0) ? -1 : rows.getLong(0), rows.getLong(1)}; }
        } else {
            try (Cursor rows = resolver.query(uri, new String[]{MediaStore.Video.Media.SIZE, MediaStore.Video.Media.DATE_MODIFIED}, null, null, null)) { if (rows != null && rows.moveToFirst()) return new long[]{rows.getLong(0), rows.getLong(1) * 1000}; }
        }
        throw new IllegalStateException("文件已移动或权限被撤销");
    }
    public void match(Progress progress) throws Exception {
        List<LibraryDb.Video> files = new ArrayList<>(db.all(false)); files.addAll(db.all(true));
        int complete = 0, matched = 0, conflicts = 0, failed = 0;
        for (LibraryDb.Video file : files) {
            check(); Uri uri = Uri.parse(file.uri);
            try {
                long[] before = metadata(uri);
                if (before[0] < 0) { db.match(file.uri, null, "unknown_size"); continue; }
                Fingerprints.Source source = () -> { InputStream stream = resolver.openInputStream(uri); if (stream == null) throw new IllegalStateException("视频读取失败"); return stream; };
                String sample = file.sample;
                if (sample == null || file.size != before[0] || file.modified != before[1]) sample = Fingerprints.sample(source, before[0], cancelled::get);
                String full = file.sha256;
                if (file.size != before[0] || file.modified != before[1]) full = null;
                // A sample is only a cheap candidate filter; it never confirms identity.
                if (full == null && db.hasCandidate(before[0], sample)) {
                    progress.changed("正在核验 " + (complete + 1) + "/" + files.size() + "：" + file.name, false);
                    full = Fingerprints.full(source, cancelled::get);
                }
                long[] after = metadata(uri);
                if (before[0] != after[0] || before[1] != after[1]) { db.discovered(file.uri, file.name, after[0], after[1], System.currentTimeMillis()); db.match(file.uri, null, "changed"); continue; }
                db.fingerprint(file.uri, sample, full); db.match(file.uri, full, "unmatched");
            } catch (InterruptedException e) { throw e; }
            catch (Exception error) { failed++; db.match(file.uri, null, "unreadable"); }
            progress.changed("匹配资料 " + (++complete) + "/" + files.size(), complete % 5 == 0);
        }
        for (LibraryDb.Video video : db.all(false)) { if ("matched".equals(video.status)) matched++; if ("conflict".equals(video.status)) conflicts++; }
        int[] stats = db.catalogueStats();
        progress.changed("扫描完成 · 已关联 " + matched + " · 冲突 " + conflicts + " · 读取失败 " + failed + " · 电脑指纹 " + stats[1] + "/" + stats[0] + "（待匹配项可稍后再同步）", true);
    }
}
