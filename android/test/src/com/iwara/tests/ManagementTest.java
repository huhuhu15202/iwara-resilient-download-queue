package com.iwara.tests;

import android.app.*;
import android.content.*;
import android.database.sqlite.SQLiteDatabase;
import android.os.Bundle;
import android.view.View;
import android.widget.*;
import com.iwara.local.*;
import java.util.*;

/** Installed native Activity; fixture rows exist only inside the emulator database. */
public final class ManagementTest extends Instrumentation {
    private final String prefix="v02-management-fixture-";
    @Override public void onCreate(Bundle args){super.onCreate(args);start();}
    private void require(boolean condition,String message){if(!condition)throw new AssertionError(message);}
    private Object field(Object object,String name)throws Exception{java.lang.reflect.Field f=object.getClass().getDeclaredField(name);f.setAccessible(true);return f.get(object);}
    private void field(Object object,String name,Object value)throws Exception{java.lang.reflect.Field f=object.getClass().getDeclaredField(name);f.setAccessible(true);f.set(object,value);}
    private java.lang.reflect.Method method(Object object,String name,Class<?>... args)throws Exception{java.lang.reflect.Method m=object.getClass().getDeclaredMethod(name,args);m.setAccessible(true);return m;}
    @Override public void onStart(){Bundle result=new Bundle();LibraryDb db=null;try{
        Context context=getTargetContext();db=new LibraryDb(context);SQLiteDatabase sql=db.getWritableDatabase();cleanup(sql);require(sql.getVersion()==2,"Schema migration missing");require(db.all(false).size()>=4,"Existing phone library lost during upgrade");
        ConnectionSettings settings=new ConnectionSettings(context);require(settings.presets().length==2,"Fixed connection choices missing");
        SharedPreferences prefs=context.getSharedPreferences("connection",0);Map<String,?> original=new HashMap<>(prefs.getAll());prefs.edit().clear().commit();
        try{require(!settings.token().isEmpty(),"Personal token not built into private APK");require(settings.origin().equals(settings.presets()[0]),"Fresh install does not default to LAN");settings.save(settings.presets()[1],settings.token());require(settings.origin().equals(settings.presets()[1]),"Remote selection not retained");require(!prefs.getString("token","").equals(settings.token()),"Token written unencrypted to prefs");}
        finally{SharedPreferences.Editor restore=prefs.edit().clear();for(Map.Entry<String,?> entry:original.entrySet())if(entry.getValue() instanceof String)restore.putString(entry.getKey(),(String)entry.getValue());restore.commit();}
        long[] downloads={200,300,100},modified={900,800,1000},views={50,20,-1};
        for(int i=0;i<3;i++){String task=prefix+i;ContentValues row=new ContentValues();row.put("task_id",task);row.put("title","Long title 第二行应完整显示 without clipping at larger Android font sizes "+i);row.put("author","Fixture sorting");row.put("tags","[]");row.put("views",views[i]);row.put("download_time",downloads[i]);sql.insertOrThrow("catalogue",null,row);db.discovered("content://com.iwara.fixture/"+task,task+".mp4",40+i,modified[i],99);sql.execSQL("UPDATE local_files SET task_id=?,match_status='matched' WHERE uri=?",new Object[]{task,"content://com.iwara.fixture/"+task});}
        Activity activity=startActivitySync(new Intent(Intent.ACTION_MAIN).setClassName("com.iwara.local","com.iwara.local.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));waitForIdleSync();
        field(activity,"author","Fixture sorting");java.lang.reflect.Method refresh=method(activity,"refresh",boolean.class),filtered=method(activity,"filtered"),status=method(activity,"status",String.class);
        runOnMainSync(()->{try{refresh.invoke(activity,false);}catch(Exception error){throw new RuntimeException(error);}});waitForIdleSync();
        List<?> sorted=(List<?>)filtered.invoke(activity);require(((LibraryDb.Video)sorted.get(0)).taskId.equals(prefix+1),"Recent uses phone modified time instead of PC completion");require(((LibraryDb.Video)sorted.get(2)).taskId.equals(prefix+2),"Download order incorrect");
        field(activity,"sort","播放量（高到低）");sorted=(List<?>)filtered.invoke(activity);require(((LibraryDb.Video)sorted.get(0)).views==50&&((LibraryDb.Video)sorted.get(2)).views==-1,"Descending views sort failed");
        field(activity,"sort","播放量（低到高）");sorted=(List<?>)filtered.invoke(activity);require(((LibraryDb.Video)sorted.get(0)).views==20&&((LibraryDb.Video)sorted.get(2)).views==-1,"Unknown views must sort last");field(activity,"sort","最近下载");
        GridView grid=(GridView)field(activity,"grid");int top=grid.getTop();View first=grid.getChildAt(0);int offset=first.getTop();field(activity,"busy",true);sql.execSQL("UPDATE catalogue SET download_time=400 WHERE task_id=?",new Object[]{prefix+0});
        for(int i=0;i<20;i++){final int count=i;runOnMainSync(()->{try{status.invoke(activity,"正在同步 "+count+" / 20");refresh.invoke(activity,true);}catch(Exception error){throw new RuntimeException(error);}});waitForIdleSync();require(grid.getTop()==top&&grid.getChildAt(0)==first&&first.getTop()==offset,"Sync rebuilt/repositioned list");}
        TextView overlay=(TextView)field(activity,"state");require(overlay.getParent() instanceof FrameLayout,"Status is in list flow instead of overlay");
        field(activity,"busy",false);runOnMainSync(()->{try{refresh.invoke(activity,true);}catch(Exception error){throw new RuntimeException(error);}});waitForIdleSync();require(((LibraryDb.Video)grid.getAdapter().getItem(0)).taskId.equals(prefix+0),"Completed sync did not apply updated PC download sorting");require(grid.getFirstVisiblePosition()==0,"Completed sync moved the top viewport away from latest items");
        for(int i=0;i<grid.getChildCount();i++){Object card=grid.getChildAt(i).getTag();TextView title=(TextView)field(card,"title"),meta=(TextView)field(card,"meta");require(title.getLayout()!=null&&title.getLayout().getLineCount()==2,"Title must retain two lines");int textBottom=title.getCompoundPaddingTop()+title.getLayout().getLineBottom(1);require(textBottom<=title.getHeight()-title.getCompoundPaddingBottom(),"Second title line clipped");require(title.getBottom()<=meta.getTop(),"Title overlaps author/date");}
        result.putString("result","PASS: v1 migration preserved library; private token default, LAN/remote selection, encrypted prefs; PC-time and view sorting; 20 status updates preserve card nodes/position; two-line title not clipped; fontScale="+activity.getResources().getConfiguration().fontScale);
        cleanup(sql);finish(Activity.RESULT_OK,result);
    }catch(Throwable error){result.putString("error",android.util.Log.getStackTraceString(error));finish(Activity.RESULT_CANCELED,result);}
    finally{if(db!=null){cleanup(db.getWritableDatabase());db.close();}}}
    private void cleanup(SQLiteDatabase sql){sql.delete("local_files","uri LIKE ?",new String[]{"content://com.iwara.fixture/"+prefix+"%"});sql.delete("catalogue","task_id LIKE ?",new String[]{prefix+"%"});}
}
