package com.iwara.local;

import android.app.*;
import android.graphics.Color;
import android.view.*;
import android.widget.*;
import java.util.*;
import java.util.function.Consumer;

final class DuplicateDialog {
    static void show(Activity activity,DuplicateCleaner.Report report,Consumer<List<DuplicateCleaner.Selection>> clean){
        if(report.groups.isEmpty()){new AlertDialog.Builder(activity).setTitle("重复文件检查").setMessage("没有发现字节完全相同的重复视频。"+(report.issues.isEmpty()?"":"\n有 "+report.issues.size()+" 个文件无法核验；它们不会删除。" )).setPositiveButton("知道了",null).show();return;}
        float density=activity.getResources().getDisplayMetrics().density;Set<DuplicateCleaner.Group> selected=new HashSet<>();Map<DuplicateCleaner.Group,String> keep=new HashMap<>();for(DuplicateCleaner.Group group:report.groups)keep.put(group,group.files.get(0).uri);
        LinearLayout layout=new LinearLayout(activity);layout.setOrientation(LinearLayout.VERTICAL);layout.setPadding(24,12,24,0);TextView hint=new TextView(activity);hint.setText("每组保留一份完整内容相同的文件。点击文件名可更换保留项；只删除手机副本，不影响电脑台账。"+(report.issues.isEmpty()?"":"\n另有 "+report.issues.size()+" 项未能核验，已跳过。"));layout.addView(hint);
        CheckBox all=new CheckBox(activity);all.setText("全选重复组（共 "+report.groups.size()+" 组）");layout.addView(all);ListView list=new ListView(activity);list.setDividerHeight(0);layout.addView(list,new LinearLayout.LayoutParams(-1,(int)Math.min(report.groups.size()*92*density,Math.min(380*density,activity.getResources().getDisplayMetrics().heightPixels*.46))));
        AlertDialog dialog=new AlertDialog.Builder(activity).setTitle("清理手机重复文件").setView(layout).setPositiveButton("选择要清理的组",null).setNegativeButton("取消",null).create();
        Runnable update=()->{int count=0;long bytes=0;for(DuplicateCleaner.Group group:selected){count+=group.files.size()-1;bytes+=group.reclaim();}Button button=dialog.getButton(-1);if(button!=null){button.setEnabled(count>0);button.setText("删除 "+count+" 份 · "+String.format(Locale.CHINA,"%.1f MB",bytes/1048576.0));}};
        BaseAdapter adapter=new BaseAdapter(){public int getCount(){return report.groups.size();}public Object getItem(int p){return report.groups.get(p);}public long getItemId(int p){return p;}public View getView(int p,View old,ViewGroup parent){DuplicateCleaner.Group group=report.groups.get(p);LinearLayout row=new LinearLayout(activity);row.setGravity(Gravity.CENTER_VERTICAL);CheckBox check=new CheckBox(activity);check.setChecked(selected.contains(group));check.setOnCheckedChangeListener((view,on)->{if(on)selected.add(group);else selected.remove(group);update.run();});row.addView(check);TextView label=new TextView(activity);String retained=group.files.stream().filter(file->file.uri.equals(keep.get(group))).findFirst().get().name;label.setText("保留："+retained+"\n"+group.files.size()+" 份相同内容 · 可释放 "+String.format(Locale.CHINA,"%.1f MB",group.reclaim()/1048576.0)+"\n点击更换保留项 ›");label.setTextSize(13);label.setPadding(0,16,0,16);label.setTextColor(Color.rgb(27,43,68));row.addView(label,new LinearLayout.LayoutParams(0,-2,1));label.setOnClickListener(view->{String[] names=new String[group.files.size()];int index=0;for(int i=0;i<names.length;i++){LibraryDb.Video file=group.files.get(i);names[i]=file.name+"\n"+android.net.Uri.decode(file.uri);if(file.uri.equals(keep.get(group)))index=i;}new AlertDialog.Builder(activity).setTitle("选择保留哪一份").setSingleChoiceItems(names,index,(choice,which)->{keep.put(group,group.files.get(which).uri);choice.dismiss();notifyDataSetChanged();}).setNegativeButton("取消",null).show();});return row;}};list.setAdapter(adapter);
        all.setOnCheckedChangeListener((view,on)->{selected.clear();if(on)selected.addAll(report.groups);adapter.notifyDataSetChanged();update.run();});
        dialog.setOnShowListener(ignored->{update.run();dialog.getButton(-1).setOnClickListener(view->{List<DuplicateCleaner.Selection> choices=new ArrayList<>();int count=0;for(DuplicateCleaner.Group group:report.groups)if(selected.contains(group)){choices.add(new DuplicateCleaner.Selection(group,keep.get(group)));count+=group.files.size()-1;}new AlertDialog.Builder(activity).setTitle("确认永久删除 "+count+" 份副本？").setMessage("每组选中的保留项不会删除。其余副本将从手机存储永久删除，不能撤销；电脑上的视频和台账不变。删除前会再次核验完整内容。" ).setNegativeButton("取消",null).setPositiveButton("确认删除",(confirm,which)->{dialog.dismiss();clean.accept(choices);}).show();});});dialog.show();
    }
}
