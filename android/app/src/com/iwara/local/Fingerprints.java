package com.iwara.local;

import java.io.InputStream;
import java.nio.ByteBuffer;
import java.security.MessageDigest;

/** Versioned byte-level fingerprint shared with mobile-library.mjs. */
public final class Fingerprints {
    public interface Source { InputStream open() throws Exception; }
    public interface Cancellation { boolean cancelled(); }
    private static void check(Cancellation cancellation) throws InterruptedException {
        if (Thread.currentThread().isInterrupted() || cancellation.cancelled()) throw new InterruptedException("扫描已取消");
    }
    public static String full(Source source, Cancellation cancellation) throws Exception {
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[256 * 1024];
        try (InputStream stream = source.open()) {
            int length;
            while ((length = stream.read(buffer)) != -1) { check(cancellation); if (length > 0) hash.update(buffer, 0, length); }
        }
        return hex(hash.digest());
    }
    public static String sample(Source source, long size, Cancellation cancellation) throws Exception {
        if (size < 0) throw new IllegalArgumentException("未知文件长度");
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        hash.update(ByteBuffer.allocate(8).putLong(size).array());
        long[] offsets = {0, Math.max(0, Math.floorDiv(size - 65536, 2)), Math.max(0, size - 65536)};
        byte[] buffer = new byte[65536];
        for (long offset : offsets) {
            check(cancellation);
            int length = (int)Math.min(65536, size - offset);
            hash.update(ByteBuffer.allocate(12).putLong(offset).putInt(length).array());
            try (InputStream stream = source.open()) {
                long skip = offset;
                while (skip > 0) { check(cancellation); long skipped = stream.skip(skip); if (skipped > 0) skip -= skipped; else { if (stream.read() == -1) throw new IllegalStateException("视频不完整"); skip--; } }
                int total = 0;
                while (total < length) { check(cancellation); int read = stream.read(buffer, total, length - total); if (read < 0) throw new IllegalStateException("视频不完整"); if (read > 0) total += read; }
                hash.update(buffer, 0, length);
            }
        }
        return hex(hash.digest());
    }
    private static String hex(byte[] bytes) { StringBuilder result = new StringBuilder(64); for (byte value : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255)); return result.toString(); }
}
