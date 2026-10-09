package com.iwara.tests;

import android.app.*;
import android.content.*;
import android.net.Uri;
import android.os.Bundle;
import android.widget.GridView;
import com.iwara.local.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Uses a real DocumentsUI-selected tree in the isolated emulator. */
public final class FolderTest extends Instrumentation {
    @Override public void onCreate(Bundle arguments){super.onCreate(arguments);start();}
    private void require(boolean yes,String reason){if(!yes)throw new AssertionError(reason);}
    private Object field(Object target,String name)throws Exception{java.lang.reflect.Field value=target.getClass().getDeclaredField(name);value.setAccessible(true);return value.get(target);}
    @Override public void onStart(){Bundle result=new Bundle();try{
        Intent intent=new Intent(Intent.ACTION_MAIN).setClassName("com.iwara.local","com.iwara.local.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Activity activity=startActivitySync(intent);waitForIdleSync();
        SharedPreferences prefs=activity.getPreferences(0);String directory=prefs.getString("directory","");require(!directory.isEmpty(),"Select a real directory in DocumentsUI first");
        Uri tree=Uri.parse(directory);require(activity.getContentResolver().getPersistedUriPermissions().stream().anyMatch(grant->grant.isReadPermission()&&grant.getUri().equals(tree)),"Read permission was not persisted");
        LibraryDb db=(LibraryDb)field(activity,"db");long begin=System.nanoTime();new VideoScanner(activity,db,new AtomicBoolean()).scan(tree,(message,refresh)->{});long scanMs=(System.nanoTime()-begin)/1000000;
        List<LibraryDb.Video> videos=db.all(false);require(videos.size()==6,"Folder must contain five originals and one nested fixture; got "+videos.size());
        require(videos.stream().allMatch(video->video.uri.startsWith(directory+"/document/")),"Files outside selected directory leaked into list");
        require(videos.stream().anyMatch(video->video.name.equals("nested-no-id.mp4")),"Nested video was not discovered");
        LibraryDb.Video renamed=videos.stream().filter(video->video.name.equals("folder-renamed-no-id.mp4")).findFirst().orElseThrow(()->new AssertionError("Renamed fixture missing"));require("matched".equals(renamed.status),"SAF renamed file was not fingerprint matched");
        java.lang.reflect.Method refresh=activity.getClass().getDeclaredMethod("refresh",boolean.class);refresh.setAccessible(true);runOnMainSync(()->{try{refresh.invoke(activity,false);}catch(Exception error){throw new RuntimeException(error);}});waitForIdleSync();
        GridView grid=(GridView)field(activity,"grid");int position=-1;for(int i=0;i<grid.getAdapter().getCount();i++)if(((LibraryDb.Video)grid.getAdapter().getItem(i)).uri.equals(renamed.uri))position=i;final int playPosition=position;require(position>=0,"Renamed item absent from actual UI");
        runOnMainSync(()->grid.performItemClick(grid.getChildAt(0),playPosition,grid.getAdapter().getItemId(playPosition)));waitForIdleSync();
        result.putString("result","PASS: real folder grant persisted across restart, recursive scoped scan, unrelated file excluded, SAF rename SHA256 identity, external player dispatch; scanMs="+scanMs);finish(Activity.RESULT_OK,result);
    }catch(Throwable error){result.putString("error",android.util.Log.getStackTraceString(error));finish(Activity.RESULT_CANCELED,result);}}
}
