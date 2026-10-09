package com.iwara.local;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.CRC32;

/**
 * Receives the server's uncompressed ZIP64 stream without buffering the archive.
 * A small parser is used instead of ZipInputStream: STORE entries have no end
 * marker, so Java's stream reader cannot safely discover their boundary from a
 * trailing data descriptor when the local ZIP64 size is unknown.
 */
public final class MobileBatchDownloader {
    public interface Progress { void changed(long received, long total, String current); }
    private static final long MAX_BATCH_BYTES = 4_500_000_000L;
    private static final int MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
    private static final int LOCAL_FILE = 0x04034b50;
    private static final int CENTRAL_FILE = 0x02014b50;
    private static final int DATA_DESCRIPTOR = 0x08074b50;
    private static final int ZIP64_END = 0x06064b50;
    private static final int ZIP64_LOCATOR = 0x07064b50;
    private static final int END = 0x06054b50;
    private final Context context;
    private final ContentResolver resolver;
    private final LibraryDb db;
    private final AtomicBoolean cancelled;
    private final Uri selectedTree;
    private final boolean mediaStoreMode;

    public MobileBatchDownloader(Context context, LibraryDb db, AtomicBoolean cancelled, Uri selectedTree, boolean mediaStoreMode) {
        this.context = context.getApplicationContext(); this.resolver = context.getContentResolver(); this.db = db;
        this.cancelled = cancelled; this.selectedTree = selectedTree; this.mediaStoreMode = mediaStoreMode;
    }

    public int receive(InputStream response, long expectedArchiveBytes, Progress progress) throws Exception {
        if (expectedArchiveBytes <= 0 || expectedArchiveBytes > MAX_BATCH_BYTES + 16L * 1024 * 1024)
            throw new IOException("分包大小异常，已停止解包");
        if (selectedTree != null) {
            StorageAccess.Directory access = StorageAccess.directory(context, selectedTree);
            if (!access.read || !access.write) throw new IOException("视频目录没有持久读写权限，请重新选择视频目录");
        } else if (!mediaStoreMode || Build.VERSION.SDK_INT < 29) {
            throw new IOException("请先在资料管理中选择一个可写的视频文件夹");
        }

        StoredZipReader zip = new StoredZipReader(response, expectedArchiveBytes);
        ArrayList<PendingOutput> outputs = new ArrayList<>();
        ArrayList<ArchiveEntry> entries = new ArrayList<>();
        ArrayList<LibraryDb.DownloadedMedia> committed = new ArrayList<>();
        try {
            checkCancelled();
            ArchiveEntry manifestEntry = zip.readLocalHeader();
            if (manifestEntry == null || !"manifest.json".equals(manifestEntry.name) || manifestEntry.directory)
                throw new IOException("随机下载包缺少清单");
            if (manifestEntry.size <= 0 || manifestEntry.size > MAX_MANIFEST_BYTES)
                throw new IOException("随机下载清单过大");
            byte[] manifestBytes = zip.readEntryBytes(manifestEntry, MAX_MANIFEST_BYTES);
            zip.verifyDescriptor(manifestEntry, manifestEntry.computedCrc);
            entries.add(manifestEntry);

            JSONObject manifest;
            try { manifest = new JSONObject(new String(manifestBytes, java.nio.charset.StandardCharsets.UTF_8)); }
            catch (Exception error) { throw new IOException("随机下载清单无效", error); }
            int manifestVersion = manifest.optInt("version");
            String transferId = manifest.optString("transferId", "");
            if (!"iwara-mobile-random-batch".equals(manifest.optString("type")) || (manifestVersion != 1 && manifestVersion != 2)
                    || manifestVersion == 2 && !transferId.matches("[a-f0-9-]{36}"))
                throw new IOException("随机下载包版本不支持");
            JSONArray videos = manifest.optJSONArray("videos");
            if (videos == null || videos.length() < 1 || videos.length() > 100) throw new IOException("随机下载包的视频数量无效");
            JSONArray manifestFiles = manifestVersion == 2 ? manifest.optJSONArray("files") : null;
            if (manifestVersion == 2 && (manifestFiles == null || manifestFiles.length() != videos.length())) throw new IOException("v2 随机下载包缺少逐文件校验清单");
            Map<String, JSONObject> filesByEntry = new HashMap<>();
            if (manifestFiles != null) {
                for (int i = 0; i < manifestFiles.length(); i++) {
                    JSONObject file = manifestFiles.getJSONObject(i);
                    String entryName = file.optString("path", "");
                    if (!"media".equals(file.optString("role")) || !entryName.startsWith("media/")
                            || entryName.contains("..") || entryName.contains("\\")
                            || !file.optString("sourceId", "").matches("[A-Za-z0-9._:-]{1,256}")
                            || !file.optString("sha256", "").matches("[a-f0-9]{64}")
                            || file.optLong("size", -1) <= 0 || filesByEntry.put(entryName, file) != null)
                        throw new IOException("v2 随机下载清单的媒体身份无效");
                }
            }
            Map<String, JSONObject> byEntry = new HashMap<>();
            Set<String> taskIds = new HashSet<>();
            for (int i = 0; i < videos.length(); i++) {
                JSONObject video = videos.getJSONObject(i);
                String taskId = video.optString("taskId", "");
                String entryName = video.optString("entryName", "");
                String source = video.optString("source", "");
                long size = video.optLong("size", -1);
                if (!taskId.matches("[A-Za-z0-9._:-]{1,160}") || !taskIds.add(taskId)
                        || !entryName.startsWith("media/") || entryName.contains("..") || entryName.contains("\\")
                        || size <= 0 || size > MAX_BATCH_BYTES || !("iwara".equals(source) || "han1".equals(source) || "other".equals(source)))
                    throw new IOException("随机下载清单包含无效项目");
                String name = video.optString("name", "");
                if (name.isEmpty() || name.length() > 512 || name.contains("/") || name.contains("\\") || name.equals(".") || name.equals(".."))
                    throw new IOException("随机下载清单包含无效文件名");
                JSONArray tags = video.optJSONArray("tags");
                if (tags == null || tags.length() > 300) throw new IOException("随机下载标签数据无效");
                for (int tagIndex = 0; tagIndex < tags.length(); tagIndex++) {
                    if (!(tags.get(tagIndex) instanceof String) || tags.getString(tagIndex).length() > 160)
                        throw new IOException("随机下载标签数据无效");
                }
                if (manifestVersion == 2) {
                    JSONObject file = filesByEntry.get(entryName);
                    if (file == null || file.optLong("size", -1) != size || !file.optString("sha256").equals(video.optString("sha256"))
                            || !file.optString("source").equals(source) || !file.optString("sourceId").equals(video.optString("sourceId"))
                            || !file.optString("taskId").equals(taskId)) throw new IOException("视频资料与逐文件校验清单不一致");
                }
                if (byEntry.put(entryName, video) != null) throw new IOException("随机下载清单中有重复文件");
            }

            byte[] buffer = new byte[128 * 1024];
            long lastProgress = 0;
            for (int i = 0; i < videos.length(); i++) {
                checkCancelled();
                JSONObject video = videos.getJSONObject(i);
                String entryName = video.getString("entryName");
                long expectedSize = video.getLong("size");
                ArchiveEntry entry = zip.readLocalHeader();
                if (entry == null || entry.directory || !entryName.equals(entry.name))
                    throw new IOException("ZIP 中的视频项目与清单顺序不一致");
                if (entry.size != expectedSize || entry.compressedSize != expectedSize)
                    throw new IOException("ZIP 文件长度与清单不一致：" + video.optString("name"));
                PendingOutput output = createTemporary(video);
                outputs.add(output);
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                CRC32 crc = new CRC32();
                try (OutputStream stream = resolver.openOutputStream(output.uri, "w")) {
                    if (stream == null) throw new IOException("无法写入手机视频目录");
                    long remaining = entry.size;
                    while (remaining > 0) {
                        checkCancelled();
                        int requested = (int)Math.min(buffer.length, remaining);
                        int length = zip.readData(buffer, requested);
                        if (length < 0) throw new IOException("分包传输中断：" + video.optString("name"));
                        if (length == 0) continue;
                        stream.write(buffer, 0, length);
                        digest.update(buffer, 0, length);
                        crc.update(buffer, 0, length);
                        remaining -= length;
                        if (progress != null && zip.position() - lastProgress >= 32L * 1024 * 1024) {
                            lastProgress = zip.position();
                            progress.changed(zip.position(), expectedArchiveBytes, video.optString("title", video.optString("name")));
                        }
                    }
                }
                entry.computedCrc = crc.getValue();
                zip.verifyDescriptor(entry, entry.computedCrc);
                entry.crc = entry.computedCrc;
                output.sha256 = hex(digest.digest()); output.size = entry.size; output.video = video;
                if (manifestVersion == 2 && !output.sha256.equals(video.optString("sha256")))
                    throw new IOException("视频 SHA-256 与电脑清单不一致，已拒绝写入台账：" + video.optString("name"));
                entries.add(entry);
            }
            if (entries.size() != videos.length() + 1) throw new IOException("随机下载包中的视频数量不完整");
            zip.verifyDirectory(entries);
            if (zip.position() != expectedArchiveBytes)
                throw new IOException("分包传输不完整：收到 " + zip.position() + " / " + expectedArchiveBytes + " 字节");

            // Verify every published URI and fingerprint before atomically committing any ledger rows.
            for (PendingOutput output : outputs) {
                checkCancelled();
                output.commit();
                LibraryDb.DownloadedMedia item = new LibraryDb.DownloadedMedia();
                JSONObject video = output.video;
                item.taskId = video.getString("taskId"); item.videoId = video.optString("videoId", "");
                item.title = video.optString("title", ""); item.author = video.optString("author", "");
                item.source = video.getString("source"); item.tags = video.getJSONArray("tags").toString();
                item.uploadTime = video.optLong("uploadTime", -1); item.views = video.optLong("views", -1);
                item.downloadTime = video.optLong("downloadTime", -1); item.sha256 = output.sha256;
                item.uri = output.uri.toString(); item.name = output.finalName; item.size = output.size;
                Fingerprints.Source source = () -> {
                    InputStream stream = resolver.openInputStream(output.uri);
                    if (stream == null) throw new IOException("无法回读已保存的视频");
                    return stream;
                };
                item.sampleSha256 = Fingerprints.sample(source, output.size, cancelled::get);
                long[] metadata = new VideoScanner(context, db, cancelled).metadata(output.uri);
                if (metadata[0] != output.size) throw new IOException("手机目录中的文件大小核验失败：" + output.finalName);
                item.modified = metadata[1]; committed.add(item);
            }
            db.registerDownloadedBatch(committed);
            if (progress != null) progress.changed(expectedArchiveBytes, expectedArchiveBytes, "已校验并登记");
            return committed.size();
        } catch (Exception error) {
            for (PendingOutput output : outputs) output.deleteQuietly();
            throw error;
        }
    }

    private PendingOutput createTemporary(JSONObject video) throws Exception {
        String id = safeSegment(video.getString("taskId"));
        String tempName = ".iwara-transfer-" + id.substring(0, Math.min(id.length(), 36)) + "-" + UUID.randomUUID() + ".part";
        Uri uri;
        boolean mediaStore = selectedTree == null;
        if (mediaStore) {
            ContentValues values = new ContentValues(); values.put(MediaStore.Video.Media.DISPLAY_NAME, tempName);
            values.put(MediaStore.Video.Media.MIME_TYPE, mime(video.optString("name", "video.mp4")));
            values.put(MediaStore.Video.Media.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/IwaraLocal");
            values.put(MediaStore.Video.Media.IS_PENDING, 1);
            uri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values);
        } else {
            String treeId = DocumentsContract.getTreeDocumentId(selectedTree);
            Uri parent = DocumentsContract.buildDocumentUriUsingTree(selectedTree, treeId);
            uri = DocumentsContract.createDocument(resolver, parent, mime(video.optString("name", "video.mp4")), tempName);
        }
        if (uri == null) throw new IOException("无法在手机视频目录创建临时文件");
        PendingOutput output = new PendingOutput(uri, mediaStore);
        output.finalName = finalName(video);
        return output;
    }

    private String finalName(JSONObject video) {
        String original = video.optString("name", "video.mp4").replaceAll("[\\\\/:*?\"<>|\\u0000-\\u001f]", "_").replaceAll("^\\.+", "");
        if (original.isEmpty()) original = "video.mp4";
        String id = safeSegment(video.optString("videoId", ""));
        if (id.isEmpty()) id = safeSegment(video.optString("taskId", "video"));
        if (id.length() > 32) id = id.substring(0, 32);
        String prefix = "han1".equals(video.optString("source")) ? "Han1" : "iwara".equals(video.optString("source")) ? "Iwara" : "Video";
        int maxOriginal = Math.max(16, 180 - prefix.length() - id.length() - 2);
        if (original.length() > maxOriginal) {
            int dot = original.lastIndexOf('.'); String extension = dot > 0 ? original.substring(dot) : "";
            int keep = Math.max(1, maxOriginal - extension.length()); original = original.substring(0, Math.min(keep, dot > 0 ? dot : original.length())) + extension;
        }
        return prefix + "_" + id + "_" + original;
    }

    private static String safeSegment(String value) { return value == null ? "" : value.replaceAll("[^A-Za-z0-9._-]", "_"); }
    private static String mime(String name) {
        String value = name.toLowerCase(Locale.ROOT);
        if (value.endsWith(".webm")) return "video/webm";
        if (value.endsWith(".mkv")) return "video/x-matroska";
        if (value.endsWith(".mov")) return "video/quicktime";
        if (value.endsWith(".avi")) return "video/x-msvideo";
        return "video/mp4";
    }
    private static String hex(byte[] value) { StringBuilder output = new StringBuilder(value.length * 2); for (byte b : value) output.append(String.format(Locale.ROOT, "%02x", b & 255)); return output.toString(); }
    private void checkCancelled() throws InterruptedException { if (cancelled.get() || Thread.currentThread().isInterrupted()) throw new InterruptedException("随机下载已取消"); }

    private final class PendingOutput {
        Uri uri, promotedUri, pendingTargetUri;
        final boolean mediaStore;
        String finalName, sha256;
        JSONObject video;
        long size;
        PendingOutput(Uri uri, boolean mediaStore) { this.uri=uri; this.mediaStore=mediaStore; }
        void commit() throws Exception {
            if (mediaStore) {
                ContentValues values = new ContentValues(); values.put(MediaStore.Video.Media.DISPLAY_NAME, finalName);
                values.put(MediaStore.Video.Media.MIME_TYPE, mime(finalName)); values.put(MediaStore.Video.Media.IS_PENDING, 0);
                if (resolver.update(uri, values, null, null) != 1) throw new IOException("视频写入完成，但发布到媒体库失败：" + finalName);
                promotedUri=uri;
            } else {
                try { promotedUri=DocumentsContract.renameDocument(resolver, uri, finalName); }
                catch (Exception ignored) { promotedUri=null; }
                if (promotedUri == null) {
                    Uri tree=StorageAccess.treeOf(selectedTree); String treeId=DocumentsContract.getTreeDocumentId(tree);
                    Uri parent=DocumentsContract.buildDocumentUriUsingTree(tree,treeId);
                    pendingTargetUri=DocumentsContract.createDocument(resolver,parent,mime(finalName),finalName);
                    if (pendingTargetUri == null) throw new IOException("文件夹不支持改名，也无法创建正式视频文件");
                    try (InputStream input=resolver.openInputStream(uri); OutputStream output=resolver.openOutputStream(pendingTargetUri,"w")) {
                        if(input==null||output==null)throw new IOException("无法发布完整视频文件");
                        byte[] buffer=new byte[128*1024];int length;while((length=input.read(buffer))!=-1){if(cancelled.get())throw new InterruptedException("随机下载已取消");output.write(buffer,0,length);}
                    }
                    try { DocumentsContract.deleteDocument(resolver,uri); } catch(Exception ignored) {}
                    uri=pendingTargetUri;promotedUri=pendingTargetUri;pendingTargetUri=null;
                } else uri=promotedUri;
            }
        }
        void deleteQuietly() {
            // Once a final filename has been published, keep it even if the
            // Room transaction or post-write verification fails. It is safer
            // to show an unindexed local file than to silently erase it.
            if (promotedUri == null) deleteUri(uri);
            if (pendingTargetUri != null) deleteUri(pendingTargetUri);
        }
        private void deleteUri(Uri target) {
            if (target == null) return;
            try { if (DocumentsContract.isDocumentUri(context,target)) DocumentsContract.deleteDocument(resolver,target); else resolver.delete(target,null,null); }
            catch(Exception ignored) { try { resolver.delete(target,null,null); } catch(Exception ignoredAgain) {} }
        }
    }

    private static final class ArchiveEntry {
        final String name;
        final long size, compressedSize, localOffset;
        final boolean descriptor, zip64, directory;
        final long headerCrc;
        long crc, computedCrc;
        ArchiveEntry(String name, long size, long compressedSize, long localOffset, boolean descriptor, boolean zip64, boolean directory, long headerCrc) {
            this.name=name; this.size=size; this.compressedSize=compressedSize; this.localOffset=localOffset;
            this.descriptor=descriptor; this.zip64=zip64; this.directory=directory; this.headerCrc=headerCrc;
        }
    }

    private static final class StoredZipReader {
        final CountingInputStream input;
        final long expectedBytes;
        StoredZipReader(InputStream input, long expectedBytes) { this.input=new CountingInputStream(input); this.expectedBytes=expectedBytes; }
        long position() { return input.count; }
        int readData(byte[] buffer, int requested) throws IOException { return readSome(buffer, 0, requested); }
        ArchiveEntry readLocalHeader() throws IOException {
            long offset = position();
            byte[] header = readBytes(30);
            long signature = u32(header, 0);
            if (signature != LOCAL_FILE) throw new IOException("ZIP 本地文件头无效");
            int flags = u16(header, 6), method = u16(header, 8);
            if ((flags & 1) != 0 || method != 0) throw new IOException("ZIP 加密或压缩格式不受支持 (flags=" + flags + ", method=" + method + ")");
            int nameLength = u16(header, 26), extraLength = u16(header, 28);
            if (nameLength < 1 || nameLength > 4096 || extraLength > 4096) throw new IOException("ZIP 文件头长度异常");
            String name = new String(readBytes(nameLength), java.nio.charset.StandardCharsets.UTF_8);
            byte[] extra = readBytes(extraLength);
            long crc = u32(header, 14), compressed32 = u32(header, 18), size32 = u32(header, 22);
            boolean zip64 = compressed32 == 0xffffffffL || size32 == 0xffffffffL;
            long[] zip64Values = zip64Values(extra, size32 == 0xffffffffL, compressed32 == 0xffffffffL, false);
            int valueIndex = 0;
            long size = size32 == 0xffffffffL ? zip64Values[valueIndex++] : size32;
            long compressed = compressed32 == 0xffffffffL ? zip64Values[valueIndex] : compressed32;
            if (size < 0 || compressed < 0 || size != compressed) throw new IOException("ZIP 未压缩文件长度无效");
            boolean descriptor = (flags & 8) != 0;
            if ((flags & ~0x0808) != 0) throw new IOException("ZIP 标记包含不支持的选项");
            return new ArchiveEntry(name, size, compressed, offset, descriptor, zip64, name.endsWith("/"), crc);
        }
        byte[] readEntryBytes(ArchiveEntry entry, int maximum) throws IOException {
            if (entry.size > maximum) throw new IOException("随机下载清单过大");
            ByteArrayOutputStream output = new ByteArrayOutputStream((int)entry.size);
            CRC32 crc = new CRC32();
            copyEntryBytes(entry, output, null, crc);
            entry.computedCrc = crc.getValue();
            return output.toByteArray();
        }
        void copyEntryBytes(ArchiveEntry entry, OutputStream output, MessageDigest digest, CRC32 crc) throws IOException {
            long remaining = entry.size;
            byte[] buffer = new byte[128 * 1024];
            while (remaining > 0) {
                int length = readData(buffer, (int)Math.min(buffer.length, remaining));
                if (length < 0) throw new IOException("ZIP 项目数据不完整：" + entry.name);
                if (length == 0) continue;
                output.write(buffer, 0, length);
                crc.update(buffer, 0, length);
                if (digest != null) digest.update(buffer, 0, length);
                remaining -= length;
            }
        }
        void verifyDescriptor(ArchiveEntry entry, long computedCrc) throws IOException {
            if (entry.descriptor) {
                byte[] descriptorHead = readBytes(8);
                if (u32(descriptorHead, 0) != DATA_DESCRIPTOR) throw new IOException("ZIP 数据描述符无效");
                long declaredCrc = u32(descriptorHead, 4);
                long declaredCompressed, declaredSize;
                if (entry.zip64) {
                    declaredCompressed = u64(readBytes(8), 0);
                    declaredSize = u64(readBytes(8), 0);
                } else {
                    declaredCompressed = u32(readBytes(4), 0);
                    declaredSize = u32(readBytes(4), 0);
                }
                if (declaredCompressed != entry.compressedSize || declaredSize != entry.size || declaredCrc != computedCrc)
                    throw new IOException("ZIP CRC 或长度校验失败：" + entry.name);
                entry.crc = declaredCrc;
            } else {
                if (entry.headerCrc != computedCrc) throw new IOException("ZIP CRC 校验失败：" + entry.name);
                entry.crc = entry.headerCrc;
            }
        }
        void verifyDirectory(List<ArchiveEntry> expectedEntries) throws IOException {
            long directoryOffset = position();
            for (ArchiveEntry expected : expectedEntries) {
                byte[] header = readBytes(46);
                if (u32(header, 0) != CENTRAL_FILE) throw new IOException("ZIP 中央目录项无效");
                int flags = u16(header, 8), method = u16(header, 10), nameLength = u16(header, 28);
                int extraLength = u16(header, 30), commentLength = u16(header, 32), disk = u16(header, 34);
                long crc = u32(header, 16), compressed32 = u32(header, 20), size32 = u32(header, 24), offset32 = u32(header, 42);
                if ((flags & ~0x0808) != 0 || method != 0 || disk != 0 || nameLength < 1 || nameLength > 4096 || extraLength > 4096 || commentLength > 4096)
                    throw new IOException("ZIP 中央目录包含不支持的项目");
                String name = new String(readBytes(nameLength), java.nio.charset.StandardCharsets.UTF_8);
                byte[] extra = readBytes(extraLength); readBytes(commentLength);
                long[] values = zip64Values(extra, size32 == 0xffffffffL, compressed32 == 0xffffffffL, offset32 == 0xffffffffL);
                int valueIndex = 0;
                long size = size32 == 0xffffffffL ? values[valueIndex++] : size32;
                long compressed = compressed32 == 0xffffffffL ? values[valueIndex++] : compressed32;
                long offset = offset32 == 0xffffffffL ? values[valueIndex] : offset32;
                if (!expected.name.equals(name) || expected.size != size || expected.compressedSize != compressed
                        || expected.localOffset != offset || expected.crc != crc)
                    throw new IOException("ZIP 中央目录与视频数据不一致：" + name);
            }
            long directorySize = position() - directoryOffset;
            long next = u32(readBytes(4), 0);
            if (next == ZIP64_END) {
                byte[] zip64End = new byte[56]; put32(zip64End, 0, next); System.arraycopy(readBytes(52), 0, zip64End, 4, 52);
                if (u64(zip64End, 4) != 44 || u32(zip64End, 16) != 0 || u32(zip64End, 20) != 0
                        || u64(zip64End, 24) != expectedEntries.size() || u64(zip64End, 32) != expectedEntries.size()
                        || u64(zip64End, 40) != directorySize || u64(zip64End, 48) != directoryOffset)
                    throw new IOException("ZIP64 结束目录核验失败");
                long zip64EndOffset = position() - 56;
                byte[] locator = readBytes(20);
                if (u32(locator, 0) != ZIP64_LOCATOR || u32(locator, 4) != 0 || u64(locator, 8) != zip64EndOffset || u32(locator, 16) != 1)
                    throw new IOException("ZIP64 定位器无效");
                byte[] end = readBytes(22);
                if (u32(end, 0) != END || u16(end, 4) != 0 || u16(end, 6) != 0
                        || u16(end, 8) != 0xffff || u16(end, 10) != 0xffff
                        || u32(end, 12) != 0xffffffffL || u32(end, 16) != 0xffffffffL || u16(end, 20) != 0)
                    throw new IOException("ZIP64 结束记录无效");
            } else if (next == END) {
                byte[] end = new byte[22]; put32(end, 0, next); System.arraycopy(readBytes(18), 0, end, 4, 18);
                int commentLength = u16(end, 20);
                if (u16(end, 4) != 0 || u16(end, 6) != 0 || u16(end, 8) != expectedEntries.size()
                        || u16(end, 10) != expectedEntries.size() || u32(end, 12) != directorySize
                        || u32(end, 16) != directoryOffset || commentLength > 0)
                    throw new IOException("ZIP 结束记录无效");
            } else throw new IOException("ZIP 文件缺少结束目录");
        }
        private long[] zip64Values(byte[] extra, boolean needSize, boolean needCompressed, boolean needOffset) throws IOException {
            int at = 0;
            while (at + 4 <= extra.length) {
                int id = u16(extra, at), length = u16(extra, at + 2); at += 4;
                if (at + length > extra.length) throw new IOException("ZIP 扩展字段长度无效");
                if (id == 1) {
                    long[] values = new long[(needSize ? 1 : 0) + (needCompressed ? 1 : 0) + (needOffset ? 1 : 0)];
                    int valueAt = at;
                    for (int i = 0; i < values.length; i++) {
                        if (valueAt + 8 > at + length) throw new IOException("ZIP64 文件长度扩展缺失");
                        values[i] = u64(extra, valueAt); valueAt += 8;
                        if (values[i] < 0) throw new IOException("ZIP64 文件长度超出支持范围");
                    }
                    return values;
                }
                at += length;
            }
            if (needSize || needCompressed || needOffset) throw new IOException("ZIP64 文件长度扩展缺失");
            return new long[0];
        }
        private byte[] readBytes(int length) throws IOException {
            if (length < 0 || position() + length > expectedBytes) throw new IOException("ZIP 响应长度超过或不符清单");
            byte[] bytes = new byte[length]; int at = 0;
            while (at < length) {
                int read = input.read(bytes, at, length - at);
                if (read < 0) throw new IOException("ZIP 分包传输中断");
                if (read > 0) at += read;
            }
            return bytes;
        }
        private int readSome(byte[] bytes, int offset, int length) throws IOException {
            if (position() >= expectedBytes) return -1;
            return input.read(bytes, offset, (int)Math.min(length, expectedBytes - position()));
        }
        private static int u16(byte[] value, int offset) { return (value[offset] & 255) | ((value[offset + 1] & 255) << 8); }
        private static long u32(byte[] value, int offset) { return ((long)value[offset] & 255) | (((long)value[offset + 1] & 255) << 8) | (((long)value[offset + 2] & 255) << 16) | (((long)value[offset + 3] & 255) << 24); }
        private static long u64(byte[] value, int offset) {
            long result = 0;
            for (int i = 7; i >= 0; i--) result = (result << 8) | ((long)value[offset + i] & 255);
            return result;
        }
        private static void put32(byte[] value, int offset, long input) {
            for (int i = 0; i < 4; i++) value[offset + i] = (byte)(input >>> (8 * i));
        }
    }

    private static final class CountingInputStream extends FilterInputStream {
        long count;
        CountingInputStream(InputStream input) { super(input); }
        @Override public int read() throws IOException { int value=super.read(); if(value>=0)count++; return value; }
        @Override public int read(byte[] buffer,int offset,int length) throws IOException { int value=super.read(buffer,offset,length); if(value>0)count+=value; return value; }
    }
}
