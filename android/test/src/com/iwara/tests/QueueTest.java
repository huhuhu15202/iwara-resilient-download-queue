package com.iwara.tests;

import android.app.*;
import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.os.*;
import com.iwara.local.*;
import org.json.*;
import java.util.*;

/** Actual cross-UID SAF permission and result-chain tests, using only emulator copies. */
public final class QueueTest extends Instrumentation {
    private Activity owner;
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
    private void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
    private void mode(String mode) { ContentValues values=new ContentValues();values.put("mode",mode);getTargetContext().getContentResolver().update(QueueProbeProvider.URI,values,null,null); }
    private JSONArray records() throws Exception { try(Cursor rows=getTargetContext().getContentResolver().query(QueueProbeProvider.URI,null,null,null,null)){require(rows!=null&&rows.moveToFirst(),"Mock reports unavailable");return new JSONArray(rows.getString(0));} }
    private JSONArray await(int count) throws Exception {
        long deadline=SystemClock.elapsedRealtime()+20000;JSONArray result;
        do {Thread.sleep(50);result=records();}while(result.length()<count&&SystemClock.elapsedRealtime()<deadline);
        require(result.length()==count,"Expected "+count+" MX launches, got "+result.length());Thread.sleep(400);waitForIdleSync();return records();
    }
    private void launch(List<LibraryDb.Video> videos,int start)throws Exception {
        final Exception[] failure={null};runOnMainSync(()->{try{ExternalPlaybackActivity.open(owner,videos,videos.get(start).uri);}catch(Exception error){failure[0]=error;}});
        if(failure[0]!=null)throw failure[0];
    }
    private void check(JSONObject report,List<LibraryDb.Video> expected,int from,int end,int start)throws Exception {
        JSONArray uris=report.getJSONArray("uris"),names=report.getJSONArray("names"),reads=report.getJSONArray("reads");
        require(uris.length()==end-from&&names.length()==uris.length(),"Queue/name count mismatch");
        require(report.getInt("clipCount")==uris.length(),"Missing URI grants for following videos");
        require(report.getBoolean("explicit")&&report.getBoolean("returnResult"),"MX queue control flags absent");
        require(report.getString("data").equals(expected.get(start).uri),"Wrong clicked starting video");
        for(int i=0;i<uris.length();i++){require(uris.getString(i).equals(expected.get(from+i).uri),"Order changed at "+i);require(names.getString(i).equals(expected.get(from+i).displayTitle()),"Title changed");require(reads.getInt(i)>0,"External player cannot read queue entry "+i);}
    }
    @Override public void onStart() {
        Bundle result=new Bundle();LibraryDb db=null;
        try {
            Activity main=startActivitySync(new Intent(Intent.ACTION_MAIN).setClassName("com.iwara.local","com.iwara.local.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));owner=main;waitForIdleSync();
            db=new LibraryDb(getTargetContext());List<LibraryDb.Video> videos=db.all(false);require(videos.size()==6,"Use the six scoped emulator fixtures");
            Collections.reverse(videos);MxQueue queue=MxQueue.snapshot(videos,videos.get(2).uri);Intent intent=queue.batch();
            require(intent.getData().toString().equals(videos.get(2).uri),"Clicked start lost");require(intent.getParcelableArrayExtra("video_list").length==6,"List not supplied");
            queue.waiting=true;queue.player="com.mxtech.videoplayer.ad";queue.save(getTargetContext());MxQueue restored=MxQueue.load(getTargetContext(),queue.id);
            require(restored.uris.equals(queue.uris)&&restored.titles.equals(queue.titles)&&restored.waiting&&restored.start==2,"Process recreation snapshot lost");queue.delete(getTargetContext());
            List<LibraryDb.Video> duplicates=new ArrayList<>(videos);duplicates.add(videos.get(0));require(MxQueue.snapshot(duplicates,videos.get(0).uri).uris.size()==6,"Duplicate URI repeated");
            boolean rejected=false;try{MxQueue.snapshot(videos,"content://invalid/missing");}catch(IllegalArgumentException expected){rejected=true;}require(rejected,"Stale clicked item silently replaced");

            mode("user");launch(videos,2);check(await(1).getJSONObject(0),videos,0,6,2);
            // Click the real grid route: it must hand over the visible filtered order.
            java.lang.reflect.Field items=main.getClass().getDeclaredField("items");items.setAccessible(true);
            @SuppressWarnings("unchecked") List<LibraryDb.Video> visible=new ArrayList<>((List<LibraryDb.Video>)items.get(main));
            java.lang.reflect.Method open=main.getClass().getDeclaredMethod("openVideo",LibraryDb.Video.class);open.setAccessible(true);
            mode("user");runOnMainSync(()->{try{open.invoke(main,visible.get(3));}catch(Exception error){throw new RuntimeException(error);}});check(await(1).getJSONObject(0),visible,0,6,3);
            java.lang.reflect.Method random=main.getClass().getDeclaredMethod("randomPlay");random.setAccessible(true);
            mode("user");runOnMainSync(()->{try{random.invoke(main);}catch(Exception error){throw new RuntimeException(error);}});
            JSONObject randomReport=await(1).getJSONObject(0);Set<String> seen=new HashSet<>();JSONArray randomUris=randomReport.getJSONArray("uris");
            for(int i=0;i<randomUris.length();i++)seen.add(randomUris.getString(i));require(seen.equals(new HashSet<>(queue.uris))&&randomUris.length()==6,"Random queue leaks outside current list or duplicates items");
            require(randomReport.getString("data").equals(randomUris.getString(0)),"Random does not begin with its first entry");

            ActivityMonitor monitor=addMonitor("com.iwara.local.ExternalPlaybackActivity",null,false);
            mode("hold");launch(videos,2);Activity bridge=waitForMonitorWithTimeout(monitor,5000);require(bridge!=null,"Queue activity missing");await(1);
            runOnMainSync(()->bridge.recreate());Thread.sleep(800);require(records().length()==1,"Activity recreation restarted external playback");
            getTargetContext().getContentResolver().call(QueueProbeProvider.URI,"finish",null,null);Thread.sleep(500);waitForIdleSync();removeMonitor(monitor);
            require(records().length()==1,"Returned player relaunched after recreation");

            List<LibraryDb.Video> large=new ArrayList<>();
            for(int i=0;i<405;i++){LibraryDb.Video video=new LibraryDb.Video();video.uri=Uri.parse(videos.get(i%6).uri).buildUpon().appendQueryParameter("isolated_queue",String.valueOf(i)).build().toString();video.title="Ordered fixture "+i;video.name=video.title;large.add(video);}
            mode("complete");launch(large,17);JSONArray batches=await(3);check(batches.getJSONObject(0),large,0,200,17);check(batches.getJSONObject(1),large,200,400,200);check(batches.getJSONObject(2),large,400,405,400);
            Thread.sleep(500);require(records().length()==3,"Queue unexpectedly looped");
            for(String endMode:new String[]{"user","error","cancel"}){mode(endMode);launch(large,17);await(1);Thread.sleep(500);require(records().length()==1,"Auto continued on "+endMode);}
            MxQueue partial=MxQueue.snapshot(large,large.get(0).uri);partial.batch();partial.waiting=true;
            require(!partial.advance(Activity.RESULT_OK,new Intent("com.mxtech.intent.result.VIEW").setData(Uri.parse(large.get(5).uri)).putExtra("end_by","playback_completion")),"Early completion skipped unplayed entries");
            List<LibraryDb.Video> longAddresses=new ArrayList<>();for(int i=0;i<700;i++){LibraryDb.Video video=new LibraryDb.Video();video.uri="content://test/video/"+i+"/"+String.join("",Collections.nCopies(1600,"x"));video.title="Long address "+i;longAddresses.add(video);}
            MxQueue bounded=MxQueue.snapshot(longAddresses,longAddresses.get(190).uri);Intent safe=bounded.batch();require(MxQueue.parcelBytes(safe)<=MxQueue.MAX_INTENT_BYTES&&safe.getData().toString().equals(longAddresses.get(190).uri),"Binder safety lost clicked start");
            require(safe.getClipData().getItemCount()==safe.getParcelableArrayExtra("video_list").length,"Bounded grants missing");
            result.putString("result","PASS: visible-order and clicked-start queue, random membership, all cross-UID SAF read grants, 405 items / 3 batches, user/error/cancel stop, duplicate guard, snapshot and live activity recreation, long-URI Binder bound; fixtures untouched");finish(Activity.RESULT_OK,result);
        } catch(Throwable error){result.putString("error",android.util.Log.getStackTraceString(error));finish(Activity.RESULT_CANCELED,result);}finally{if(db!=null)db.close();}
    }
}
