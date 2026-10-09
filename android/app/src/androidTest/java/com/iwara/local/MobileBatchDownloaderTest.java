package com.iwara.local;

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
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.Collections;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class MobileBatchDownloaderTest {
    @Test public void extractsVerifiedBatchIntoAppMediaFolderAndRegistersMetadata() throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        context.deleteDatabase("phone-library.sqlite");
        LibraryDb db=new LibraryDb(context); Uri inserted=null;
        byte[] videoBytes="verified-mobile-video".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        try {
            JSONObject video=new JSONObject();video.put("taskId","task-han-55");video.put("videoId","han1meview-55");video.put("source","han1");video.put("title","Han test video");video.put("author","test-author");video.put("uploadTime",1720000000000L);video.put("views",42);video.put("tags",new JSONArray().put("dance"));video.put("downloadTime",1720000001000L);video.put("name","sample.mp4");video.put("size",videoBytes.length);video.put("entryName","media/001-sample.mp4");
            JSONObject manifest=new JSONObject();manifest.put("type","iwara-mobile-random-batch");manifest.put("version",1);manifest.put("source","han1");manifest.put("videos",new JSONArray().put(video));
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(ZipOutputStream zip=new ZipOutputStream(bytes)){
                putStored(zip,"manifest.json",manifest.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                putStored(zip,"media/001-sample.mp4",videoBytes);
            }
            MobileBatchDownloader downloader=new MobileBatchDownloader(context,db,new AtomicBoolean(false),null,true);
            assertEquals(1,downloader.receive(new ByteArrayInputStream(bytes.toByteArray()),bytes.size(),(received,total,current)->{}));
            assertEquals(1,db.catalogueStats()[0]);
            assertEquals(Collections.singletonList("task-han-55"),db.downloadedTaskIds());
            LibraryDb.Video row=db.all(false).get(0);assertEquals("han1",row.source);assertEquals("Han test video",row.title);assertEquals("matched",row.status);assertEquals(videoBytes.length,row.size);
            assertNotNull("the phone must keep the cross-device sample fingerprint",row.sample);assertEquals(64,row.sample.length());
            inserted=Uri.parse(row.uri);
            try(InputStream input=context.getContentResolver().openInputStream(inserted)){assertNotNull(input);ByteArrayOutputStream actual=new ByteArrayOutputStream();byte[] buffer=new byte[128];int count;while((count=input.read(buffer))!=-1)actual.write(buffer,0,count);assertArrayEquals(videoBytes,actual.toByteArray());}
            try(Cursor media=context.getContentResolver().query(inserted,new String[]{MediaStore.Video.Media.DISPLAY_NAME,MediaStore.Video.Media.IS_PENDING,MediaStore.Video.Media.RELATIVE_PATH},null,null,null)){
                assertNotNull(media);assertTrue(media.moveToFirst());assertTrue(media.getString(0).startsWith("Han1_han1meview-55_sample"));assertEquals(0,media.getInt(1));assertTrue(media.getString(2).contains("IwaraLocal"));
            }
        } finally {
            if(inserted!=null)context.getContentResolver().delete(inserted,null,null);
            db.close();context.deleteDatabase("phone-library.sqlite");
        }
    }

    @Test public void rejectsIncompleteArchiveAndRemovesPendingMedia() throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        context.deleteDatabase("phone-library.sqlite");LibraryDb db=new LibraryDb(context);
        try {
            byte[] bytes="not a zip".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            MobileBatchDownloader downloader=new MobileBatchDownloader(context,db,new AtomicBoolean(false),null,true);
            try { downloader.receive(new ByteArrayInputStream(bytes),bytes.length,(received,total,current)->{});fail("expected invalid archive"); }
            catch(java.io.IOException expected){assertTrue(expected.getMessage().contains("随机下载包")||expected.getMessage().contains("ZIP"));}
            assertEquals(0,db.catalogueStats()[0]);assertTrue(db.all(false).isEmpty());
        } finally {db.close();context.deleteDatabase("phone-library.sqlite");}
    }

    @Test public void rejectsCrcCorruptionWithoutPublishingOrRegisteringVideo() throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();context.deleteDatabase("phone-library.sqlite");LibraryDb db=new LibraryDb(context);
        byte[] media="unique crc-check payload 123456789".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        try {
            byte[] archive=archive(media,media.length,"media/001-crc.mp4");int offset=indexOf(archive,media);assertTrue(offset>=0);archive[offset+5]^=0x40;
            try { new MobileBatchDownloader(context,db,new AtomicBoolean(false),null,true).receive(new ByteArrayInputStream(archive),archive.length,(received,total,current)->{});fail("CRC-corrupted archive should fail"); }
            catch(java.io.IOException expected){assertTrue(expected.getMessage().toLowerCase(java.util.Locale.ROOT).contains("crc")||expected.getCause()!=null);}
            assertEquals(0,db.catalogueStats()[0]);assertTrue(db.all(false).isEmpty());assertEquals(0,pendingCount(context));
        } finally {db.close();context.deleteDatabase("phone-library.sqlite");}
    }

    @Test public void rejectsManifestSizeMismatchAndTruncatedCentralDirectory() throws Exception {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();context.deleteDatabase("phone-library.sqlite");LibraryDb db=new LibraryDb(context);
        byte[] media="length-check-payload".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        try {
            byte[] wrongSize=archive(media,media.length+1,"media/001-size.mp4");
            try { new MobileBatchDownloader(context,db,new AtomicBoolean(false),null,true).receive(new ByteArrayInputStream(wrongSize),wrongSize.length,(received,total,current)->{});fail("manifest size mismatch should fail"); }
            catch(java.io.IOException expected){assertTrue(expected.getMessage().contains("长度"));}
            assertEquals(0,db.catalogueStats()[0]);assertEquals(0,pendingCount(context));

            byte[] valid=archive(media,media.length,"media/001-truncated.mp4");byte[] truncated=java.util.Arrays.copyOf(valid,valid.length-12);
            try { new MobileBatchDownloader(context,db,new AtomicBoolean(false),null,true).receive(new ByteArrayInputStream(truncated),valid.length,(received,total,current)->{});fail("truncated archive should fail"); }
            catch(java.io.IOException expected){assertTrue(expected.getMessage().contains("不完整")||expected.getMessage().contains("ZIP")||expected.getMessage().contains("清单"));}
            assertEquals(0,db.catalogueStats()[0]);assertTrue(db.all(false).isEmpty());assertEquals(0,pendingCount(context));
        } finally {db.close();context.deleteDatabase("phone-library.sqlite");}
    }

    private static byte[] archive(byte[] media,long manifestSize,String entryName)throws Exception{
        JSONObject video=new JSONObject();video.put("taskId","task-crash-safe-1");video.put("videoId","iwara-crash-safe-1");video.put("source","iwara");video.put("title","receiver hardening test");video.put("author","isolated");video.put("tags",new JSONArray());video.put("name","receiver-test.mp4");video.put("size",manifestSize);video.put("entryName",entryName);
        JSONObject manifest=new JSONObject();manifest.put("type","iwara-mobile-random-batch");manifest.put("version",1);manifest.put("source","iwara");manifest.put("videos",new JSONArray().put(video));
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(ZipOutputStream zip=new ZipOutputStream(bytes)){
            putStored(zip,"manifest.json",manifest.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));putStored(zip,entryName,media);
        }return bytes.toByteArray();
    }
    private static void putStored(ZipOutputStream zip,String name,byte[] bytes)throws Exception{CRC32 crc=new CRC32();crc.update(bytes);ZipEntry entry=new ZipEntry(name);entry.setMethod(ZipEntry.STORED);entry.setSize(bytes.length);entry.setCompressedSize(bytes.length);entry.setCrc(crc.getValue());zip.putNextEntry(entry);zip.write(bytes);zip.closeEntry();}
    private static int indexOf(byte[] haystack,byte[] needle){outer:for(int i=0;i<=haystack.length-needle.length;i++){for(int j=0;j<needle.length;j++)if(haystack[i+j]!=needle[j])continue outer;return i;}return -1;}
    private static int pendingCount(Context context){try(Cursor rows=context.getContentResolver().query(MediaStore.Video.Media.EXTERNAL_CONTENT_URI,new String[]{MediaStore.Video.Media._ID},MediaStore.Video.Media.DISPLAY_NAME+" LIKE ?",new String[]{".iwara-transfer-%"},null)){return rows==null?-1:rows.getCount();}}
}
