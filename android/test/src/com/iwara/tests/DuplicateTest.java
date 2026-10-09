package com.iwara.tests;

import android.app.*;
import android.content.*;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import com.iwara.local.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Creates/deletes ONLY unique tiny fixtures under the emulator's selected folder. */
public final class DuplicateTest extends Instrumentation {
    @Override public void onCreate(Bundle args){super.onCreate(args);start();}
    private void require(boolean yes,String message){if(!yes)throw new AssertionError(message);}
    private void write(Context context,Uri uri,byte[] bytes)throws Exception{try(OutputStream output=context.getContentResolver().openOutputStream(uri,"wt")){output.write(bytes);}}
    @Override public void onStart(){Bundle result=new Bundle();LibraryDb db=null;List<Uri> created=new ArrayList<>();try{
        Context context=getTargetContext();String treeText=context.getSharedPreferences("MainActivity",0).getString("directory","");Uri tree=Uri.parse(treeText);require(context.getContentResolver().getPersistedUriPermissions().stream().anyMatch(grant->grant.getUri().equals(tree)&&grant.isWritePermission()),"Reselect test folder to obtain persisted WRITE permission");
        Uri parent=DocumentsContract.buildDocumentUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree));db=new LibraryDb(context);VideoScanner scanner=new VideoScanner(context,db,new AtomicBoolean());
        byte[] same=new byte[4096],different=new byte[4096];new Random(5432).nextBytes(same);new Random(7654).nextBytes(different);String marker="duplicate-v02-"+UUID.randomUUID();
        for(int i=0;i<3;i++){Uri uri=DocumentsContract.createDocument(context.getContentResolver(),parent,"video/mp4",marker+"-"+i+".mp4");require(uri!=null,"Fixture creation failed");created.add(uri);write(context,uri,i==2?different:same);long[] meta=scanner.metadata(uri);db.discovered(uri.toString(),marker+"-"+i+".mp4",meta[0],meta[1],99);if(i==1)db.hidden(uri.toString(),true);}
        AtomicBoolean cancel=new AtomicBoolean();DuplicateCleaner cleaner=new DuplicateCleaner(context,db,cancel);VideoScanner.Progress progress=(message,refresh)->{};
        DuplicateCleaner.Report found=cleaner.find(progress);final String first=created.get(0).toString(),second=created.get(1).toString();
        DuplicateCleaner.Group group=found.groups.stream().filter(g->g.files.size()==2&&g.files.stream().anyMatch(v->v.uri.equals(first))&&g.files.stream().anyMatch(v->v.uri.equals(second))).findFirst().orElseThrow(()->new AssertionError("Unmatched/hidden duplicate pair not found"));
        require(found.groups.stream().noneMatch(g->g.files.stream().anyMatch(v->v.uri.equals(created.get(2).toString()))),"Same-size different contents marked duplicate");
        List<DuplicateCleaner.Selection> choices=Collections.singletonList(new DuplicateCleaner.Selection(group,first));DuplicateCleaner.Prepared prepared=cleaner.prepare(choices,progress);require(prepared.targets.size()==1,"Keeper included in deletion targets");
        cancel.set(true);require(cleaner.deleteDocuments(prepared,progress).deleted==0,"Cancellation deleted a fixture");cancel.set(false);
        write(context,created.get(1),different);require(cleaner.deleteDocuments(prepared,progress).deleted==0,"Changed-content stale plan deleted a file");
        write(context,created.get(1),same);long[] meta=scanner.metadata(created.get(1));db.discovered(second,marker+"-1.mp4",meta[0],meta[1],99);
        found=cleaner.find(progress);group=found.groups.stream().filter(g->g.files.stream().anyMatch(v->v.uri.equals(first))).findFirst().get();prepared=cleaner.prepare(Collections.singletonList(new DuplicateCleaner.Selection(group,first)),progress);
        DuplicateCleaner.Result deleted=cleaner.deleteDocuments(prepared,progress);require(deleted.deleted==1&&deleted.bytes==4096,"Exactly one duplicate should be deleted");require(scanner.metadata(created.get(0))[0]==4096&&scanner.metadata(created.get(2))[0]==4096,"Keeper or unique file was deleted");require(db.all(false).stream().anyMatch(v->v.uri.equals(first))&&db.all(true).stream().noneMatch(v->v.uri.equals(second)),"Local availability history incorrect");
        result.putString("result","PASS: SAF persisted read/write; unmatched+hidden full-hash duplicates; same-size unique retained; cancellation and content-change reject stale deletion; one confirmed tiny copy deleted, keeper intact");cleanup(created,db);created.clear();finish(Activity.RESULT_OK,result);
    }catch(Throwable error){result.putString("error",android.util.Log.getStackTraceString(error));finish(Activity.RESULT_CANCELED,result);}
    finally{cleanup(created,db);if(db!=null)db.close();}}
    private void cleanup(List<Uri> created,LibraryDb db){for(Uri uri:created){try{DocumentsContract.deleteDocument(getTargetContext().getContentResolver(),uri);}catch(Exception ignored){}if(db!=null)db.getWritableDatabase().delete("local_files","uri=?",new String[]{uri.toString()});}}
}
