package com.iwara.local;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.content.res.ColorStateList;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.LruCache;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.GestureDetector;
import android.view.MotionEvent;
import android.view.Window;
import android.widget.*;
import android.animation.ValueAnimator;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

public final class MainActivity extends Activity {
    private static final int BLUE = Color.rgb(37,99,235), INK = Color.rgb(27,43,68), MUTED = Color.rgb(107,125,148), BG = Color.rgb(245,247,251);
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private final ExecutorService covers = Executors.newFixedThreadPool(2);
    private final AtomicBoolean cancelled = new AtomicBoolean();
    private final LruCache<String,Bitmap> images = new LruCache<String,Bitmap>(16 * 1024 * 1024) { @Override protected int sizeOf(String key, Bitmap bitmap) { return bitmap.getAllocationByteCount(); } };
    private final Set<String> loadingCovers = Collections.synchronizedSet(new HashSet<>());
    private final Set<String> failedCovers = Collections.synchronizedSet(new HashSet<>());
    private final ArrayList<LibraryDb.Video> items = new ArrayList<>();
    private LibraryDb db; private ConnectionSettings connection; private Cards adapter; private GridView grid;
    private TextView state, counter, filterButton, sourceMenuButton; private EditText search;
    private View emptyView, randomFab; private LinearLayout activeFilters;
    private LinearLayout controlsPanel;
    private TextView emptyHeading, emptyHint; private Button emptyAction;
    private LinearLayout sourceSwitch; private Button[] sourceButtons;
    private NavItem libraryNav, randomNav; private GlassSurface navGlass;
    private String author = "", tag = "", sort = "最近下载", query = "";
    private String sourceFilter = "all";
    private String authorScope = "";
    private boolean showHidden, busy, randomOrder, destroyed; private final ArrayList<LibraryDb.Video> pendingMediaDelete=new ArrayList<>();
    private ArrayList<String> restoredBatch;
    private Uri pendingAuthorizationTree;
    private int columns = 2;
    private GestureDetector navigationGesture;
    private boolean navigationSwipeStartedInGrid;
    private boolean navigationSwipeTriggered;
    private boolean controlsVisible = true;
    private int lastGridFirst = -1, lastGridTop;
    private int accumulatedUpScroll, accumulatedDownScroll;
    private ValueAnimator controlsAnimator;
    private int controlsAnimationGeneration;
    private Dialog settingsDrawer;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved); db = new LibraryDb(getApplicationContext()); connection = new ConnectionSettings(this);
        authorScope = getIntent().getStringExtra("author_scope");
        if (authorScope == null) authorScope = "";
        if (!authorScope.isEmpty()) author = authorScope;
        if (saved != null) { author = saved.getString("author", ""); tag = saved.getString("tag", ""); sort = saved.getString("sort", "最近下载"); query = saved.getString("query", ""); sourceFilter=saved.getString("source_filter","all"); showHidden = saved.getBoolean("hidden");randomOrder=saved.getBoolean("random");restoredBatch=saved.getStringArrayList("batch");String pending=saved.getString("authorization_tree","");if(!pending.isEmpty())pendingAuthorizationTree=Uri.parse(pending); }
        else sourceFilter=getPreferences(MODE_PRIVATE).getString("source_filter","all");
        if(!Arrays.asList("all","iwara","han1").contains(sourceFilter))sourceFilter="all";
        int availableWidthDp = getResources().getConfiguration().screenWidthDp;
        columns = availableWidthDp >= 900 ? 4 : availableWidthDp >= 600 ? 3 : 2;
        FrameLayout screen=new FrameLayout(this);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackground(new GradientDrawable(GradientDrawable.Orientation.TL_BR,new int[]{0xFFF0F5FF,0xFFF8FAFD,0xFFF2F6FA})); root.setPadding(dp(16),0,dp(16),0);
        screen.addView(root,new FrameLayout.LayoutParams(-1,-1));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR|View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        LinearLayout top = row();
        ImageView logo = new ImageView(this);logo.setImageDrawable(icon(authorScope.isEmpty()?"play":"back",authorScope.isEmpty()?Color.WHITE:BLUE));logo.setPadding(dp(9),dp(9),dp(9),dp(9));logo.setBackground(authorScope.isEmpty()?shape(BLUE,14):ripple(0xFFEAF1FF,22));logo.setContentDescription(authorScope.isEmpty()?"Iwara 本地库":"返回播放页");
        top.addView(logo,new LinearLayout.LayoutParams(dp(48),dp(48)));
        if (!authorScope.isEmpty()) logo.setOnClickListener(view -> finish());
        LinearLayout searchBar=row();searchBar.setBackground(glassStyle(24));searchBar.setElevation(dp(1));searchBar.setPadding(dp(14),0,dp(6),0);ImageView searchIcon=new ImageView(this);searchIcon.setImageDrawable(icon("search",MUTED));searchBar.addView(searchIcon,new LinearLayout.LayoutParams(dp(22),dp(22)));
        search = new EditText(this); search.setSingleLine(); search.setTextSize(14);search.setTextColor(INK);search.setHintTextColor(MUTED);search.setHint(authorScope.isEmpty()?"搜索标题、作者、标签":"搜索这位作者的视频");search.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH);search.setOnEditorActionListener((view,action,event)->{if(action!=android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH)return false;ui.removeCallbacks(searchRefresh);searchRefresh.run();((android.view.inputmethod.InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(search.getWindowToken(),0);search.clearFocus();return true;}); search.setText(query); search.setPadding(dp(9),0,dp(8),0);search.setBackgroundColor(Color.TRANSPARENT);searchBar.addView(search,new LinearLayout.LayoutParams(0,dp(48),1));LinearLayout.LayoutParams searchLayout=new LinearLayout.LayoutParams(0,dp(52),1);searchLayout.setMargins(dp(10),0,0,0);top.addView(searchBar,searchLayout);
        LinearLayout.LayoutParams topLayout=new LinearLayout.LayoutParams(-1,dp(60));topLayout.setMargins(0,dp(4),0,dp(8));root.addView(top,topLayout);

        controlsPanel=new LinearLayout(this);controlsPanel.setOrientation(LinearLayout.VERTICAL);controlsPanel.setClipChildren(false);controlsPanel.setClipToPadding(false);
        sourceSwitch=row();sourceSwitch.setPadding(dp(12),0,dp(5),0);sourceSwitch.setBackground(glassStyle(22));
        sourceMenuButton=label("",13,BLUE);sourceMenuButton.setTypeface(null,Typeface.BOLD);sourceMenuButton.setGravity(Gravity.CENTER_VERTICAL);sourceMenuButton.setSingleLine();sourceMenuButton.setPadding(0,0,dp(8),0);sourceMenuButton.setContentDescription("选择视频来源");sourceMenuButton.setOnClickListener(this::showSourceMenu);sourceSwitch.addView(sourceMenuButton,new LinearLayout.LayoutParams(dp(128),dp(44)));
        counter=label("",12,MUTED);counter.setGravity(Gravity.CENTER_VERTICAL);counter.setSingleLine();counter.setEllipsize(android.text.TextUtils.TruncateAt.END);sourceSwitch.addView(counter,new LinearLayout.LayoutParams(0,dp(44),1));
        filterButton=button("筛选");filterButton.setCompoundDrawablesRelativeWithIntrinsicBounds(icon("filter",BLUE),null,null,null);filterButton.setCompoundDrawablePadding(dp(4));filterButton.setOnClickListener(view -> filters());sourceSwitch.addView(filterButton,new LinearLayout.LayoutParams(dp(88),dp(40)));
        sourceButtons=new Button[3];String[] sourceKeys={"all","iwara","han1"},sourceLabels={"全部","Iwara","Han1"};for(int i=0;i<sourceKeys.length;i++){final String key=sourceKeys[i];Button sourceButton=button(sourceLabels[i]);sourceButton.setTextSize(12);sourceButton.setOnClickListener(view->selectSource(key));sourceButtons[i]=sourceButton;}
        controlsPanel.addView(sourceSwitch,new LinearLayout.LayoutParams(-1,dp(50)));
        activeFilters=row();LinearLayout.LayoutParams chipsLayout=new LinearLayout.LayoutParams(-1,-2);chipsLayout.setMargins(0,dp(2),0,0);controlsPanel.addView(activeFilters,chipsLayout);updateSourceButtons();
        LinearLayout.LayoutParams controlsLayout=new LinearLayout.LayoutParams(-1,-2);controlsLayout.setMargins(0,0,0,dp(8));root.addView(controlsPanel,controlsLayout);
        grid = new GridView(this); grid.setNumColumns(columns); grid.setHorizontalSpacing(dp(12)); grid.setVerticalSpacing(dp(12)); grid.setStretchMode(GridView.STRETCH_COLUMN_WIDTH); grid.setClipToPadding(false); grid.setPadding(0,0,0,dp(160));
        adapter = new Cards(); grid.setAdapter(adapter); grid.setOnItemClickListener((parent,view,position,id) -> openVideo(items.get(position)));
        grid.setOnItemLongClickListener((parent,view,position,id) -> { videoActions(items.get(position)); return true; });
        grid.setOnScrollListener(new AbsListView.OnScrollListener() {
            @Override public void onScrollStateChanged(AbsListView view,int scrollState) {}
            @Override public void onScroll(AbsListView view,int firstVisible,int visibleCount,int totalCount) {
                if(!authorScope.isEmpty())return;
                View firstChild=grid.getChildAt(0);if(firstChild==null)return;int top=firstChild.getTop();
                if(lastGridFirst>=0){
                    int rowDelta=firstVisible/Math.max(1,columns)-lastGridFirst/Math.max(1,columns);
                    int dy=rowDelta*dp(260)+lastGridTop-top;
                    if(dy>0){accumulatedDownScroll+=dy;accumulatedUpScroll=0;if(accumulatedDownScroll>=dp(24))setControlsVisible(false);}
                    else if(dy<0){accumulatedUpScroll-=dy;accumulatedDownScroll=0;if(accumulatedUpScroll>=dp(72))setControlsVisible(true);}
                }
                if(firstVisible==0&&top>=0){accumulatedUpScroll=accumulatedDownScroll=0;setControlsVisible(true);}
                lastGridFirst=firstVisible;lastGridTop=top;
            }
        });
        navigationGesture = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            @Override public boolean onDown(MotionEvent event) {
                navigationSwipeTriggered = false;
                android.graphics.Rect bounds = new android.graphics.Rect();
                navigationSwipeStartedInGrid = grid.getGlobalVisibleRect(bounds) && bounds.contains(
                        Math.round(event.getRawX()), Math.round(event.getRawY()));
                return true;
            }
            @Override public boolean onFling(MotionEvent first, MotionEvent last, float velocityX, float velocityY) {
                float dx = last.getRawX() - first.getRawX();
                float dy = last.getRawY() - first.getRawY();
                if (!navigationSwipeStartedInGrid || Math.abs(dx) < dp(96) || Math.abs(dx) < Math.abs(dy) * 1.35f
                        || Math.abs(velocityX) < dp(260)) return false;
                if (!randomOrder && dx < 0) randomBatch();
                else if (randomOrder && dx > 0) { randomOrder = false; refresh(false); }
                else return false;
                navigationSwipeTriggered = true;
                return true;
            }
        });
        FrameLayout content=new FrameLayout(this);content.addView(grid,new FrameLayout.LayoutParams(-1,-1));
        LinearLayout empty=new LinearLayout(this);empty.setOrientation(LinearLayout.VERTICAL);empty.setGravity(Gravity.CENTER);empty.setPadding(dp(24),dp(20),dp(24),dp(20));ImageView emptyIcon=new ImageView(this);emptyIcon.setImageDrawable(new UiIcon("folder",0xFF91A6C1,dp(54)));empty.addView(emptyIcon,new LinearLayout.LayoutParams(dp(54),dp(54)));emptyHeading=label("把你的视频带进来",19,INK);emptyHeading.setTypeface(null,Typeface.BOLD);emptyHeading.setPadding(0,dp(18),0,dp(10));empty.addView(emptyHeading);emptyHint=label("",13,MUTED);emptyHint.setGravity(Gravity.CENTER);emptyHint.setLineSpacing(dp(5),1);empty.addView(emptyHint);emptyAction=button("选择视频目录");emptyAction.setOnClickListener(view->{if(!query.isEmpty()||!author.isEmpty()||!tag.isEmpty()||showHidden||!"all".equals(sourceFilter)){query="";author="";tag="";showHidden=false;sourceFilter="all";getPreferences(MODE_PRIVATE).edit().putString("source_filter",sourceFilter).apply();updateSourceButtons();search.setText("");refresh(false);}else chooseDirectory();});LinearLayout.LayoutParams chooseLayout=new LinearLayout.LayoutParams(-1,dp(48));chooseLayout.setMargins(dp(12),dp(24),dp(12),0);empty.addView(emptyAction,chooseLayout);emptyView=empty;content.addView(empty,new FrameLayout.LayoutParams(-1,-1));
        Button play=button("随机播放");play.setTextColor(Color.WHITE);play.setTypeface(null,Typeface.BOLD);play.setBackground(ripple(BLUE,24));play.setCompoundDrawablesRelativeWithIntrinsicBounds(icon("play",Color.WHITE),null,null,null);play.setCompoundDrawablePadding(dp(8));play.setPadding(dp(16),0,dp(18),0);play.setElevation(dp(3));play.setOnClickListener(view->randomPlay());FrameLayout.LayoutParams fab=new FrameLayout.LayoutParams(-2,dp(48),Gravity.BOTTOM|Gravity.RIGHT);fab.setMargins(0,0,dp(4),dp(96));content.addView(play,fab);randomFab=play;root.addView(content,new LinearLayout.LayoutParams(-1,0,1));
        state = label("",11,INK);state.setGravity(Gravity.CENTER_VERTICAL);state.setPadding(dp(12),dp(6),dp(12),dp(6));state.setMaxLines(2);state.setEllipsize(android.text.TextUtils.TruncateAt.END);state.setBackground(glassStyle(18));state.setElevation(dp(8));state.setVisibility(View.GONE);state.setOnClickListener(view->state.setVisibility(View.GONE));FrameLayout.LayoutParams statusBounds=new FrameLayout.LayoutParams(-1,dp(48),Gravity.TOP);statusBounds.setMargins(dp(4),dp(4),dp(4),0);content.addView(state,statusBounds);
        LinearLayout bottom=row();bottom.setPadding(dp(8),dp(6),dp(8),dp(6));libraryNav=new NavItem("library","视频库");randomNav=new NavItem("shuffle","随机推荐");NavItem manage=new NavItem("manage","资料管理");for(NavItem nav:new NavItem[]{libraryNav,randomNav,manage})bottom.addView(nav.root,new LinearLayout.LayoutParams(0,-1,1));libraryNav.root.setOnClickListener(view->{randomOrder=false;refresh(false);});randomNav.root.setOnClickListener(view->randomBatch());manage.root.setOnClickListener(view->settings());
        navGlass=new GlassSurface(this);navGlass.bind(root);navGlass.addView(bottom,new FrameLayout.LayoutParams(-1,-1));FrameLayout.LayoutParams bottomLayout=new FrameLayout.LayoutParams(Math.min(dp(440),getResources().getDisplayMetrics().widthPixels-dp(32)),dp(72),Gravity.BOTTOM|Gravity.CENTER_HORIZONTAL);bottomLayout.setMargins(dp(16),0,dp(16),dp(12));screen.addView(navGlass,bottomLayout);
        screen.setOnApplyWindowInsetsListener((view,insets)->{root.setPadding(dp(16),insets.getSystemWindowInsetTop(),dp(16),insets.getSystemWindowInsetBottom());FrameLayout.LayoutParams bounds=(FrameLayout.LayoutParams)navGlass.getLayoutParams();bounds.bottomMargin=dp(12)+insets.getSystemWindowInsetBottom();navGlass.setLayoutParams(bounds);return insets;});setContentView(screen);screen.requestApplyInsets();
        search.addTextChangedListener(new TextWatcher() { public void beforeTextChanged(CharSequence s,int start,int count,int after) {} public void onTextChanged(CharSequence s,int start,int before,int count) { ui.removeCallbacks(searchRefresh); ui.postDelayed(searchRefresh,220); } public void afterTextChanged(Editable e) {} });
        refresh(false);
        if (!authorScope.isEmpty()) {
            navGlass.setVisibility(View.GONE);
            randomFab.setVisibility(View.GONE);
            filterButton.setVisibility(View.GONE);
            controlsPanel.setVisibility(View.GONE);
            grid.setPadding(0,0,0,dp(20));
            navigationGesture = null;
        }
        if (saved != null) grid.setSelection(saved.getInt("position",0));
    }
    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        if (navigationGesture != null) navigationGesture.onTouchEvent(event);
        if (event.getActionMasked() == MotionEvent.ACTION_UP && navigationSwipeTriggered) {
            navigationSwipeTriggered = false;
            clearGridPressedState(grid);
            return true;
        }
        if (event.getActionMasked() == MotionEvent.ACTION_CANCEL) navigationSwipeTriggered = false;
        return super.dispatchTouchEvent(event);
    }

    private void clearGridPressedState(View view) {
        if (view == null) return;
        view.setPressed(false);
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++)
            clearGridPressedState(((ViewGroup) view).getChildAt(i));
    }

    private final Runnable searchRefresh = () -> { query = search.getText().toString().trim(); randomOrder = false; refresh(false); };
    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); out.putString("author",author); out.putString("tag",tag); out.putString("sort",sort); out.putString("query",query);out.putString("source_filter",sourceFilter); out.putBoolean("hidden",showHidden); out.putInt("position",grid.getFirstVisiblePosition());out.putBoolean("random",randomOrder);if(pendingAuthorizationTree!=null)out.putString("authorization_tree",pendingAuthorizationTree.toString());if(randomOrder){ArrayList<String> batch=new ArrayList<>();for(LibraryDb.Video video:items)batch.add(video.uri);out.putStringArrayList("batch",batch);} }
    @Override protected void onDestroy() { destroyed = true; cancelled.set(true); ui.removeCallbacksAndMessages(null); work.shutdownNow(); covers.shutdownNow(); images.evictAll(); new Thread(() -> {try{while(!work.awaitTermination(10,TimeUnit.SECONDS)){}db.close();}catch(InterruptedException ignored){}} ,"close-library").start(); super.onDestroy(); }
    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private void selectSource(String key){if(sourceFilter.equals(key))return;sourceFilter=key;getPreferences(MODE_PRIVATE).edit().putString("source_filter",sourceFilter).apply();randomOrder=false;updateSourceButtons();refresh(false);}
    private void showSourceMenu(View anchor){PopupMenu menu=new PopupMenu(this,anchor);String[] labels={"全部来源","Iwara","Han1"},keys={"all","iwara","han1"};for(int i=0;i<labels.length;i++){menu.getMenu().add(0,i,i,labels[i]+(sourceFilter.equals(keys[i])?"  ✓":""));}menu.setOnMenuItemClickListener(item->{int index=item.getItemId();if(index>=0&&index<keys.length){selectSource(keys[index]);return true;}return false;});menu.show();}
    private void updateSourceButtons(){if(sourceButtons!=null){String[] keys={"all","iwara","han1"};for(int i=0;i<sourceButtons.length;i++){boolean selected=keys[i].equals(sourceFilter);sourceButtons[i].setTextColor(selected?BLUE:MUTED);sourceButtons[i].setTypeface(null,selected?Typeface.BOLD:Typeface.NORMAL);sourceButtons[i].setBackground(ripple(selected?0xFFE4EEFF:Color.TRANSPARENT,18));sourceButtons[i].setContentDescription((selected?"已选择 ":"选择 ")+new String[]{"全部来源","Iwara","Han1"}[i]);}}
        if(sourceMenuButton!=null){String caption="han1".equals(sourceFilter)?"Han1":"iwara".equals(sourceFilter)?"Iwara":"全部来源";sourceMenuButton.setText("来源 "+caption+"  ⌄");sourceMenuButton.setContentDescription("当前来源："+caption+"，点击切换");}}
    private void setControlsVisible(boolean visible){
        if(controlsPanel==null||controlsVisible==visible)return;controlsVisible=visible;if(controlsAnimator!=null)controlsAnimator.cancel();int generation=++controlsAnimationGeneration;
        if(!visible){int from=controlsPanel.getHeight();if(from<=0){controlsPanel.setVisibility(View.GONE);return;}ViewGroup.LayoutParams params=controlsPanel.getLayoutParams();params.height=from;controlsPanel.setLayoutParams(params);ValueAnimator animator=ValueAnimator.ofInt(from,0);controlsAnimator=animator;animator.setDuration(190);animator.addUpdateListener(value->{int height=(Integer)value.getAnimatedValue();ViewGroup.LayoutParams current=controlsPanel.getLayoutParams();current.height=height;controlsPanel.setLayoutParams(current);controlsPanel.setAlpha(from==0?0f:(float)height/from);controlsPanel.setTranslationY(-dp(8)*(1f-(float)height/from));});animator.addListener(new android.animation.AnimatorListenerAdapter(){@Override public void onAnimationEnd(android.animation.Animator animation){if(generation!=controlsAnimationGeneration||controlsVisible)return;controlsPanel.setVisibility(View.GONE);ViewGroup.LayoutParams current=controlsPanel.getLayoutParams();current.height=ViewGroup.LayoutParams.WRAP_CONTENT;controlsPanel.setLayoutParams(current);controlsPanel.setAlpha(1f);controlsPanel.setTranslationY(0);controlsAnimator=null;}});animator.start();}
        else{controlsPanel.setVisibility(View.VISIBLE);controlsPanel.measure(View.MeasureSpec.makeMeasureSpec(rootWidth(),View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(0,View.MeasureSpec.UNSPECIFIED));int target=Math.max(dp(50),controlsPanel.getMeasuredHeight());ViewGroup.LayoutParams params=controlsPanel.getLayoutParams();params.height=0;controlsPanel.setLayoutParams(params);controlsPanel.setAlpha(0f);ValueAnimator animator=ValueAnimator.ofInt(0,target);controlsAnimator=animator;animator.setDuration(220);animator.addUpdateListener(value->{int height=(Integer)value.getAnimatedValue();ViewGroup.LayoutParams current=controlsPanel.getLayoutParams();current.height=height;controlsPanel.setLayoutParams(current);controlsPanel.setAlpha((float)height/target);controlsPanel.setTranslationY(-dp(8)*(1f-(float)height/target));});animator.addListener(new android.animation.AnimatorListenerAdapter(){@Override public void onAnimationEnd(android.animation.Animator animation){if(generation!=controlsAnimationGeneration||!controlsVisible)return;ViewGroup.LayoutParams current=controlsPanel.getLayoutParams();current.height=ViewGroup.LayoutParams.WRAP_CONTENT;controlsPanel.setLayoutParams(current);controlsPanel.setAlpha(1f);controlsPanel.setTranslationY(0);controlsAnimator=null;}});animator.start();}
    }
    private int rootWidth(){return Math.max(0,getResources().getDisplayMetrics().widthPixels-dp(32));}
    private GradientDrawable shape(int color,int radius) { GradientDrawable drawable = new GradientDrawable(); drawable.setColor(color); drawable.setCornerRadius(dp(radius)); return drawable; }
    private GradientDrawable outline(int color,int radius) {GradientDrawable drawable=shape(color,radius);drawable.setStroke(dp(1),0xFFE3E9F2);return drawable;}
    private GradientDrawable glassStyle(int radius){GradientDrawable drawable=new GradientDrawable(GradientDrawable.Orientation.TL_BR,new int[]{0xF9FFFFFF,0xEAF4F8FF,0xF8FFFFFF});drawable.setCornerRadius(dp(radius));drawable.setStroke(dp(1),0xE5FFFFFF);return drawable;}
    private RippleDrawable ripple(int color,int radius) {return new RippleDrawable(ColorStateList.valueOf(0x183B82F6),shape(color,radius),shape(Color.WHITE,radius));}
    private UiIcon icon(String name,int color){return new UiIcon(name,color,dp(19));}
    private TextView label(String text,int size,int color) { TextView view = new TextView(this); view.setText(text); view.setTextSize(size); view.setTextColor(color); return view; }
    private Button button(String text) { Button button = new Button(this); button.setText(text); button.setTextColor(BLUE); button.setTextSize(13); button.setAllCaps(false); button.setMinHeight(0); button.setMinimumHeight(0);button.setMinWidth(0);button.setMinimumWidth(0);button.setStateListAnimator(null);button.setElevation(0); button.setPadding(dp(10),0,dp(10),0); button.setGravity(Gravity.CENTER); button.setBackground(ripple(0xB3FFFFFF,22));return button; }
    private LinearLayout row() { LinearLayout view = new LinearLayout(this); view.setOrientation(LinearLayout.HORIZONTAL); view.setGravity(Gravity.CENTER_VERTICAL); return view; }
    private final Runnable hideStatus=()->state.setVisibility(View.GONE);
    private void status(String text){if(!destroyed)ui.post(()->{if(!destroyed){state.setText(text);state.setVisibility(View.VISIBLE);ui.removeCallbacks(hideStatus);if(!busy)ui.postDelayed(hideStatus,4500);}});}
    private final class NavItem {final LinearLayout root;final ImageView image;final TextView title;final FrameLayout pill;final String name;NavItem(String name,String caption){this.name=name;root=new LinearLayout(MainActivity.this);root.setOrientation(LinearLayout.VERTICAL);root.setGravity(Gravity.CENTER);root.setBackground(ripple(Color.TRANSPARENT,28));root.setContentDescription(caption);pill=new FrameLayout(MainActivity.this);image=new ImageView(MainActivity.this);image.setImageDrawable(icon(name,MUTED));pill.addView(image,new FrameLayout.LayoutParams(dp(21),dp(21),Gravity.CENTER));root.addView(pill,new LinearLayout.LayoutParams(dp(62),dp(30)));title=label(caption,11,MUTED);title.setGravity(Gravity.CENTER);title.setPadding(0,dp(3),0,0);root.addView(title,new LinearLayout.LayoutParams(-1,-2));}void select(boolean selected){image.setImageDrawable(icon(name,selected?BLUE:MUTED));title.setTextColor(selected?BLUE:MUTED);title.setTypeface(null,selected?Typeface.BOLD:Typeface.NORMAL);pill.setBackground(shape(selected?0xD8E0EAFF:Color.TRANSPARENT,16));}}
    private void toast(String text) { Toast.makeText(this,text,Toast.LENGTH_LONG).show(); }
    private List<LibraryDb.Video> filtered() {
        List<LibraryDb.Video> result = db.all(showHidden); String needle = query.toLowerCase(Locale.ROOT);
        if(!"all".equals(sourceFilter))result.removeIf(video -> !sourceFilter.equals(video.source));
        if (!authorScope.isEmpty()) result.removeIf(video -> !authorScope.equals(video.author));
        result.removeIf(video -> (!author.isEmpty() && !author.equals(video.author)) || (!tag.isEmpty() && !tags(video).contains(tag)) || (!needle.isEmpty() && !(video.displayTitle()+" "+video.author+" "+video.tags).toLowerCase(Locale.ROOT).contains(needle)));
        if ("标题".equals(sort)) result.sort(Comparator.comparing(video -> video.displayTitle().toLowerCase(Locale.ROOT)));
        else if ("文件大小".equals(sort)) result.sort((a,b) -> Long.compare(b.size,a.size));
        else if ("上传日期".equals(sort)) result.sort((a,b) -> Long.compare(b.uploadTime,a.uploadTime));
        else if ("播放量（高到低）".equals(sort)) result.sort((a,b)->Long.compare(b.views,a.views));
        else if ("播放量（低到高）".equals(sort)) result.sort((a,b)->Long.compare(a.views<0?Long.MAX_VALUE:a.views,b.views<0?Long.MAX_VALUE:b.views));
        else result.sort((a,b)->Long.compare(b.downloadTime,a.downloadTime));
        return result;
    }
    private void refresh(boolean keep) {
        if (destroyed) return;
        int position = grid == null ? 0 : grid.getFirstVisiblePosition(); View first = grid == null ? null : grid.getChildAt(0); int offset = first == null ? 0 : first.getTop();
        List<LibraryDb.Video> next = filtered();
        if(randomOrder&&restoredBatch!=null){Map<String,LibraryDb.Video> available=new HashMap<>();for(LibraryDb.Video video:next)available.put(video.uri,video);ArrayList<LibraryDb.Video> stable=new ArrayList<>();for(String uri:restoredBatch)if(available.containsKey(uri))stable.add(available.get(uri));next=stable;restoredBatch=null;}
        else if (randomOrder && keep) { Map<String,LibraryDb.Video> available = new HashMap<>(); for (LibraryDb.Video video : next) available.put(video.uri,video); ArrayList<LibraryDb.Video> stable = new ArrayList<>(); for (LibraryDb.Video old : items) if (available.containsKey(old.uri)) stable.add(available.get(old.uri)); next = stable; }
        else if (randomOrder) { Collections.shuffle(next); if (next.size()>30) next = new ArrayList<>(next.subList(0,30)); }
        if(keep&&!randomOrder&&busy){Map<String,LibraryDb.Video> remaining=new LinkedHashMap<>();for(LibraryDb.Video video:next)remaining.put(video.uri,video);ArrayList<LibraryDb.Video> stable=new ArrayList<>();for(LibraryDb.Video old:items){LibraryDb.Video updated=remaining.remove(old.uri);if(updated!=null)stable.add(updated);}stable.addAll(remaining.values());next=stable;}
        String anchor=position==0&&offset>=0?"":position<items.size()?items.get(position).uri:"";boolean sameOrder=items.size()==next.size();if(sameOrder)for(int i=0;i<items.size();i++)if(!items.get(i).uri.equals(next.get(i).uri)){sameOrder=false;break;}
        items.clear();items.addAll(next);if(keep&&sameOrder)updateVisibleCards();else adapter.notifyDataSetChanged();
        String sourceLabel="han1".equals(sourceFilter)?"Han1":"iwara".equals(sourceFilter)?"Iwara":"全部来源";counter.setText((showHidden?"已隐藏":randomOrder?"随机推荐":sourceLabel)+" · "+items.size()+" 个");
        int filterCount=(author.isEmpty()?0:1)+(tag.isEmpty()?0:1)+(showHidden?1:0);filterButton.setText(filterCount==0?"筛选":"筛选 "+filterCount);
        emptyView.setVisibility(items.isEmpty()?View.VISIBLE:View.GONE);randomFab.setVisibility(items.isEmpty() || !authorScope.isEmpty()?View.GONE:View.VISIBLE);libraryNav.select(!randomOrder);randomNav.select(randomOrder);
        boolean restricted=filterCount>0||!query.isEmpty()||!"all".equals(sourceFilter);emptyHeading.setText(restricted?"没有符合条件的视频":"把你的视频带进来");emptyHint.setText(restricted?"换一个关键词，或清空来源、作者与标签筛选。":"选择已下载的视频目录，再同步电脑台账。\n断网也能浏览，点击即可在 App 内播放。");emptyAction.setText(restricted?"清空筛选":"选择视频目录");
        activeFilters.removeAllViews();if(!author.isEmpty() && authorScope.isEmpty())filterChip("作者 · "+author,()->{author="";refresh(false);});if(!tag.isEmpty())filterChip("标签 · "+tag,()->{tag="";refresh(false);});activeFilters.setVisibility(activeFilters.getChildCount()==0?View.GONE:View.VISIBLE);
        if(keep&&!sameOrder){int destination=0;for(int i=0;i<items.size();i++)if(items.get(i).uri.equals(anchor)){destination=i;break;}grid.setSelectionFromTop(destination,offset);}else if(!keep){accumulatedDownScroll=accumulatedUpScroll=0;lastGridFirst=-1;setControlsVisible(true);grid.setSelection(0);}
        if (navGlass != null) navGlass.refreshBackdrop();
    }
    private void updateVisibleCards(){int first=grid.getFirstVisiblePosition();for(int i=0;i<grid.getChildCount()&&first+i<items.size();i++){View view=grid.getChildAt(i);if(view.getTag() instanceof Card)bindCard((Card)view.getTag(),items.get(first+i));}
    }
    private void filterChip(String caption,Runnable clear){Button chip=button(caption+" ×");chip.setTextSize(11);chip.setSingleLine();chip.setEllipsize(android.text.TextUtils.TruncateAt.END);chip.setBackground(ripple(0xFFEAF1FF,12));chip.setOnClickListener(view->clear.run());LinearLayout.LayoutParams layout=new LinearLayout.LayoutParams(0,dp(44),1);layout.setMargins(0,0,dp(6),dp(8));activeFilters.addView(chip,layout);}
    private List<String> tags(LibraryDb.Video video) { List<String> result = new ArrayList<>(); try { JSONArray array = new JSONArray(video.tags == null ? "[]" : video.tags); for (int i=0;i<array.length();i++) result.add(array.optString(i)); } catch (Exception ignored) {} return result; }
    private void randomBatch() { randomOrder=true; refresh(false); status("已从当前筛选结果随机选出最多 30 个视频。"); }
    private void randomPlay() {
        ArrayList<LibraryDb.Video> queue = new ArrayList<>(items);
        if (queue.isEmpty()) { toast("当前列表中没有可播放视频"); return; }
        Collections.shuffle(queue);
        launchQueue(queue, queue.get(0));
    }
    private void filters() {
        List<LibraryDb.Video> videos = db.all(showHidden); if(!"all".equals(sourceFilter))videos.removeIf(video->!sourceFilter.equals(video.source));TreeSet<String> authors = new TreeSet<>(), allTags = new TreeSet<>();
        for (LibraryDb.Video video : videos) { if (video.author != null && !video.author.isEmpty()) authors.add(video.author); allTags.addAll(tags(video)); }
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); layout.setPadding(dp(20),dp(8),dp(20),dp(8));
        Spinner authorSelect = spinner(layout,"作者",authors,author); Spinner tagSelect = spinner(layout,"标签",allTags,tag);
        Spinner sortSelect = new Spinner(this); String[] options={"最近下载","上传日期","标题","文件大小","播放量（高到低）","播放量（低到高）"}; sortSelect.setAdapter(new ArrayAdapter<>(this,android.R.layout.simple_spinner_dropdown_item,options)); sortSelect.setSelection(Arrays.asList(options).indexOf(sort)); layout.addView(label("排序",13,MUTED)); layout.addView(sortSelect,new LinearLayout.LayoutParams(-1,dp(48)));
        CheckBox hidden = new CheckBox(this); hidden.setText("查看已隐藏视频"); hidden.setChecked(showHidden); layout.addView(hidden);
        ScrollView scroll=new ScrollView(this);scroll.addView(layout);AlertDialog dialog=new AlertDialog.Builder(this).setTitle("筛选本地视频").setView(scroll).setPositiveButton("应用",(whichDialog,which) -> { author=authorSelect.getSelectedItemPosition()==0?"":authorSelect.getSelectedItem().toString(); tag=tagSelect.getSelectedItemPosition()==0?"":tagSelect.getSelectedItem().toString(); sort=sortSelect.getSelectedItem().toString(); showHidden=hidden.isChecked(); refresh(false); }).setNeutralButton("清空",(whichDialog,which) -> { author="";tag="";showHidden=false;sort="最近下载";refresh(false); }).setNegativeButton("取消",null).create();dialog.show();roundDialog(dialog);
    }
    private Spinner spinner(LinearLayout layout,String caption,Collection<String> values,String selected) { layout.addView(label(caption,13,MUTED)); List<String> options=new ArrayList<>();options.add("全部"+caption);options.addAll(values); Spinner spinner=new Spinner(this);spinner.setAdapter(new ArrayAdapter<>(this,android.R.layout.simple_spinner_dropdown_item,options));spinner.setSelection(Math.max(0,options.indexOf(selected)));layout.addView(spinner,new LinearLayout.LayoutParams(-1,dp(48)));return spinner; }
    private void openVideo(LibraryDb.Video video) {
        launchQueue(new ArrayList<>(items), video);
    }
    private void launchQueue(List<LibraryDb.Video> queue, LibraryDb.Video selected) {
        try { PlaybackService.open(this, queue, selected.uri); }
        catch (Exception error) { toast("无法建立播放队列：" + safeError(error)); }
    }
    private void videoActions(LibraryDb.Video video) {
        String action=showHidden?"恢复显示":"从列表隐藏";
        new AlertDialog.Builder(this).setTitle(video.displayTitle()).setItems(new String[]{"播放视频",action,"查看资料"},(dialog,which) -> { if(which==0)openVideo(video);else if(which==1){db.hidden(video.uri,!showHidden);refresh(true);}else new AlertDialog.Builder(this).setTitle("视频资料").setMessage("作者："+(video.author==null?"未匹配":video.author)+"\n标签："+String.join(" · ",tags(video))+"\n大小："+String.format(Locale.ROOT,"%.1f MB",video.size/1048576.0)+"\n匹配："+video.status+"\n文件："+video.name+"\nSHA-256："+(video.sha256==null?"待核验":video.sha256)).setPositiveButton("关闭",null).show(); }).show();
    }
    private void settings() {
        LinearLayout content=new LinearLayout(this);content.setOrientation(LinearLayout.VERTICAL);content.setPadding(dp(16),dp(10),dp(16),dp(18));GradientDrawable drawerBackground=new GradientDrawable(GradientDrawable.Orientation.TL_BR,new int[]{0xFFF5F8FF,0xFFEDF3FD});drawerBackground.setCornerRadii(new float[]{0,0,dp(28),dp(28),dp(28),dp(28),0,0});content.setBackground(drawerBackground);
        LinearLayout heading=row();TextView title=label("资料管理",20,INK);title.setTypeface(null,Typeface.BOLD);heading.addView(title,new LinearLayout.LayoutParams(0,dp(48),1));Button close=button("");close.setCompoundDrawablesRelativeWithIntrinsicBounds(icon("close",MUTED),null,null,null);close.setContentDescription("关闭资料管理");heading.addView(close,new LinearLayout.LayoutParams(dp(44),dp(44)));content.addView(heading);
        int[] stats=db.catalogueStats();TextView summary=label("电脑台账 "+stats[0]+" 条 · 指纹已就绪 "+stats[1]+" 条\n视频与资料保存在本机，播放不需要连接电脑。",12,MUTED);summary.setLineSpacing(dp(4),1);summary.setPadding(dp(12),dp(10),dp(12),dp(10));summary.setBackground(shape(BG,12));content.addView(summary);
        LinearLayout options=new LinearLayout(this);options.setOrientation(LinearLayout.VERTICAL);
        Dialog dialog=new Dialog(this,android.R.style.Theme_Material_Light_NoActionBar);settingsDrawer=dialog;dialog.setOnDismissListener(ignored->{if(settingsDrawer==dialog)settingsDrawer=null;});dialog.setContentView(content);dialog.setCancelable(true);dialog.setCanceledOnTouchOutside(true);close.setOnClickListener(view->dialog.dismiss());
        managementAction(options,"link","电脑服务连接",connection.origin(),()->{dialog.dismiss();connectionDialog();});
        managementAction(options,"sync","同步电脑资料","更新台账、作者和标签资料",()->{dialog.dismiss();sync();});
        managementAction(options,"download","随机下载到手机","按当前来源 · 默认 20 个 · 自动分批解包",()->{dialog.dismiss();randomDownloadDialog();});
        String directoryLabel=getPreferences(MODE_PRIVATE).getString("directory_name","已授权的视频目录");
        String scope=getPreferences(MODE_PRIVATE).getString("directory","").isEmpty()?("media".equals(getPreferences(MODE_PRIVATE).getString("scan_scope","tree"))?"当前：系统视频媒体库":"尚未选择目录，点击授权"):"当前："+directoryLabel+"（含子文件夹）";
        managementAction(options,"folder","扫描文件夹",scope,()->{dialog.dismiss();new AlertDialog.Builder(this).setTitle("扫描文件夹").setItems(new String[]{"选择 / 更换视频文件夹","可选：使用系统视频媒体库"},(selection,which)->{if(which==0)chooseDirectory();else{getPreferences(MODE_PRIVATE).edit().remove("directory").remove("directory_name").putString("scan_scope","media").apply();scan();}}).setNegativeButton("取消",null).show();});
        managementAction(options,"folder","文件访问权限",storagePermissionLabel(),()->{dialog.dismiss();storagePermissions();});
        managementAction(options,"library","重新扫描视频","检查当前范围，新文件和改名都会重新识别",()->{dialog.dismiss();scan();});
        managementAction(options,"manage","清理重复文件","完整指纹核验，选择保留项后清理手机副本",()->{dialog.dismiss();findDuplicates();});
        managementAction(options,"import","导入离线台账","无需联网，选择导出的 SQLite 资料文件",()->{dialog.dismiss();Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT);intent.setType("*/*");intent.addCategory(Intent.CATEGORY_OPENABLE);startActivityForResult(intent,12);});
        managementAction(options,"sync","电脑指纹进度","查看后台扫描进展，完成后再次同步",()->{dialog.dismiss();progressStatus();});
        managementAction(options,"pause","暂停当前扫描","已完成的结果会保留，可再次扫描继续",()->{dialog.dismiss();cancelled.set(true);status("正在暂停，已完成的指纹会保留。");});
        ScrollView scroll=new ScrollView(this);scroll.setFillViewport(false);scroll.setClipToPadding(false);scroll.setPadding(0,dp(8),0,dp(8));scroll.addView(options);content.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        content.setOnApplyWindowInsetsListener((view,insets)->{content.setPadding(dp(16),dp(10)+insets.getSystemWindowInsetTop(),dp(16),dp(18)+insets.getSystemWindowInsetBottom());return insets;});
        dialog.show();Window window=dialog.getWindow();window.setBackgroundDrawableResource(android.R.color.transparent);window.setGravity(Gravity.LEFT|Gravity.TOP);window.setLayout(Math.round(getResources().getDisplayMetrics().widthPixels*.68f),-1);window.addFlags(android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND);android.view.WindowManager.LayoutParams attributes=window.getAttributes();attributes.dimAmount=.48f;window.setAttributes(attributes);window.setWindowAnimations(com.iwara.local.R.style.SettingsDrawerAnimation);
    }
    private void managementAction(LinearLayout parent,String iconName,String title,String hint,Runnable action){LinearLayout row=row();row.setPadding(dp(6),dp(5),dp(6),dp(5));row.setBackground(ripple(Color.WHITE,12));ImageView image=new ImageView(this);image.setImageDrawable(icon(iconName,BLUE));image.setPadding(dp(9),dp(9),dp(9),dp(9));image.setBackground(shape(0xFFEAF1FF,12));row.addView(image,new LinearLayout.LayoutParams(dp(38),dp(38)));LinearLayout text=new LinearLayout(this);text.setOrientation(LinearLayout.VERTICAL);text.setPadding(dp(12),0,0,0);TextView caption=label(title,14,INK);caption.setTypeface(null,Typeface.BOLD);text.addView(caption);TextView detail=label(hint,11,MUTED);detail.setSingleLine();detail.setEllipsize(android.text.TextUtils.TruncateAt.END);detail.setPadding(0,dp(4),0,0);text.addView(detail);row.addView(text,new LinearLayout.LayoutParams(0,-2,1));TextView arrow=label("›",23,MUTED);arrow.setGravity(Gravity.CENTER);row.addView(arrow,new LinearLayout.LayoutParams(dp(24),dp(44)));row.setOnClickListener(view->action.run());parent.addView(row,new LinearLayout.LayoutParams(-1,dp(66)));}
    private void connectionDialog(){
        String[] origins=connection.presets();int chosen=!origins[1].isEmpty()&&connection.origin().equals(origins[1])?1:0;
        String lanLabel=origins[0].isEmpty()?"未配置":origins[0];String remoteLabel=origins[1].isEmpty()?"未配置":origins[1];
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("同步连接").setSingleChoiceItems(new String[]{"局域网 · "+lanLabel,"远程 Tailscale · "+remoteLabel},chosen,(selection,which)->{}).setPositiveButton("使用此连接",(selection,which)->{int selected=((AlertDialog)selection).getListView().getCheckedItemPosition();if(origins[selected].isEmpty()){toast("此地址未配置；请在本机 config.json 中填写个人连接地址后重新构建");return;}try{connection.save(origins[selected],connection.token());toast("同步连接已切换");}catch(Exception error){toast("连接设置失败："+safeError(error));}}).setNegativeButton("取消",null).create();dialog.show();roundDialog(dialog);
    }
    private Uri selectedDirectory(){String value=getPreferences(MODE_PRIVATE).getString("directory","");return value.isEmpty()?null:Uri.parse(value);}
    private String storagePermissionLabel(){Uri tree=selectedDirectory();return tree==null?("media".equals(getPreferences(MODE_PRIVATE).getString("scan_scope","tree"))?"系统视频媒体库 · 删除需系统确认":"尚未授权视频文件夹"):StorageAccess.directory(this,tree).label();}
    private void storagePermissions(){
        Uri tree=selectedDirectory();AlertDialog.Builder builder=new AlertDialog.Builder(this).setTitle("文件访问权限").setMessage(storagePermissionLabel()+"\n\n播放权限不等于删除权限。文件夹模式需要系统保存读写授权；只允许访问你选中的文件夹及子目录，不需要整个手机的所有文件权限。\nAndroid 11 及以上请选视频子文件夹，不要选 Download 根目录。授权后不会自动删除文件。")
            .setNegativeButton("关闭",null);
        if(tree==null)builder.setPositiveButton("选择视频文件夹",(dialog,which)->chooseDirectory());
        else builder.setPositiveButton("重新授权此文件夹",(dialog,which)->chooseDirectoryForWrite(tree));
        AlertDialog dialog=builder.create();dialog.show();roundDialog(dialog);
    }
    private void chooseDirectory(){try{startActivityForResult(StorageAccess.picker(selectedDirectory()),11);}catch(Exception error){toast("系统文件选择器无法打开："+safeError(error));}}
    private void chooseDirectoryForWrite(Uri tree){pendingAuthorizationTree=StorageAccess.treeOf(tree);try{startActivityForResult(StorageAccess.picker(pendingAuthorizationTree),14);}catch(Exception error){pendingAuthorizationTree=null;toast("系统文件选择器无法打开："+safeError(error));}}
    private void deletionBlocked(StorageAccess.Deletion access){
        ui.post(()->{if(destroyed)return;AlertDialog.Builder builder=new AlertDialog.Builder(this).setTitle("未删除文件").setMessage(access.reason+"\n\n读取视频不代表有权删除。重新授权后请再次检查重复文件并确认；本次没有自动删除。")
            .setNegativeButton("取消",null);
            if(access.authorizationTree!=null)builder.setPositiveButton("重新授权文件夹",(dialog,which)->chooseDirectoryForWrite(access.authorizationTree));
            else builder.setPositiveButton("查看文件权限",(dialog,which)->storagePermissions());
            AlertDialog dialog=builder.create();dialog.show();roundDialog(dialog);
        });
    }
    private void roundDialog(AlertDialog dialog){Window window=dialog.getWindow();window.setBackgroundDrawable(glassStyle(28));window.setGravity(Gravity.BOTTOM);window.setLayout(getResources().getDisplayMetrics().widthPixels-dp(24),-2);window.setDimAmount(.28f);}
    private void scan() {
        failedCovers.clear();
        String directory=getPreferences(MODE_PRIVATE).getString("directory","");
        if(!directory.isEmpty()&&!StorageAccess.directory(this,Uri.parse(directory)).read){deletionBlocked(new StorageAccess.Deletion(false,false,"扫描文件夹读取授权已失效，请重新授权",Uri.parse(directory)));return;}
        if(directory.isEmpty()) {
            if(!"media".equals(getPreferences(MODE_PRIVATE).getString("scan_scope","tree"))){chooseDirectory();return;}
            String permission=Build.VERSION.SDK_INT>=33?Manifest.permission.READ_MEDIA_VIDEO:Manifest.permission.READ_EXTERNAL_STORAGE;
            boolean partial = Build.VERSION.SDK_INT>=34 && checkSelfPermission("android.permission.READ_MEDIA_VISUAL_USER_SELECTED")==PackageManager.PERMISSION_GRANTED;
            if(checkSelfPermission(permission)!=PackageManager.PERMISSION_GRANTED && !partial) { if(Build.VERSION.SDK_INT>=34)requestPermissions(new String[]{permission,"android.permission.READ_MEDIA_VISUAL_USER_SELECTED"},10);else requestPermissions(new String[]{permission},10);return; }
        }
        runTask(() -> {
            String noMediaStatus = "";
            if (!directory.isEmpty()) {
                try {
                    boolean created = StorageAccess.ensureNoMedia(getApplicationContext(), Uri.parse(directory));
                    noMediaStatus = created ? ".nomedia 已创建，系统图库将忽略此目录及子文件夹"
                            : "已有 .nomedia，系统图库将忽略此目录及子文件夹";
                } catch (Exception error) {
                    noMediaStatus = ".nomedia 未启用（其他媒体应用仍可能显示）：" + safeError(error);
                }
            }
            final String markerStatus = noMediaStatus;
            new VideoScanner(getApplicationContext(),db,cancelled).scan(directory.isEmpty()?null:Uri.parse(directory),(message,refresh) -> {
                String visibleMessage = message;
                if (message.startsWith("扫描完成") && !markerStatus.isEmpty()) visibleMessage += " · " + markerStatus;
                status(visibleMessage);
                if(refresh)ui.post(() -> refresh(true));
            });
        });
    }
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] results) { super.onRequestPermissionsResult(request,permissions,results); if(request==10) { boolean granted=false;for(int result:results)if(result==PackageManager.PERMISSION_GRANTED)granted=true;if(granted)scan();else{toast("可改为选择一个视频目录授权");chooseDirectory();} } }
    @Override protected void onActivityResult(int request,int result,Intent data) {
        super.onActivityResult(request,result,data);
        if(request==13){finishMediaDelete(result==RESULT_OK);return;}
        if(request==14){Uri expected=pendingAuthorizationTree;pendingAuthorizationTree=null;
            if(result!=RESULT_OK||data==null||data.getData()==null){status("已取消文件夹授权，未删除文件。");return;}
            Uri tree=data.getData();if(expected==null||!StorageAccess.sameTree(expected,tree)){toast("请选择原视频所在的同一个文件夹；本次没有更换扫描范围，也没有删除文件。");return;}
            try{StorageAccess.Directory access=StorageAccess.persist(this,tree,data.getFlags());
                if(!access.write){deletionBlocked(new StorageAccess.Deletion(false,false,"系统仍只授予读取权限，当前目录不能删除",tree));return;}
                AlertDialog dialog=new AlertDialog.Builder(this).setTitle("读写授权已保存").setMessage("可重新检查重复文件，再选择需要删除的副本。之前的删除请求不会自动继续。")
                    .setPositiveButton("重新检查重复文件",(selection,which)->findDuplicates()).setNegativeButton("稍后",null).create();dialog.show();roundDialog(dialog);
            }catch(Exception error){toast("目录授权失败："+safeError(error));}return;}
        if(result!=RESULT_OK||data==null||data.getData()==null)return;Uri uri=data.getData();
        if(request==11) {try{StorageAccess.Directory access=StorageAccess.persist(this,uri,data.getFlags());String name="已授权的视频目录";Uri document=android.provider.DocumentsContract.buildDocumentUriUsingTree(uri,android.provider.DocumentsContract.getTreeDocumentId(uri));try(android.database.Cursor row=getContentResolver().query(document,new String[]{android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null)){if(row!=null&&row.moveToFirst()&&row.getString(0)!=null)name=row.getString(0);}getPreferences(MODE_PRIVATE).edit().putString("directory",uri.toString()).putString("directory_name",name).putString("scan_scope","tree").apply();scan();if(!access.write)deletionBlocked(new StorageAccess.Deletion(false,false,"已保存读取授权，可以扫描和播放；系统没有授予写入权限，未能创建 .nomedia，也暂时不能下载到此目录或删除文件",uri));}catch(Exception error){toast("目录授权失败："+safeError(error));}}
        else if(request==12)runTask(() -> {File file=new File(getCacheDir(),"import-"+UUID.randomUUID()+".sqlite");try(InputStream input=getContentResolver().openInputStream(uri)){copy(input,file,64*1024*1024);db.importCatalogue(file);new VideoScanner(getApplicationContext(),db,cancelled).match((message,refresh) -> {status(message);if(refresh)ui.post(() -> refresh(true));});}finally{file.delete();}});
    }
    private void runTask(CheckedTask task) {
        if(busy||!pendingMediaDelete.isEmpty()){toast("已有操作进行中，可在设置里暂停扫描");return;}busy=true;cancelled.set(false);
        work.execute(() -> {try{task.run();}catch(InterruptedException error){status("扫描已暂停，已完成结果保留。");}catch(Exception error){status("操作失败："+safeError(error));}finally{ui.post(() -> {busy=false;refresh(true);ui.removeCallbacks(hideStatus);ui.postDelayed(hideStatus,5000);});}});
    }
    private interface CheckedTask { void run() throws Exception; }
    private String safeError(Exception error) { String message=error.getMessage();return message==null?error.getClass().getSimpleName():message.replaceAll("(?i)(access_token=)[^&\\s]+","$1[隐藏]"); }
    private HttpURLConnection request(String route,String method) throws Exception {
        String token=connection.token();if(token.isEmpty())throw new IllegalArgumentException("请先设置带令牌的电脑服务连接");
        HttpURLConnection request=(HttpURLConnection)new URL(connection.origin()+route).openConnection();request.setRequestMethod(method);request.setConnectTimeout(10000);request.setReadTimeout(30000);request.setInstanceFollowRedirects(false);request.setRequestProperty("x-iwara-access-token",token);
        int status=request.getResponseCode();if(status<200||status>=300){request.disconnect();throw new IOException(status==401?"授权失败，请更新服务连接令牌":status==404?"电脑服务尚未升级，找不到手机同步接口":"同步请求失败 HTTP "+status);}return request;
    }
    private HttpURLConnection postJson(String route,JSONObject body) throws Exception {
        String token=connection.token();if(token.isEmpty())throw new IllegalArgumentException("请先设置带令牌的电脑服务连接");
        HttpURLConnection request=(HttpURLConnection)new URL(connection.origin()+route).openConnection();request.setRequestMethod("POST");request.setConnectTimeout(15000);request.setReadTimeout(60000);request.setDoOutput(true);request.setInstanceFollowRedirects(false);request.setRequestProperty("x-iwara-access-token",token);request.setRequestProperty("content-type","application/json; charset=utf-8");
        byte[] payload=body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);if(payload.length>2*1024*1024){request.disconnect();throw new IOException("随机下载请求过大，请重新同步台账");}
        request.setFixedLengthStreamingMode(payload.length);try(OutputStream output=request.getOutputStream()){output.write(payload);}
        int code=request.getResponseCode();if(code<200||code>=300){String message="HTTP "+code;try(InputStream error=request.getErrorStream()){if(error!=null){ByteArrayOutputStream bytes=new ByteArrayOutputStream();byte[] buffer=new byte[4096];int length;while((length=error.read(buffer))!=-1){if(bytes.size()+length>65536)break;bytes.write(buffer,0,length);}message=new JSONObject(bytes.toString("UTF-8")).optString("error",message);}}catch(Exception ignored){}request.disconnect();throw new IOException(code==401?"授权失败，请检查电脑服务令牌":message);}
        return request;
    }
    private void randomDownloadDialog(){
        try{if(connection.token().isEmpty()){connectionDialog();return;}}catch(Exception error){connectionDialog();return;}
        EditText quantity=new EditText(this);quantity.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);quantity.setSingleLine(true);quantity.setText(String.valueOf(getPreferences(MODE_PRIVATE).getInt("random_download_count",20)));quantity.setSelection(quantity.length());quantity.setHint("1–100");quantity.setPadding(dp(14),dp(8),dp(14),dp(8));quantity.setBackground(outline(Color.WHITE,14));
        String selected="han1".equals(sourceFilter)?"Han1":"iwara".equals(sourceFilter)?"Iwara":"全部来源";
        LinearLayout form=new LinearLayout(this);form.setOrientation(LinearLayout.VERTICAL);form.setPadding(dp(22),dp(8),dp(22),dp(8));TextView detail=label("从“"+selected+"”来源中随机抽取；手机已存在的匹配视频会自动跳过。\n每个传输包控制在约 4.5 GB 内，收到后校验、自动解包并写入当前视频目录。",13,MUTED);detail.setLineSpacing(dp(4),1);detail.setPadding(0,0,0,dp(14));form.addView(detail);form.addView(quantity,new LinearLayout.LayoutParams(-1,dp(52)));
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("随机下载到手机").setView(form).setNegativeButton("取消",null).setPositiveButton("开始下载",null).create();dialog.setOnShowListener(ignored->dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view->{String text=quantity.getText().toString().trim();int count;try{count=Integer.parseInt(text);}catch(Exception error){quantity.setError("请输入 1–100 的数量");return;}if(count<1||count>100){quantity.setError("数量范围为 1–100");return;}getPreferences(MODE_PRIVATE).edit().putInt("random_download_count",count).apply();dialog.dismiss();startRandomDownload(count);}));dialog.show();roundDialog(dialog);
    }
    private void startRandomDownload(int count){
        Uri tree=selectedDirectory();boolean mediaMode=tree==null&&"media".equals(getPreferences(MODE_PRIVATE).getString("scan_scope","tree"));
        if(tree!=null){StorageAccess.Directory access=StorageAccess.directory(this,tree);if(!access.read||!access.write){deletionBlocked(new StorageAccess.Deletion(false,false,access.read?"当前视频目录只有读取权限，无法保存下载视频":"当前视频目录授权已失效，请重新选择目录",tree));return;}}
        else if(!mediaMode||Build.VERSION.SDK_INT<29){toast("请先到资料管理中选择可写的视频文件夹");return;}
        final String source=sourceFilter;
        runTask(()->{
            status("正在从 "+(source.equals("all")?"全部来源":source.equals("han1")?"Han1":"Iwara")+"随机挑选视频…");
            JSONObject requestBody=new JSONObject();requestBody.put("count",count);requestBody.put("source",source);JSONArray excluded=new JSONArray();for(String id:db.downloadedTaskIds())excluded.put(id);requestBody.put("excludeTaskIds",excluded);
            HttpURLConnection planResponse=postJson("/api/mobile/random-download",requestBody);JSONObject plan;
            try(InputStream input=planResponse.getInputStream()){plan=new JSONObject(readSmallResponse(input,4*1024*1024));}finally{planResponse.disconnect();}
            JSONArray batches=plan.optJSONArray("batches");int selected=plan.optInt("selectedCount");if(selected<=0||selected>100||batches==null||batches.length()==0){throw new IOException("当前来源没有可下载的新视频"+(plan.optInt("oversizeSkipped")>0?"；超出单包 4.5 GB 的单个视频已跳过":""));}
            int plannedFiles=0;for(int i=0;i<batches.length();i++){JSONObject batch=batches.getJSONObject(i);int countInBatch=batch.optInt("fileCount",-1);long mediaBytes=batch.optLong("totalBytes",-1);if(countInBatch<1||countInBatch>100||mediaBytes<=0||mediaBytes>4_500_000_000L)throw new IOException("电脑返回的分包清单无效");plannedFiles+=countInBatch;}if(plannedFiles!=selected)throw new IOException("电脑返回的分包数量与随机清单不一致");
            int completed=0;long totalMedia=0;for(int i=0;i<batches.length();i++){final int batchNumber=i+1;final int batchCount=batches.length();JSONObject batch=batches.getJSONObject(i);String route=batch.optString("url","");if(!route.matches("/batch-download/[a-f0-9]{36}\\.zip"))throw new IOException("电脑返回的分包链接无效");long archiveBytes=batch.optLong("archiveBytes",-1);if(archiveBytes<=0||archiveBytes>4_600_000_000L)throw new IOException("电脑返回的分包大小异常");status("随机下载 · 第 "+batchNumber+" / "+batchCount+" 包 · "+batch.optInt("fileCount")+" 个视频 · "+formatBytes(batch.optLong("totalBytes")));
                HttpURLConnection transfer=null;try{transfer=openMobileBatch(route);long responseBytes=transfer.getContentLengthLong();if(responseBytes>=0&&responseBytes!=archiveBytes)throw new IOException("分包长度与电脑清单不一致");long expected=responseBytes>=0?responseBytes:archiveBytes;MobileBatchDownloader receiver=new MobileBatchDownloader(getApplicationContext(),db,cancelled,tree,mediaMode);int added;try(InputStream input=transfer.getInputStream()){added=receiver.receive(input,expected,(received,total,current)->{if(total>0)status("第 "+batchNumber+" / "+batchCount+" 包 · "+(int)Math.min(100,received*100/total)+"% · "+current);});}completed+=added;totalMedia+=batch.optLong("totalBytes");if(added!=batch.optInt("fileCount"))throw new IOException("本包已接收但登记数量与电脑清单不一致");}catch(InterruptedException error){throw error;}catch(Exception error){if(completed>0)throw new IOException("已安全完成并登记 "+completed+" 个视频；剩余分包失败，可重新发起（已入库项目会自动跳过）："+safeError(error),error);throw error;}finally{if(transfer!=null)transfer.disconnect();}
            }
            String extra=plan.optInt("oversizeSkipped")>0?"；跳过 "+plan.optInt("oversizeSkipped")+" 个单文件超过 4.5 GB 的项目":"";if(plan.optInt("unavailableSkipped")>0)extra+="；文件变动/不可用跳过 "+plan.optInt("unavailableSkipped")+" 项";
            status("完成 · 已下载并登记 "+completed+" 个视频 · "+formatBytes(totalMedia)+extra);
        });
    }
    private HttpURLConnection openMobileBatch(String route) throws Exception {
        String token=connection.token();if(token.isEmpty())throw new IllegalArgumentException("请先设置带令牌的电脑服务连接");HttpURLConnection response=(HttpURLConnection)new URL(connection.origin()+route).openConnection();response.setRequestMethod("GET");response.setConnectTimeout(15000);response.setReadTimeout(120000);response.setInstanceFollowRedirects(false);response.setRequestProperty("x-iwara-access-token",token);int code=response.getResponseCode();if(code!=200){response.disconnect();throw new IOException(code==404?"随机分包链接已过期，请重新发起下载":"分包传输失败 HTTP "+code);}String type=response.getContentType();if(type==null||!type.toLowerCase(Locale.ROOT).startsWith("application/zip")){response.disconnect();throw new IOException("电脑返回的不是 ZIP 视频分包");}return response;
    }
    private String readSmallResponse(InputStream input,int limit)throws Exception{ByteArrayOutputStream bytes=new ByteArrayOutputStream();byte[] buffer=new byte[8192];int length;while((length=input.read(buffer))!=-1){if(bytes.size()+length>limit)throw new IOException("电脑返回的分包资料过大");bytes.write(buffer,0,length);}return bytes.toString("UTF-8");}
    private String formatBytes(long bytes){if(bytes<1024*1024)return bytes+" B";if(bytes<1024L*1024*1024)return String.format(Locale.ROOT,"%.1f MB",bytes/1048576.0);return String.format(Locale.ROOT,"%.2f GB",bytes/1073741824.0);}
    private void sync() {
        try { if(connection.token().isEmpty()){connectionDialog();return;} } catch(Exception error){connectionDialog();return;}
        runTask(() -> {
            status("正在检查电脑指纹…");HttpURLConnection start=request("/api/mobile/fingerprints","POST");start.disconnect();
            JSONObject fingerprint=waitForFingerprints();int ready=fingerprint.optInt("ready"),total=fingerprint.optInt("total"),pending=fingerprint.optInt("pending");
            File file=new File(getCacheDir(),"sync-"+UUID.randomUUID()+".sqlite");HttpURLConnection response=request("/api/mobile/catalog.sqlite","GET");
            try(InputStream input=response.getInputStream()){copy(input,file,64*1024*1024);int count=db.importCatalogue(file);status("已同步 "+count+" 条资料，正在按内容指纹匹配手机视频…");new VideoScanner(getApplicationContext(),db,cancelled).match((message,refresh) -> {status(message);if(refresh)ui.post(() -> refresh(true));});}
            finally{response.disconnect();file.delete();}
            status("同步完成 · 电脑指纹 "+ready+"/"+total+(pending>0?" · "+pending+" 个待核验，已匹配可确认项目":"")+"；已刷新手机视频资料");
        });
    }
    private JSONObject waitForFingerprints() throws Exception {
        long deadline=android.os.SystemClock.elapsedRealtime()+30L*60L*1000L;JSONObject latest=new JSONObject();
        while(true){
            if(cancelled.get())throw new InterruptedException("同步已取消");
            HttpURLConnection response=request("/api/mobile/fingerprints","GET");
            try(InputStream input=response.getInputStream()){ByteArrayOutputStream output=new ByteArrayOutputStream();byte[] buffer=new byte[4096];int length;while((length=input.read(buffer))!=-1){if(output.size()>1024*1024)throw new IOException("指纹状态响应过大");output.write(buffer,0,length);}latest=new JSONObject(output.toString("UTF-8"));}
            finally{response.disconnect();}
            int ready=latest.optInt("ready"),total=latest.optInt("total"),pending=latest.optInt("pending");boolean running=latest.optBoolean("running");JSONObject jobs=latest.optJSONObject("jobs");
            int queued=jobs==null?0:jobs.optInt("queued"),active=jobs==null?0:jobs.optInt("running");
            status("电脑指纹核验 "+ready+"/"+total+(running||queued>0||active>0?" · 正在处理":" · 等待同步")+(pending>0?" · 剩余 "+pending:""));
            if(pending==0||(!running&&queued==0&&active==0))return latest;
            if(android.os.SystemClock.elapsedRealtime()>=deadline)return latest;
            Thread.sleep(2000);
        }
    }
    private void copy(InputStream input,File target,long limit) throws Exception {if(input==null)throw new IOException("文件读取失败");try(OutputStream output=new FileOutputStream(target)){byte[] buffer=new byte[65536];long count=0;int length;while((length=input.read(buffer))!=-1){if(cancelled.get())throw new InterruptedException();count+=length;if(count>limit)throw new IOException("资料库超过大小限制");output.write(buffer,0,length);}}}
    private void progressStatus() {runTask(() -> {HttpURLConnection response=request("/api/mobile/fingerprints","GET");try(InputStream input=response.getInputStream()){ByteArrayOutputStream output=new ByteArrayOutputStream();byte[] buffer=new byte[4096];int length;while((length=input.read(buffer))!=-1){if(output.size()>1024*1024)throw new IOException("响应过大");output.write(buffer,0,length);}JSONObject status=new JSONObject(output.toString("UTF-8"));status("电脑指纹 "+status.optInt("ready")+"/"+status.optInt("total")+(status.optBoolean("running")?" · 正在扫描":" · 当前空闲")+"；完成后再次同步即可补齐手机资料。");}finally{response.disconnect();}});}

    private void findDuplicates(){runTask(()->{
        status("正在检查手机重复文件…");DuplicateCleaner.Report report=new DuplicateCleaner(this,db,cancelled).find((message,refresh)->status(message));
        status("检查完成 · "+report.groups.size()+" 组重复文件");ui.post(()->{if(!destroyed)DuplicateDialog.show(this,report,this::deleteDuplicates);});
    });}
    private void deleteDuplicates(List<DuplicateCleaner.Selection> choices){runTask(()->{
        for(DuplicateCleaner.Selection choice:choices)for(LibraryDb.Video file:choice.group.files)if(!file.uri.equals(choice.keep)){
            StorageAccess.Deletion access=StorageAccess.deletion(this,Uri.parse(file.uri));
            if(!access.allowed){status("删除未开始："+access.reason);deletionBlocked(access);return;}
        }
        DuplicateCleaner cleaner=new DuplicateCleaner(this,db,cancelled);DuplicateCleaner.Prepared prepared=cleaner.prepare(choices,(message,refresh)->status(message));
        if(prepared.targets.isEmpty()){status("未删除文件："+(prepared.issues.isEmpty()?"没有选择副本":prepared.issues.get(0)));return;}
        boolean documents=true,media=true;for(LibraryDb.Video file:prepared.targets){Uri uri=Uri.parse(file.uri);documents&=android.provider.DocumentsContract.isDocumentUri(this,uri);media&="media".equals(uri.getAuthority());}
        if(documents){DuplicateCleaner.Result result=cleaner.deleteDocuments(prepared,(message,refresh)->status(message));deletionStatus(result);}
        else if(media&&Build.VERSION.SDK_INT>=30){
            ArrayList<Uri> targets=new ArrayList<>();for(LibraryDb.Video file:prepared.targets)targets.add(Uri.parse(file.uri));
            android.app.PendingIntent confirm=android.provider.MediaStore.createDeleteRequest(getContentResolver(),targets);
            ui.post(()->{if(destroyed)return;pendingMediaDelete.addAll(prepared.targets);try{startIntentSenderForResult(confirm.getIntentSender(),13,null,0,0,0);}catch(Exception error){pendingMediaDelete.clear();status("系统删除确认无法打开："+safeError(error));}});
        }else status("请重新选择视频文件夹并授予写入权限，再清理这些副本。");
    });}
    private void finishMediaDelete(boolean confirmed){
        ArrayList<LibraryDb.Video> targets=new ArrayList<>(pendingMediaDelete);pendingMediaDelete.clear();
        if(!confirmed){status("已取消删除，手机文件保持不变。");return;}if(targets.isEmpty()){scan();return;}
        runTask(()->{DuplicateCleaner cleaner=new DuplicateCleaner(this,db,cancelled);DuplicateCleaner.Result result=new DuplicateCleaner.Result();for(LibraryDb.Video file:targets){try{if(!cleaner.exists(file)){db.removed(file.uri);result.deleted++;result.bytes+=file.size;}else result.issues.add(file.name+"：系统未删除");}catch(Exception error){result.issues.add(file.name+"："+safeError(error));}}deletionStatus(result);});
    }
    private void deletionStatus(DuplicateCleaner.Result result){status("已删除 "+result.deleted+" 份手机副本 · 释放 "+String.format(Locale.CHINA,"%.1f MB",result.bytes/1048576.0)+(result.issues.isEmpty()?"":"；跳过 "+result.issues.size()+" 项："+result.issues.get(0)));
        if(!result.issues.isEmpty())ui.post(()->{if(destroyed)return;AlertDialog.Builder builder=new AlertDialog.Builder(this).setTitle("删除结果 · "+result.deleted+" 份").setMessage(String.join("\n",result.issues.subList(0,Math.min(10,result.issues.size())))+"\n未成功删除的文件仍保留。")
            .setNegativeButton("关闭",null);if(result.authorizationTree!=null)builder.setPositiveButton("重新授权文件夹",(dialog,which)->chooseDirectoryForWrite(result.authorizationTree));AlertDialog dialog=builder.create();dialog.show();roundDialog(dialog);});
    }
    private void bindCard(Card card,LibraryDb.Video video){
        card.title.setText(video.displayTitle());String date=date(video.uploadTime);card.meta.setText((video.author==null||video.author.isEmpty()?"本地视频":video.author)+(date.isEmpty()?"":" · "+date));card.views.setText(video.views<0?(video.size<1048576?String.format(Locale.ROOT,"%.0f KB",video.size/1024.0):String.format(Locale.ROOT,"%.0f MB",video.size/1048576.0)):"▷ "+count(video.views));
        card.match.setText("matched".equals(video.status)?"":"conflict".equals(video.status)?"待确认":"未匹配");card.match.setVisibility("matched".equals(video.status)?View.GONE:View.VISIBLE);
        String creator=video.author==null||video.author.isEmpty()?"本地视频":video.author;
        String playback=video.views<0?"本地文件":"播放量 "+count(video.views);
        card.root.setContentDescription(video.displayTitle()+"，"+creator+(date.isEmpty()?"":"，"+date)+"，"+playback);
        loadCover(card.image,video);
    }

    private final class Cards extends BaseAdapter {
        public int getCount(){return items.size();}public Object getItem(int position){return items.get(position);}public long getItemId(int position){return items.get(position).uri.hashCode();}
        public View getView(int position,View recycled,ViewGroup parent) {
            Card card; if(recycled==null){card=new Card();recycled=card.root;recycled.setTag(card);}else card=(Card)recycled.getTag();
            bindCard(card,items.get(position));return recycled;
        }
    }
    private final class Card {
        final LinearLayout root; final ImageView image; final TextView title,meta,views,match;
        Card(){
            root=new LinearLayout(MainActivity.this);root.setOrientation(LinearLayout.VERTICAL);root.setBackground(glassStyle(22));root.setElevation(dp(1));root.setClipToOutline(true);
            root.setForeground(new RippleDrawable(ColorStateList.valueOf(0x183B82F6),null,shape(Color.WHITE,22)));
            VideoCoverFrame cover=new VideoCoverFrame(MainActivity.this);cover.setBackground(shape(0xFFE9EFF8,18));
            image=new ImageView(MainActivity.this);image.setScaleType(ImageView.ScaleType.CENTER_CROP);cover.addView(image,new FrameLayout.LayoutParams(-1,-1));
            views=label("",11,Color.WHITE);views.setPadding(dp(7),dp(4),dp(7),dp(4));views.setBackground(shape(0x990C1D32,9));
            FrameLayout.LayoutParams badge=new FrameLayout.LayoutParams(-2,-2,Gravity.BOTTOM|Gravity.LEFT);badge.setMargins(dp(8),0,0,dp(8));cover.addView(views,badge);
            match=label("",11,Color.WHITE);match.setBackground(shape(0x990C1D32,9));match.setPadding(dp(6),dp(3),dp(6),dp(3));
            FrameLayout.LayoutParams status=new FrameLayout.LayoutParams(-2,-2,Gravity.TOP|Gravity.RIGHT);status.setMargins(0,dp(8),dp(8),0);cover.addView(match,status);
            root.addView(cover,new LinearLayout.LayoutParams(-1,-2));
            title=label("",14,INK);title.setTypeface(null,Typeface.BOLD);title.setMaxLines(2);title.setMinLines(2);title.setEllipsize(android.text.TextUtils.TruncateAt.END);title.setPadding(dp(10),dp(8),dp(10),0);title.setIncludeFontPadding(false);title.setLineSpacing(dp(2),1f);
            android.graphics.Paint.FontMetrics metrics=title.getPaint().getFontMetrics();title.setMinHeight((int)Math.ceil((metrics.bottom-metrics.top+dp(2))*2)+dp(10));
            root.addView(title,new LinearLayout.LayoutParams(-1,Math.max(title.getMinimumHeight(),(int)Math.ceil(title.getTextSize()*3.3f)+dp(10))));
            meta=label("",12,MUTED);meta.setSingleLine();meta.setEllipsize(android.text.TextUtils.TruncateAt.END);meta.setGravity(Gravity.CENTER_VERTICAL);meta.setPadding(dp(10),0,dp(10),0);meta.setIncludeFontPadding(false);
            root.addView(meta,new LinearLayout.LayoutParams(-1,dp(34)));
        }
    }
    private static final class VideoCoverFrame extends FrameLayout {
        VideoCoverFrame(android.content.Context context){super(context);}
        @Override protected void onMeasure(int widthMeasureSpec,int heightMeasureSpec){
            int width=MeasureSpec.getSize(widthMeasureSpec);
            int height=Math.round(width*9f/16f);
            super.onMeasure(widthMeasureSpec,MeasureSpec.makeMeasureSpec(height,MeasureSpec.EXACTLY));
        }
    }
    private String date(long time){if(time<=0)return "";return new SimpleDateFormat("yyyy/M/d",Locale.CHINA).format(new Date(time<100000000000L?time*1000:time));}
    private String count(long value){return value>=10000?String.format(Locale.CHINA,"%.1f万",value/10000.0):String.valueOf(value);}
    private void loadCover(ImageView image,LibraryDb.Video video) {
        String key=video.uri+"|"+video.size+"|"+video.modified;image.setTag(key);Bitmap cached=images.get(key);image.setImageBitmap(cached);if(cached!=null)return;
        if(failedCovers.contains(key)||!loadingCovers.add(key))return;
        covers.execute(() -> {Bitmap bitmap=null;try {
            String name=Fingerprints.full(() -> new ByteArrayInputStream(key.getBytes(java.nio.charset.StandardCharsets.UTF_8)),() -> false);File directory=new File(getCacheDir(),"covers");directory.mkdirs();File file=new File(directory,name+".jpg");bitmap=android.graphics.BitmapFactory.decodeFile(file.getPath());
            if(bitmap==null){MediaMetadataRetriever retriever=new MediaMetadataRetriever();try{retriever.setDataSource(getApplicationContext(),Uri.parse(video.uri));String duration=retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);long length=duration==null?0:Long.parseLong(duration);long seek=length<=0?1000000L:(long)(length*(0.15+Math.random()*0.7))*1000;if(Build.VERSION.SDK_INT>=27)bitmap=retriever.getScaledFrameAtTime(seek,MediaMetadataRetriever.OPTION_CLOSEST_SYNC,360,203);else{Bitmap frame=retriever.getFrameAtTime(seek,MediaMetadataRetriever.OPTION_CLOSEST_SYNC);if(frame!=null){float ratio=Math.min(360f/frame.getWidth(),203f/frame.getHeight());bitmap=Bitmap.createScaledBitmap(frame,Math.max(1,Math.round(frame.getWidth()*ratio)),Math.max(1,Math.round(frame.getHeight()*ratio)),true);if(bitmap!=frame)frame.recycle();}}if(bitmap!=null)try(OutputStream output=new FileOutputStream(file)){bitmap.compress(Bitmap.CompressFormat.JPEG,78,output);}}finally{retriever.release();}}
            if(bitmap!=null)images.put(key,bitmap);
        }catch(Exception ignored){}finally{loadingCovers.remove(key);if(bitmap==null)failedCovers.add(key);}Bitmap result=bitmap;ui.post(() -> {if(destroyed)return;if(key.equals(image.getTag()))image.setImageBitmap(result);if(result!=null)for(int i=0;i<grid.getChildCount();i++){View view=grid.getChildAt(i);if(view.getTag() instanceof Card){ImageView target=((Card)view.getTag()).image;if(key.equals(target.getTag()))target.setImageBitmap(result);}}});});
    }
}
