package com.iwara.local;

import android.content.Context;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.os.ParcelFileDescriptor;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import java.io.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Local byte-identical files only. Discovery never deletes or contacts the PC. */
public final class DuplicateCleaner {
    public static final class Group {
        public final String hash;public final List<LibraryDb.Video> files;
        private Group(String hash,List<LibraryDb.Video> files){this.hash=hash;this.files=Collections.unmodifiableList(files);}
        public long reclaim(){return files.get(0).size*(files.size()-1);}
    }
    public static final class Report {public final List<Group> groups=new ArrayList<>();public final List<String> issues=new ArrayList<>();}
    public static final class Selection {public final Group group;public final String keep;public Selection(Group group,String keep){this.group=group;this.keep=keep;}}
    public static final class Prepared {public final List<Selection> selections=new ArrayList<>();public final List<LibraryDb.Video> targets=new ArrayList<>();public final List<String> issues=new ArrayList<>();}
    public static final class Result {public int deleted;public long bytes;public Uri authorizationTree;public final List<String> issues=new ArrayList<>();}
    private final Context context;private final LibraryDb db;private final AtomicBoolean cancel;private final VideoScanner scanner;
    public DuplicateCleaner(Context context,LibraryDb db,AtomicBoolean cancel){this.context=context.getApplicationContext();this.db=db;this.cancel=cancel;scanner=new VideoScanner(context,db,cancel);}
    private void check()throws InterruptedException{if(cancel.get()||Thread.currentThread().isInterrupted())throw new InterruptedException();}
    private Fingerprints.Source source(LibraryDb.Video video){return ()->{InputStream stream=context.getContentResolver().openInputStream(Uri.parse(video.uri));if(stream==null)throw new IOException("无法读取文件");return stream;};}
    private void unchanged(LibraryDb.Video file)throws Exception{long[] meta=scanner.metadata(Uri.parse(file.uri));if(meta[0]!=file.size||meta[1]!=file.modified)throw new IOException("文件已变化，请重新扫描："+file.name);}
    private String full(LibraryDb.Video file,boolean force)throws Exception{unchanged(file);String hash=force||file.sha256==null?Fingerprints.full(source(file),cancel::get):file.sha256;unchanged(file);return hash;}
    public Report find(VideoScanner.Progress progress)throws Exception{
        Report report=new Report();List<LibraryDb.Video> files=db.all(false);files.addAll(db.all(true));Map<Long,List<LibraryDb.Video>> sizes=new LinkedHashMap<>();
        for(LibraryDb.Video file:files)if(file.size>0)sizes.computeIfAbsent(file.size,key->new ArrayList<>()).add(file);
        int examined=0;Map<String,List<LibraryDb.Video>> hashes=new LinkedHashMap<>();
        for(List<LibraryDb.Video> sized:sizes.values())if(sized.size()>1){
            Map<String,List<LibraryDb.Video>> samples=new LinkedHashMap<>();
            for(LibraryDb.Video file:sized){check();try{unchanged(file);String sample=file.sample==null?Fingerprints.sample(source(file),file.size,cancel::get):file.sample;unchanged(file);file.sample=sample;samples.computeIfAbsent(sample,key->new ArrayList<>()).add(file);}catch(InterruptedException error){throw error;}catch(Exception error){report.issues.add(file.name+"："+error.getMessage());}}
            for(List<LibraryDb.Video> candidates:samples.values())if(candidates.size()>1)for(LibraryDb.Video file:candidates){check();progress.changed("核验重复文件 · "+(++examined)+"："+file.name,false);try{file.sha256=full(file,false);db.fingerprint(file.uri,file.sample,file.sha256);hashes.computeIfAbsent(file.size+":"+file.sha256,key->new ArrayList<>()).add(file);}catch(InterruptedException error){throw error;}catch(Exception error){report.issues.add(file.name+"："+error.getMessage());}}
        }
        for(List<LibraryDb.Video> duplicates:hashes.values())if(duplicates.size()>1){duplicates.sort(Comparator.comparingLong(file->file.modified));report.groups.add(new Group(duplicates.get(0).sha256,duplicates));}
        report.groups.sort((a,b)->Long.compare(b.reclaim(),a.reclaim()));return report;
    }
    private List<LibraryDb.Video> verify(Selection choice)throws Exception{
        check();boolean keeper=false;Set<String> seen=new HashSet<>(),physical=new HashSet<>();List<LibraryDb.Video> targets=new ArrayList<>();
        if(choice.group.files.size()<2)throw new IOException("不是重复组");
        for(LibraryDb.Video file:choice.group.files){if(!seen.add(file.uri))throw new IOException("重复文件 URI");Uri uri=Uri.parse(file.uri);if(DocumentsContract.isDocumentUri(context,uri)&&!physical.add("doc:"+uri.getAuthority()+":"+DocumentsContract.getDocumentId(uri)))throw new IOException("两个入口指向同一个文件，已跳过");try(ParcelFileDescriptor descriptor=context.getContentResolver().openFileDescriptor(uri,"r")){if(descriptor==null)throw new IOException("无法读取文件");StructStat stat=Os.fstat(descriptor.getFileDescriptor());if(OsConstants.S_ISREG(stat.st_mode)&&!physical.add("file:"+stat.st_dev+":"+stat.st_ino))throw new IOException("两个入口指向同一个文件，已跳过");}if(!choice.group.hash.equals(full(file,true)))throw new IOException("内容已变化，已取消此组清理");if(file.uri.equals(choice.keep))keeper=true;else targets.add(file);}
        if(!keeper||targets.isEmpty())throw new IOException("必须保留一份文件");return targets;
    }
    public Prepared prepare(List<Selection> choices,VideoScanner.Progress progress)throws Exception{
        Prepared prepared=new Prepared();Set<String> targets=new HashSet<>();
        for(Selection choice:choices){check();progress.changed("删除前重新核验："+choice.group.files.get(0).name,false);try{List<LibraryDb.Video> group=verify(choice);for(LibraryDb.Video file:group)if(!targets.add(file.uri))throw new IOException("同一文件被重复选中");prepared.targets.addAll(group);prepared.selections.add(choice);}catch(InterruptedException error){throw error;}catch(Exception error){prepared.issues.add(error.getMessage());}}
        return prepared;
    }
    public Result deleteDocuments(Prepared prepared,VideoScanner.Progress progress)throws Exception{
        Result result=new Result();result.issues.addAll(prepared.issues);
        for(Selection choice:prepared.selections){
            if(cancel.get()){result.issues.add("已暂停，未删除的副本仍保留");break;}
            try{
                // Refuse before full-file reads or deletes if the old grant is read-only.
                for(LibraryDb.Video file:choice.group.files)if(!file.uri.equals(choice.keep)){
                    StorageAccess.Deletion access=StorageAccess.deletion(context,Uri.parse(file.uri));
                    if(!access.allowed||access.systemConfirmation){result.authorizationTree=access.authorizationTree;throw new IOException(file.name+"："+(access.systemConfirmation?"媒体库文件需要系统删除确认":access.reason));}
                }
                // Recheck after the confirmation dialog; stale plans cannot delete changed data.
                List<LibraryDb.Video> targets=verify(choice);LibraryDb.Video kept=choice.group.files.stream().filter(file->file.uri.equals(choice.keep)).findFirst().get();
                for(LibraryDb.Video file:targets){check();unchanged(kept);unchanged(file);Uri uri=Uri.parse(file.uri);if(!DocumentsContract.isDocumentUri(context,uri))throw new IOException("媒体库文件需要系统删除确认");
                    progress.changed("正在删除手机重复副本："+file.name,false);
                    try{if(!DocumentsContract.deleteDocument(context.getContentResolver(),uri))throw new IOException("系统未删除该文件");}catch(SecurityException error){result.authorizationTree=StorageAccess.treeOf(uri);throw new IOException("没有写入授权，请重新选择同一个扫描文件夹",error);}
                    db.removed(file.uri);result.deleted++;result.bytes+=file.size;
                }
            }catch(InterruptedException error){result.issues.add("已暂停，未删除的副本仍保留");break;}catch(Exception error){result.issues.add(error.getMessage());}
        }
        return result;
    }
    public boolean exists(LibraryDb.Video file)throws Exception{
        Uri uri=Uri.parse(file.uri);String column=DocumentsContract.isDocumentUri(context,uri)?DocumentsContract.Document.COLUMN_DOCUMENT_ID:android.provider.MediaStore.Video.Media._ID;
        try(android.database.Cursor rows=context.getContentResolver().query(uri,new String[]{column},null,null,null)){
            if(rows==null)throw new IOException("无法确认文件状态，不能当作已删除");
            return rows.moveToFirst();
        }
    }
}
