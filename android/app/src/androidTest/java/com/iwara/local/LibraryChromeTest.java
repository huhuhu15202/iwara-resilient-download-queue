package com.iwara.local;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.Intent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.GridView;
import android.widget.BaseAdapter;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.ArrayList;
import java.util.Set;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class LibraryChromeTest {
    @Test public void searchStaysVisibleWhileCompactControlsCollapseAndReturn() throws Exception {
        android.app.Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
        Context context=instrumentation.getTargetContext();Activity activity=instrumentation.startActivitySync(
                new Intent(context,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        @SuppressWarnings("unchecked") ArrayList<LibraryDb.Video> items=(ArrayList<LibraryDb.Video>)field(activity,"items");
        @SuppressWarnings("unchecked") Set<String> failedCovers=(Set<String>)field(activity,"failedCovers");
        ArrayList<String> fixtureKeys=new ArrayList<>();
        try {
            instrumentation.waitForIdleSync();
            EditText search=(EditText)field(activity,"search");View controls=(View)field(activity,"controlsPanel");
            GridView grid=(GridView)field(activity,"grid");View empty=(View)field(activity,"emptyView");BaseAdapter adapter=(BaseAdapter)field(activity,"adapter");
            assertTrue("Search must remain visible in the fixed header",search.isShown());
            assertTrue("Source and filter controls begin expanded",controls.getVisibility()==View.VISIBLE);
            for(int i=0;i<48;i++){LibraryDb.Video video=new LibraryDb.Video();video.uri="content://chrome-test/"+i;video.name="fixture-"+i+".mp4";video.title="Scrolling fixture "+i;video.size=1024*1024;video.modified=i;video.views=100;video.tags="[]";video.status="matched";items.add(video);String key=video.uri+"|"+video.size+"|"+video.modified;fixtureKeys.add(key);failedCovers.add(key);}
            activity.runOnUiThread(()->{empty.setVisibility(View.GONE);adapter.notifyDataSetChanged();grid.setSelection(0);});instrumentation.waitForIdleSync();Thread.sleep(250);
            activity.runOnUiThread(()->grid.setSelection(30));instrumentation.waitForIdleSync();Thread.sleep(350);
            assertEquals("Scrolling down can collapse the control strip",View.GONE,controls.getVisibility());
            assertTrue("The search header must stay visible after the control strip collapses",search.isShown());
            activity.runOnUiThread(()->grid.setSelection(12));instrumentation.waitForIdleSync();Thread.sleep(350);
            assertEquals("An upward reveal restores the source/filter strip",View.VISIBLE,controls.getVisibility());
            assertTrue(search.isShown());
        } finally { instrumentation.runOnMainSync(()->{items.removeIf(video->video.uri!=null&&video.uri.startsWith("content://chrome-test/"));failedCovers.removeAll(fixtureKeys);try{((BaseAdapter)field(activity,"adapter")).notifyDataSetChanged();((View)field(activity,"emptyView")).setVisibility(items.isEmpty()?View.VISIBLE:View.GONE);invoke(activity,"setControlsVisible",true);}catch(Exception ignored){}});instrumentation.runOnMainSync(activity::finish); }
    }

    @Test public void managementOpensAsDimmedLeftDrawerAtAboutTwoThirdsWidth() throws Exception {
        android.app.Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        Activity activity=instrumentation.startActivitySync(new Intent(context,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        Dialog drawer=null;
        try {
            instrumentation.runOnMainSync(()->invoke(activity,"settings"));Thread.sleep(350);instrumentation.waitForIdleSync();
            drawer=(Dialog)field(activity,"settingsDrawer");assertNotNull("Settings drawer should be tracked",drawer);assertTrue(drawer.isShowing());
            int screenWidth=context.getResources().getDisplayMetrics().widthPixels;
            android.view.WindowManager.LayoutParams attributes=drawer.getWindow().getAttributes();
            assertEquals("Drawer should occupy about two-thirds of the screen",Math.round(screenWidth*.68f),attributes.width);
            assertEquals("Drawer height should follow the available screen",ViewGroup.LayoutParams.MATCH_PARENT,attributes.height);
            assertTrue("Underlying playlist should be dimmed",attributes.dimAmount>=.45f);
            View close=findByDescription(drawer.getWindow().getDecorView(),"关闭资料管理");
            assertNotNull("Drawer must have an accessible close action",close);
            instrumentation.runOnMainSync(close::performClick);instrumentation.waitForIdleSync();
            assertFalse("Close action should dismiss the drawer",drawer.isShowing());
        } finally {
            if(drawer!=null&&drawer.isShowing()){Dialog closingDrawer=drawer;instrumentation.runOnMainSync(closingDrawer::dismiss);}
            instrumentation.runOnMainSync(activity::finish);
        }
    }

    private static Object field(Object target,String name)throws Exception{java.lang.reflect.Field value=target.getClass().getDeclaredField(name);value.setAccessible(true);return value.get(target);}
    private static void invoke(Object target,String name,Object...arguments){try{java.lang.reflect.Method method=target.getClass().getDeclaredMethod(name,arguments.length==0?new Class<?>[0]:new Class<?>[]{boolean.class});method.setAccessible(true);method.invoke(target,arguments);}catch(Exception error){throw new RuntimeException(error);}}
    private static View findByDescription(View view,String description){if(description.equals(view.getContentDescription()))return view;if(view instanceof ViewGroup)for(int i=0;i<((ViewGroup)view).getChildCount();i++){View found=findByDescription(((ViewGroup)view).getChildAt(i),description);if(found!=null)return found;}return null;}
}
