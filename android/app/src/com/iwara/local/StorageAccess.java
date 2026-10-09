package com.iwara.local;

import android.content.Context;
import android.content.Intent;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import java.io.IOException;

/** SAF grants are separate from the system's read-media permission. */
public final class StorageAccess {
    private StorageAccess() {}
    public static final class Directory {
        public final boolean read, write;
        Directory(boolean read, boolean write) { this.read=read; this.write=write; }
        public String label() { return !read ? "未授权 / 授权已失效" : write ? "持久读写授权已保存" : "仅可读取，不能删除"; }
    }
    public static final class Deletion {
        public final boolean allowed, systemConfirmation;
        public final String reason;
        public final Uri authorizationTree;
        Deletion(boolean allowed, boolean systemConfirmation, String reason, Uri tree) {
            this.allowed=allowed; this.systemConfirmation=systemConfirmation; this.reason=reason; this.authorizationTree=tree;
        }
    }
    public static Uri treeOf(Uri uri) {
        try { return DocumentsContract.buildTreeDocumentUri(uri.getAuthority(), DocumentsContract.getTreeDocumentId(uri)); }
        catch (IllegalArgumentException error) { return null; }
    }
    public static boolean sameTree(Uri left, Uri right) {
        Uri a=treeOf(left),b=treeOf(right); return a!=null && a.equals(b);
    }
    public static Directory directory(Context context, Uri tree) {
        boolean read=false,write=false;
        for (UriPermission grant:context.getContentResolver().getPersistedUriPermissions()) {
            if (sameTree(grant.getUri(),tree)) { read|=grant.isReadPermission(); write|=grant.isWritePermission(); }
        }
        return new Directory(read,write);
    }
    public static Directory persist(Context context, Uri tree, int resultFlags) throws IOException {
        int offered=resultFlags & (Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if ((offered & Intent.FLAG_GRANT_READ_URI_PERMISSION)==0) throw new IOException("系统没有授予目录读取权限");
        try { context.getContentResolver().takePersistableUriPermission(tree,offered); }
        catch (SecurityException error) { throw new IOException("目录授权无法保存，请在系统文件选择器中重新选择",error); }
        Directory access=directory(context,tree);
        if (!access.read) throw new IOException("目录读取授权未保存，不能将此目录标为已授权");
        return access;
    }
    /** Creates an empty .nomedia marker at the authorized tree root, idempotently. */
    public static boolean ensureNoMedia(Context context, Uri tree) throws IOException {
        if (tree == null) throw new IOException("尚未选择视频文件夹");
        Directory access = directory(context, tree);
        if (!access.read || !access.write) throw new IOException("需要此文件夹的持久读写授权，才能创建 .nomedia");
        Uri root;
        Uri children;
        try {
            String rootId = DocumentsContract.getTreeDocumentId(tree);
            root = DocumentsContract.buildDocumentUriUsingTree(tree, rootId);
            children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, rootId);
        } catch (IllegalArgumentException error) {
            throw new IOException("所选位置不是有效的 SAF 文件夹", error);
        }
        if (hasNoMedia(context, children)) return false;
        Uri marker;
        try {
            marker = DocumentsContract.createDocument(context.getContentResolver(), root,
                    "application/octet-stream", ".nomedia");
        } catch (Exception error) {
            // Another app or a parallel scanner may have created it between the query and create.
            if (hasNoMedia(context, children)) return false;
            throw new IOException("存储提供方拒绝创建 .nomedia", error);
        }
        if (marker == null) {
            if (hasNoMedia(context, children)) return false;
            throw new IOException("存储提供方未能创建 .nomedia");
        }
        String actualName = null;
        try (Cursor row = context.getContentResolver().query(marker,
                new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (row != null && row.moveToFirst()) actualName = row.getString(0);
        } catch (Exception error) {
            try { DocumentsContract.deleteDocument(context.getContentResolver(), marker); }
            catch (Exception ignored) { }
            throw new IOException("无法核验 .nomedia 文件名", error);
        }
        if (!".nomedia".equals(actualName)) {
            try { DocumentsContract.deleteDocument(context.getContentResolver(), marker); }
            catch (Exception ignored) { }
            throw new IOException("存储提供方没有按原名创建 .nomedia，已拒绝保留错误文件");
        }
        return true;
    }
    private static boolean hasNoMedia(Context context, Uri children) throws IOException {
        try (Cursor rows = context.getContentResolver().query(children,
                new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (rows == null) throw new IOException("无法检查所选目录中的 .nomedia");
            while (rows.moveToNext()) if (".nomedia".equals(rows.getString(0))) return true;
            return false;
        } catch (SecurityException error) {
            throw new IOException("读取所选目录失败，请重新授权", error);
        }
    }
    public static Intent picker(Uri initialTree) {
        Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION|Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        if (initialTree!=null) intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI,initialTree);
        return intent;
    }
    public static Deletion deletion(Context context, Uri uri) {
        if (DocumentsContract.isDocumentUri(context,uri)) {
            Uri tree=treeOf(uri);
            Directory access=tree==null?new Directory(false,false):directory(context,tree);
            if (!access.read || !access.write) return new Deletion(false,false,
                access.read?"只有读取权限，请重新授权此视频所在文件夹的写入权限":"目录授权已失效，请重新选择此视频所在文件夹",tree);
            try (Cursor row=context.getContentResolver().query(uri,new String[]{DocumentsContract.Document.COLUMN_FLAGS},null,null,null)) {
                if (row==null) return new Deletion(false,false,"无法确认文件权限，未删除",null);
                if (!row.moveToFirst()) return new Deletion(false,false,"文件已不存在，请重新扫描",null);
                if ((row.getInt(0)&DocumentsContract.Document.FLAG_SUPPORTS_DELETE)==0)
                    return new Deletion(false,false,"当前存储提供方不支持删除；可改用系统视频媒体库或手机文件管理器",null);
                return new Deletion(true,false,"",null);
            } catch (SecurityException error) { return new Deletion(false,false,"文件访问权限已被撤销，请重新授权文件夹",tree); }
            catch (Exception error) { return new Deletion(false,false,"无法检查文件删除权限，未删除",null); }
        }
        if ("media".equals(uri.getAuthority()) && Build.VERSION.SDK_INT>=30) return new Deletion(true,true,"",null);
        return new Deletion(false,false,"当前文件入口不支持安全删除，请使用扫描文件夹授权",null);
    }
}
