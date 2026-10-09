package com.iwara.tests;
import android.app.Instrumentation;
import android.app.Activity;
import android.content.*;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.widget.GridView;
import android.widget.Button;
import com.iwara.local.LibraryDb;
import com.iwara.local.VideoScanner;
import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

public class IntegrationTest extends Instrumentation {
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments);start(); }
    private void require(boolean condition,String reason) {if(!condition)throw new AssertionError(reason);}
    private InputStream download(String route) throws Exception {HttpURLConnection connection=(HttpURLConnection)new URL("http://10.0.2.2:18880"+route).openConnection();connection.setConnectTimeout(10000);connection.setReadTimeout(10000);connection.setRequestProperty("x-iwara-access-token","isolated-test");require(connection.getResponseCode()==200,"HTTP download failed");return connection.getInputStream();}
    private void copy(InputStream input,OutputStream output)throws Exception{byte[] bytes=new byte[65536];int n;while((n=input.read(bytes))!=-1)output.write(bytes,0,n);}
    @Override public void onStart() {
        Bundle result=new Bundle();
        try {
            Context context=getTargetContext();ContentResolver resolver=context.getContentResolver();context.deleteDatabase("phone-library.sqlite");
            // Delete only this test's old emulator fixtures, never another directory.
            resolver.delete(MediaStore.Video.Media.EXTERNAL_CONTENT_URI,MediaStore.Video.Media.RELATIVE_PATH+"=?",new String[]{"Movies/IwaraIsolatedTest/"});
            for(String name:new String[]{"red","blue","green","unknown"}) {
                ContentValues values=new ContentValues();values.put(MediaStore.Video.Media.DISPLAY_NAME,"arbitrary-no-id-"+name+".mp4");values.put(MediaStore.Video.Media.MIME_TYPE,"video/mp4");values.put(MediaStore.Video.Media.RELATIVE_PATH,"Movies/IwaraIsolatedTest");values.put(MediaStore.Video.Media.IS_PENDING,1);
                Uri uri=resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI,values);require(uri!=null,"MediaStore insert");
                try(InputStream input=download("/"+name+".mp4");OutputStream output=resolver.openOutputStream(uri)){copy(input,output);}
                values.clear();values.put(MediaStore.Video.Media.IS_PENDING,0);resolver.update(uri,values,null,null);
            }
            File catalogue=new File(context.getCacheDir(),"isolated-catalogue.sqlite");try(InputStream input=download("/catalog.sqlite");OutputStream output=new FileOutputStream(catalogue)){copy(input,output);}
            LibraryDb db=new LibraryDb(context);require(db.importCatalogue(catalogue)==4,"Import did not return 4 rows");catalogue.delete();
            VideoScanner scanner=new VideoScanner(context,db,new AtomicBoolean());scanner.scan(null,(message,refresh)->{});
            List<LibraryDb.Video> videos=db.all(false);require(videos.size()==4,"Wrong discovered count "+videos.size());
            require(videos.stream().filter(video->"han1".equals(video.source)).count()==1,"Han1 source metadata was not imported");require(videos.stream().filter(video->"iwara".equals(video.source)).count()==2,"Iwara source metadata was not imported");require(videos.stream().filter(video->"other".equals(video.source)).count()==1,"Unknown/local source should remain in All");
            int matched=0,conflict=0,unmatched=0;
            for(LibraryDb.Video video:videos){if("matched".equals(video.status))matched++;else if("conflict".equals(video.status))conflict++;else unmatched++;}
            require(matched==2&&conflict==1&&unmatched==1,"Identity outcomes wrong: "+matched+"/"+conflict+"/"+unmatched);
            LibraryDb.Video first=videos.stream().filter(video->"matched".equals(video.status)).findFirst().get();
            ContentValues rename=new ContentValues();rename.put(MediaStore.Video.Media.DISPLAY_NAME,"totally-renamed-again.mp4");resolver.update(Uri.parse(first.uri),rename,null,null);
            scanner.scan(null,(message,refresh)->{});require(db.all(false).stream().anyMatch(video->"totally-renamed-again.mp4".equals(video.name)&&first.taskId.equals(video.taskId)),"Rename lost identity");
            db.hidden(first.uri,true);require(db.all(false).size()==3,"Hide failed");require(db.all(true).size()==1,"Hidden record missing");
            File again=new File(context.getCacheDir(),"catalogue-again.sqlite");try(InputStream input=download("/catalog.sqlite");OutputStream output=new FileOutputStream(again)){copy(input,output);}db.importCatalogue(again);again.delete();scanner.match((message,refresh)->{});require(db.all(true).size()==1,"Sync lost hidden state");db.hidden(first.uri,false);
            int[] stats=db.catalogueStats();require(stats[0]==4&&stats[1]==4,"Catalogue stats");db.close();
            Intent launch=new Intent(Intent.ACTION_MAIN);launch.setClassName("com.iwara.local","com.iwara.local.MainActivity");launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);Activity activity=startActivitySync(launch);waitForIdleSync();
            java.lang.reflect.Field field=activity.getClass().getDeclaredField("grid");field.setAccessible(true);GridView grid=(GridView)field.get(activity);require(grid.getAdapter().getCount()==4,"Real UI list count");
            java.lang.reflect.Field sourceButtonsField=activity.getClass().getDeclaredField("sourceButtons");sourceButtonsField.setAccessible(true);Button[] sourceButtons=(Button[])sourceButtonsField.get(activity);runOnMainSync(()->sourceButtons[2].performClick());require(grid.getAdapter().getCount()==1,"Han1 source switch did not filter actual cards");runOnMainSync(()->sourceButtons[1].performClick());require(grid.getAdapter().getCount()==2,"Iwara source switch did not filter actual cards");runOnMainSync(()->sourceButtons[0].performClick());require(grid.getAdapter().getCount()==4,"All source switch did not restore mixed library");
            java.lang.reflect.Field tag=activity.getClass().getDeclaredField("tag");tag.setAccessible(true);java.lang.reflect.Method refresh=activity.getClass().getDeclaredMethod("refresh",boolean.class);refresh.setAccessible(true);
            runOnMainSync(()->{try{tag.set(activity,"dance");refresh.invoke(activity,false);}catch(Exception error){throw new RuntimeException(error);}});require(grid.getAdapter().getCount()==1,"Tag filter not bound to actual cards");
            runOnMainSync(()->{try{tag.set(activity,"");refresh.invoke(activity,false);}catch(Exception error){throw new RuntimeException(error);}});
            runOnMainSync(()->grid.performItemClick(grid.getChildAt(0),0,grid.getAdapter().getItemId(0)));
            waitForIdleSync();result.putString("result","PASS: MediaStore, SQLite import, Han1/Iwara/other source migration and UI switching, content-only match, conflict, unknown, rename, hide-preservation, real UI, tag filter, external-player dispatch");
            finish(Activity.RESULT_OK,result);
        } catch(Throwable error){result.putString("error",android.util.Log.getStackTraceString(error));finish(Activity.RESULT_CANCELED,result);}
    }
}
