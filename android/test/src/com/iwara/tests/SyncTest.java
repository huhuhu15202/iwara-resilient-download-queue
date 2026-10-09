package com.iwara.tests;

import android.app.*;
import android.content.*;
import android.database.Cursor;
import android.os.*;
import com.iwara.local.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Uses the private APK's built-in credential, never prints or passes it through adb. */
public final class SyncTest extends Instrumentation {
    @Override public void onCreate(Bundle args){super.onCreate(args);start();}
    private void require(boolean yes,String message){if(!yes)throw new AssertionError(message);}
    @Override public void onStart(){Bundle result=new Bundle();try{
        Activity activity=startActivitySync(new Intent(Intent.ACTION_MAIN).setClassName("com.iwara.local","com.iwara.local.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));waitForIdleSync();
        ConnectionSettings settings=new ConnectionSettings(activity);String old=settings.origin(),token=settings.token();require(!token.isEmpty(),"Private token absent");
        java.lang.reflect.Method sync=activity.getClass().getDeclaredMethod("sync");sync.setAccessible(true);java.lang.reflect.Field busy=activity.getClass().getDeclaredField("busy");busy.setAccessible(true);StringBuilder timing=new StringBuilder();
        try{for(String origin:settings.presets()){
            settings.save(origin,token);long begin=SystemClock.elapsedRealtime();runOnMainSync(()->{try{sync.invoke(activity);}catch(Exception error){throw new RuntimeException(error);}});AtomicBoolean working=new AtomicBoolean(true);
            do{Thread.sleep(100);runOnMainSync(()->{try{working.set(busy.getBoolean(activity));}catch(Exception error){throw new RuntimeException(error);}});}while(working.get()&&SystemClock.elapsedRealtime()-begin<45000);
            require(!working.get(),"Sync timed out: "+origin);LibraryDb db=new LibraryDb(activity);try{require(db.catalogueStats()[0]>=2000,"Catalogue was not downloaded");try(Cursor rows=db.getReadableDatabase().rawQuery("SELECT COUNT(*) FROM catalogue WHERE download_time>0",null)){rows.moveToFirst();require(rows.getInt(0)>0,"PC download completion field not synced");}require(db.all(false).stream().anyMatch(video->"matched".equals(video.status)&&video.downloadTime>0),"Renamed full-content matched video lost PC time");}finally{db.close();}
            timing.append(origin).append(" ").append(SystemClock.elapsedRealtime()-begin).append("ms; ");
        }}finally{settings.save(old,token);}
        result.putString("result","PASS: installed app LAN and Tailscale-address catalogue sync; PC completion timestamps imported; arbitrary-name fingerprint identity retained; "+timing);finish(Activity.RESULT_OK,result);
    }catch(Throwable error){result.putString("error",android.util.Log.getStackTraceString(error));finish(Activity.RESULT_CANCELED,result);}}
}
