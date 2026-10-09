package com.iwara.tests;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.GridView;
import android.widget.TextView;

/** Checks the actual installed Activity, not a web mock-up. */
public final class UiTest extends Instrumentation {
    @Override public void onCreate(Bundle args){super.onCreate(args);start();}
    private void require(boolean yes,String message){if(!yes)throw new AssertionError(message);}
    private Object field(Object target,String name)throws Exception{java.lang.reflect.Field field=target.getClass().getDeclaredField(name);field.setAccessible(true);return field.get(target);}
    @Override public void onStart(){Bundle result=new Bundle();try{
        Intent intent=new Intent(Intent.ACTION_MAIN);intent.setClassName("com.iwara.local","com.iwara.local.MainActivity");intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);Activity activity=startActivitySync(intent);waitForIdleSync();
        GridView grid=(GridView)field(activity,"grid");require(grid.getAdapter().getCount()>=4,"Test media not present");require(grid.getNumColumns()==(activity.getResources().getConfiguration().screenWidthDp>=600?3:2),"Wrong responsive column count");
        for(String name:new String[]{"libraryNav","randomNav"}){Object nav=field(activity,name);TextView title=(TextView)field(nav,"title");View image=(View)field(nav,"image");require((title.getGravity()&Gravity.HORIZONTAL_GRAVITY_MASK)==Gravity.CENTER_HORIZONTAL,"Bottom label not centred");int[] labelPos=new int[2],imagePos=new int[2];title.getLocationOnScreen(labelPos);image.getLocationOnScreen(imagePos);require(Math.abs((labelPos[0]+title.getWidth()/2)-(imagePos[0]+image.getWidth()/2))<=2,"Icon and label centres differ");}
        int height=-1;for(int i=0;i<grid.getChildCount();i++){View card=grid.getChildAt(i);if(height<0)height=card.getHeight();require(card.getHeight()==height,"Uneven card heights");require(card.getRight()<=grid.getWidth(),"Card overflows screen");}
        com.iwara.local.GlassSurface glass=(com.iwara.local.GlassSurface)field(activity,"navGlass");
        require(glass.isUsingShader(),"Android 13+ glass fell back unexpectedly");
        require(glass.getWidth()<=activity.getResources().getDisplayMetrics().widthPixels&&glass.getHeight()<=80*activity.getResources().getDisplayMetrics().density,"Glass is not a bounded navigation surface");
        Thread.sleep(1500);waitForIdleSync();int before=glass.getRecordings();Thread.sleep(500);waitForIdleSync();require(glass.getRecordings()-before<4,"Glass keeps rendering while idle");
        java.lang.reflect.Method random=activity.getClass().getDeclaredMethod("randomBatch");random.setAccessible(true);runOnMainSync(()->{try{random.invoke(activity);}catch(Exception error){throw new RuntimeException(error);}});require(grid.getAdapter().getCount()<=30,"Random batch exceeds limit");
        java.lang.reflect.Method saved=activity.getClass().getDeclaredMethod("onSaveInstanceState",Bundle.class);saved.setAccessible(true);Bundle snapshot=new Bundle();runOnMainSync(()->{try{saved.invoke(activity,snapshot);}catch(Exception error){throw new RuntimeException(error);}});require(snapshot.getBoolean("random")&&snapshot.getStringArrayList("batch").size()==grid.getAdapter().getCount(),"Random batch is not saved for Activity recreation");
        result.putString("result","PASS: centred icon/labels, responsive grid, equal card heights, no overflow, bounded real AGSL glass without idle rendering, random batch and return state; widthDp="+activity.getResources().getConfiguration().screenWidthDp);finish(Activity.RESULT_OK,result);
    }catch(Throwable error){result.putString("error",android.util.Log.getStackTraceString(error));finish(Activity.RESULT_CANCELED,result);}}
}
