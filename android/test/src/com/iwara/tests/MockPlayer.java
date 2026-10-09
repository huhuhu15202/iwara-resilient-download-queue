package com.iwara.tests;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Parcelable;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.InputStream;
public class MockPlayer extends Activity {
    private static java.lang.ref.WeakReference<MockPlayer> held=new java.lang.ref.WeakReference<>(null);
    public static void finishHeld(){MockPlayer player=held.get();if(player!=null)player.runOnUiThread(()->player.finish());}
    @Override public void onCreate(Bundle bundle) {
        super.onCreate(bundle);
        Intent intent=getIntent(); Uri last=intent.getData();
        try {
            Parcelable[] list=intent.getParcelableArrayExtra("video_list");
            if(list==null)list=new Uri[]{intent.getData()};
            JSONArray uris=new JSONArray(),reads=new JSONArray();
            for(Parcelable value:list){Uri uri=(Uri)value;uris.put(uri.toString());try(InputStream input=getContentResolver().openInputStream(uri)){int n=input.read(new byte[64]);reads.put(n);last=uri;}catch(Exception error){reads.put(-1);}}
            try(InputStream input=getContentResolver().openInputStream(intent.getData())){int n=input.read(new byte[4096]);Log.i("IWARA_MOCK","READ_GRANTED bytes="+n+" title="+intent.getStringExtra("title"));}
            QueueProbeProvider.record(new JSONObject().put("uris",uris).put("reads",reads).put("data",intent.getData().toString())
                .put("names",intent.getStringArrayExtra("video_list.name")==null?new JSONArray():new JSONArray(java.util.Arrays.asList(intent.getStringArrayExtra("video_list.name"))))
                .put("clipCount",intent.getClipData()==null?0:intent.getClipData().getItemCount()).put("explicit",intent.getBooleanExtra("video_list_is_explicit",false))
                .put("returnResult",intent.getBooleanExtra("return_result",false)).put("flags",intent.getFlags()));
        } catch(Exception error) {Log.e("IWARA_MOCK","READ_FAILED",error);}
        String mode=QueueProbeProvider.mode();
        Intent result=new Intent("com.mxtech.intent.result.VIEW").setData("complete".equals(mode)?last:intent.getData())
            .putExtra("end_by","complete".equals(mode)?"playback_completion":"user");
        setResult("error".equals(mode)?RESULT_FIRST_USER:"cancel".equals(mode)?RESULT_CANCELED:RESULT_OK,result);
        if("hold".equals(mode)){held=new java.lang.ref.WeakReference<>(this);return;}
        finish();
    }
}
