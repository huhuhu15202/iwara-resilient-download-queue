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

/** Only unique 4 KiB fixtures in the isolated emulator's selected folder. */
public final class StoragePermissionTest extends Instrumentation {
    private boolean restored;
    @Override public void onCreate(Bundle args){super.onCreate(args);restored="restored".equals(args.getString("phase"));start();}
    private void require(boolean yes,String reason){if(!yes)throw new AssertionError(reason);}
    @Override public void onStart(){Bundle result=new Bundle();LibraryDb db=null;List<Uri> created=new ArrayList<>();Context context=getTargetContext();SharedPreferences fixture=context.getSharedPreferences("permission-regression-fixtures",0);
        try{
            String treeText=context.getSharedPreferences("MainActivity",0).getString("directory","");require(!treeText.isEmpty(),"Select test folder first");Uri tree=Uri.parse(treeText);
            StorageAccess.Directory access=StorageAccess.directory(context,tree);require(access.read&&access.write,"Use DocumentsUI to restore persisted READ+WRITE before this phase");
            db=new LibraryDb(context);VideoScanner scanner=new VideoScanner(context,db,new AtomicBoolean());AtomicBoolean cancel=new AtomicBoolean();DuplicateCleaner cleaner=new DuplicateCleaner(context,db,cancel);VideoScanner.Progress progress=(message,refresh)->{};
            if(!restored){
                require(fixture.getString("uris","").isEmpty(),"Old regression fixtures still pending cleanup");
                Uri parent=DocumentsContract.buildDocumentUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree));byte[] bytes=new byte[4096];new Random(314).nextBytes(bytes);String marker="permission-v021-"+UUID.randomUUID();
                for(int i=0;i<2;i++){Uri uri=DocumentsContract.createDocument(context.getContentResolver(),parent,"video/mp4",marker+"-"+i+".mp4");require(uri!=null,"Could not create fixture");created.add(uri);try(OutputStream out=context.getContentResolver().openOutputStream(uri,"wt")){out.write(bytes);}long[] meta=scanner.metadata(uri);db.discovered(uri.toString(),marker+"-"+i+".mp4",meta[0],meta[1],99);}
                fixture.edit().putString("uris",created.get(0)+"\n"+created.get(1)).commit();
            }else for(String value:fixture.getString("uris","").split("\n"))if(!value.isEmpty())created.add(Uri.parse(value));
            require(created.size()==2,"Exactly two regression fixtures are required");final String first=created.get(0).toString(),second=created.get(1).toString();
            DuplicateCleaner.Group group=cleaner.find(progress).groups.stream().filter(g->g.files.size()==2&&g.files.stream().anyMatch(v->v.uri.equals(first))&&g.files.stream().anyMatch(v->v.uri.equals(second))).findFirst().orElseThrow(()->new AssertionError("Fixture duplicate group missing"));
            DuplicateCleaner.Prepared prepared=cleaner.prepare(Collections.singletonList(new DuplicateCleaner.Selection(group,first)),progress);
            require(prepared.targets.size()==1,"Wrong deletion target");
            if(!restored){
                context.getContentResolver().releasePersistableUriPermission(tree,Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                access=StorageAccess.directory(context,tree);require(access.read&&!access.write,"Could not reproduce a persisted read-only grant");
                require(access.label().contains("不能删除"),"Read-only status falsely claims write permission");
                StorageAccess.Deletion blocked=StorageAccess.deletion(context,created.get(1));require(!blocked.allowed&&StorageAccess.sameTree(blocked.authorizationTree,tree),"Missing actionable write-permission blocker");
                DuplicateCleaner.Result deleted=cleaner.deleteDocuments(prepared,progress);require(deleted.deleted==0&&!deleted.issues.isEmpty()&&deleted.authorizationTree!=null,"Read-only deletion was not blocked");
                require(scanner.metadata(created.get(0))[0]==4096&&scanner.metadata(created.get(1))[0]==4096,"Read-only flow deleted a fixture");
                require(StorageAccess.deletion(context,Uri.parse("content://media/external/video/media/1")).systemConfirmation,"MediaStore flow must use a system confirmation");
                result.putString("result","PASS: reproduced persisted READ-only upgrade; both 4KiB files retained; delete denied with the exact reauthorization tree; MediaStore requires system consent. Next reauthorize the SAME folder using the app UI, then run restored phase.");
            }else{
                require(StorageAccess.deletion(context,created.get(1)).allowed,"Write grant was not recognized after reauthorization");
                DuplicateCleaner.Result deleted=cleaner.deleteDocuments(prepared,progress);require(deleted.deleted==1&&deleted.bytes==4096,"Exactly one selected fixture must be deleted");
                require(scanner.metadata(created.get(0))[0]==4096,"Keeper was deleted");
                require(!StorageAccess.sameTree(tree,DocumentsContract.buildTreeDocumentUri(tree.getAuthority(),DocumentsContract.getTreeDocumentId(tree)+"other")),"Different folder accepted as the required tree");
                result.putString("result","PASS: same-folder UI reauthorization persisted across app restart; confirmed tiny duplicate deleted; keeper retained; different folder rejected; scan scope unchanged.");
                cleanup(context,created,db);fixture.edit().clear().commit();created.clear();
            }
            finish(Activity.RESULT_OK,result);
        }catch(Throwable error){result.putString("error",android.util.Log.getStackTraceString(error));finish(Activity.RESULT_CANCELED,result);}
        finally{if(restored&&db!=null)cleanup(context,created,db);if(db!=null)db.close();}
    }
    private void cleanup(Context context,List<Uri> created,LibraryDb db){for(Uri uri:created){try{DocumentsContract.deleteDocument(context.getContentResolver(),uri);}catch(Exception ignored){}db.getWritableDatabase().delete("local_files","uri=?",new String[]{uri.toString()});}}
}
