package com.iwara.local;

import android.app.Activity;
import android.app.Dialog;
import android.app.PictureInPictureParams;
import android.util.Rational;
import android.content.pm.PackageManager;
import android.widget.ProgressBar;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.ColorDrawable;
import android.media.AudioManager;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;
import android.util.LruCache;
import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.Timeline;
import androidx.media3.common.TrackSelectionParameters;
import androidx.media3.common.VideoSize;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;
import com.google.common.util.concurrent.ListenableFuture;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.HashSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Locale;
import java.util.Set;
import java.lang.ref.WeakReference;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.IntConsumer;

/** Bilibili-style watch page. The service owns playback and its stable source queue. */
public final class PlayerActivity extends Activity {
    private static final int BLUE = Color.rgb(37, 99, 235);
    private static final int INK = Color.rgb(27, 43, 68);
    private static final int MUTED = Color.rgb(107, 125, 148);
    private static final int GESTURE_NONE = 0;
    private static final int GESTURE_BRIGHTNESS = 1;
    private static final int GESTURE_VOLUME = 2;
    private static final int GESTURE_SEEK = 3;
    private static final int GESTURE_IGNORE_ADJUSTMENT = 4;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService thumbnails = Executors.newFixedThreadPool(2);
    private final Set<String> thumbnailJobs = Collections.synchronizedSet(new HashSet<>());
    private final LruCache<String, Bitmap> thumbnailCache = new LruCache<String, Bitmap>(8 * 1024 * 1024) {
        @Override protected int sizeOf(String key, Bitmap bitmap) { return bitmap.getAllocationByteCount(); }
    };
    private final Map<String, ArrayList<WeakReference<ImageView>>> thumbnailTargets = new HashMap<>();
    private final Set<String> thumbnailFailures = Collections.synchronizedSet(new HashSet<>());
    private static final class ThumbnailRef {
        final String key;
        final PlaybackQueue.Track track;
        ThumbnailRef(String key, PlaybackQueue.Track track) { this.key = key; this.track = track; }
    }

    private LinearLayout root, details, recommendations;
    private ScrollView detailScroll, queueScroll;
    private VideoStage stage;
    private FrameLayout stageFrame;
    private PlayerView playerView;
    private ImageView poster;
    private View audioCard, controls;
    private TextView title, fullscreenTitle, author, count, playButton, centerPlay, fullScreenButton, backButton;
    private TextView transportPlayButton, previousButton, nextButton, playbackSummaryButton;
    private TextView audioBanner, settingsButton;
    private TextView lockButton, pipButton, fullPrevious, fullNext, errorText;
    private View fullTransport, errorPanel;
    private ProgressBar bufferingIndicator;
    private boolean touchLocked, pipSession;
    private TextView gestureFeedback;
    private TextView modeCaption, audioModeButton;
    private Dialog settingsDialog;
    private LinearLayout settingsSheet;
    private SeekBar seekBar;
    private MediaController controller;
    private ListenableFuture<MediaController> controllerFuture;
    private PlaybackQueue queue;
    private String queueId = "";
    private int normalOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
    private boolean seeking, audioOnly, controlsVisible = true, isFit = true, longSpeed, autoPip;
    private boolean fullscreen, hasStartedCurrent, destroyed, stopRequested;
    private boolean queueWindowLoading;
    private float originalSpeed = 1f;
    private int repeatMode;
    private int displayQueuePosition;
    private int queueWindowStart, queueWindowEnd;
    private ArrayList<Integer> displayedQueueOrder = new ArrayList<>();
    private float gestureStartBrightness = 0.5f;
    private float initialScreenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
    private int initialCutoutMode;
    private boolean screenBrightnessChanged;
    private int gestureStartVolume, gestureKind;
    private long gestureStartPosition, gestureTargetPosition, gestureDuration;
    private int gestureMediaIndex;
    private int authorReturnIndex = -1;
    private long authorReturnPosition;

    private final Runnable updateProgress = new Runnable() {
        @Override public void run() {
            if (controller != null && controller.getMediaItemCount() > 0) updatePlaybackUi();
            if (!destroyed) ui.postDelayed(this, 400);
        }
    };
    private final Runnable hideControls = () -> setControlsVisible(false);

    @Override protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        normalOrientation = savedInstanceState == null
                ? (getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE
                    ? ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT)
                : savedInstanceState.getInt("normal_orientation", ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        fullscreen = savedInstanceState != null && savedInstanceState.getBoolean("fullscreen", false);
        if (savedInstanceState != null) {
            authorReturnIndex = savedInstanceState.getInt("author_return_index", -1);
            authorReturnPosition = savedInstanceState.getLong("author_return_position", 0);
        }
        audioOnly = PlaybackService.audioOnly(this);
        isFit = PlaybackService.fitMode(this);
        repeatMode = PlaybackService.repeatMode(this);
        autoPip = getSharedPreferences("player_settings", MODE_PRIVATE).getBoolean("auto_pip", false);
        queueId = getIntent().getStringExtra("queue_id");
        try { queue = PlaybackQueueStore.load(this, queueId); }
        catch (Exception error) {
            Toast.makeText(this, "播放列表已失效，请返回列表重新打开", Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        displayQueuePosition = queue.startIndex;

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WindowManager.LayoutParams initialWindow = getWindow().getAttributes();
        initialScreenBrightness = initialWindow.screenBrightness;
        if (Build.VERSION.SDK_INT >= 28) initialCutoutMode = initialWindow.layoutInDisplayCutoutMode;
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
        applyWindowStyle();
        buildUi();

        Intent service = new Intent(this, PlaybackService.class).putExtra("queue_id", queueId)
                .putExtra("autoplay", savedInstanceState == null);
        if (savedInstanceState != null && authorReturnIndex >= 0)
            service.putExtra("restore_index", authorReturnIndex).putExtra("restore_position", authorReturnPosition);
        startService(service);
        connectSession();
    }

    private void connectSession() {
        if (controllerFuture != null) {
            ListenableFuture<MediaController> old = controllerFuture;
            controllerFuture = null;
            MediaController.releaseFuture(old);
        }
        controller = null;
        hasStartedCurrent = false;
        SessionToken token = new SessionToken(this, new ComponentName(this, PlaybackService.class));
        ListenableFuture<MediaController> pending = new MediaController.Builder(getApplicationContext(), token).buildAsync();
        controllerFuture = pending;
        pending.addListener(() -> {
            try {
                if (destroyed || controllerFuture != pending) return;
                MediaController connected = pending.get();
                runOnUiThread(() -> connectPlayer(connected));
            } catch (Exception error) {
                runOnUiThread(() -> Toast.makeText(this, "播放器服务暂时不可用，请返回列表重试", Toast.LENGTH_LONG).show());
            }
        }, command -> {
            if (Looper.myLooper() == Looper.getMainLooper()) command.run();
            else runOnUiThread(command);
        });
    }

    private void buildUi() {
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        stage = new VideoStage(this);
        stage.setBackgroundColor(Color.BLACK);
        stageFrame = new FrameLayout(this);
        stageFrame.setBackgroundColor(Color.BLACK);
        stage.addView(stageFrame, new FrameLayout.LayoutParams(-1, -1));

        playerView = new PlayerView(this);
        playerView.setUseController(false);
        playerView.setContentDescription("视频区域。单击显示或隐藏控件，双击播放或暂停；左右滑动预览进度并在松手时跳转；左侧竖滑调亮度，右侧竖滑调音量；可拖动底部进度条定位");
        playerView.setResizeMode(isFit ? AspectRatioFrameLayout.RESIZE_MODE_FIT : AspectRatioFrameLayout.RESIZE_MODE_ZOOM);
        stageFrame.addView(playerView, new FrameLayout.LayoutParams(-1, -1));

        poster = new ImageView(this);
        poster.setScaleType(ImageView.ScaleType.CENTER_CROP);
        poster.setBackgroundColor(0xFF151A24);
        poster.setClickable(false);
        stageFrame.addView(poster, new FrameLayout.LayoutParams(-1, -1));

        LinearLayout audio = new LinearLayout(this);
        audio.setOrientation(LinearLayout.VERTICAL);
        audio.setGravity(Gravity.CENTER);
        audio.setBackground(new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[]{0xFF17243B, 0xFF080B12, 0xFF1B273D}));
        TextView glyph = text("♫", 56, 0xFFBFD4FF, true);
        glyph.setGravity(Gravity.CENTER);
        audio.addView(glyph, new LinearLayout.LayoutParams(-1, 0, 1));
        audioBanner = text("仅音频播放", 14, 0xFFCFD8E6, false);
        audioBanner.setGravity(Gravity.CENTER);
        audioBanner.setMaxLines(1);
        audioBanner.setEllipsize(android.text.TextUtils.TruncateAt.END);
        audioBanner.setPadding(dp(20), 0, dp(20), dp(14));
        audio.addView(audioBanner, new LinearLayout.LayoutParams(-1, -2));
        audioCard = audio;
        stageFrame.addView(audioCard, new FrameLayout.LayoutParams(-1, -1));

        controls = new LinearLayout(this);
        ((LinearLayout) controls).setOrientation(LinearLayout.VERTICAL);
        controls.setPadding(dp(8), dp(14), dp(8), dp(8));
        controls.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{0x08000000, 0xB9000000}));
        LinearLayout progress = new LinearLayout(this);
        progress.setGravity(Gravity.CENTER_VERTICAL);
        playButton = action("▶", "播放或暂停", 17);
        progress.addView(playButton, new LinearLayout.LayoutParams(dp(44), dp(44)));
        playButton.setOnClickListener(view -> togglePlay());
        TextView elapsed = text("0:00", 11, Color.WHITE, false);
        elapsed.setTag("elapsed");
        elapsed.setGravity(Gravity.CENTER);
        progress.addView(elapsed, new LinearLayout.LayoutParams(dp(34), -2));
        seekBar = new SeekBar(this);
        seekBar.setMax(1000);
        seekBar.setContentDescription("播放进度");
        if (Build.VERSION.SDK_INT >= 21) {
            seekBar.setProgressTintList(android.content.res.ColorStateList.valueOf(0xFF38BDF8));
            seekBar.setThumbTintList(android.content.res.ColorStateList.valueOf(Color.WHITE));
            seekBar.setProgressBackgroundTintList(android.content.res.ColorStateList.valueOf(0x668FA5C4));
        }
        progress.addView(seekBar, new LinearLayout.LayoutParams(0, dp(44), 1));
        TextView duration = text("0:00", 11, Color.WHITE, false);
        duration.setTag("duration");
        duration.setGravity(Gravity.CENTER);
        progress.addView(duration, new LinearLayout.LayoutParams(dp(34), -2));
        settingsButton = action("设置", "播放设置", 12);
        progress.addView(settingsButton, new LinearLayout.LayoutParams(dp(40), dp(44)));
        settingsButton.setOnClickListener(view -> showPlayerSettings());
        fullScreenButton = action("⛶", "进入全屏", 22);
        progress.addView(fullScreenButton, new LinearLayout.LayoutParams(dp(40), dp(44)));
        fullScreenButton.setOnClickListener(view -> setFullscreen(!fullscreen));
        seekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar bar, int value, boolean fromUser) {
                if (fromUser && controller != null && controller.getDuration() > 0) {
                    elapsed.setText(formatTime(controller.getDuration() * value / bar.getMax()));
                }
            }
            @Override public void onStartTrackingTouch(SeekBar bar) { seeking = true; }
            @Override public void onStopTrackingTouch(SeekBar bar) {
                if (controller != null && controller.getDuration() > 0)
                    controller.seekTo(controller.getDuration() * bar.getProgress() / bar.getMax());
                seeking = false;
            }
        });
        ((LinearLayout) controls).addView(progress);
        stageFrame.addView(controls, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));

        centerPlay = action("▶", "播放", 26);
        centerPlay.setBackground(new GradientDrawable() {{
            setColor(0xB3232D40); setShape(GradientDrawable.OVAL); setStroke(dp(1), 0x667E91AA);
        }});
        centerPlay.setElevation(dp(3));
        centerPlay.setVisibility(View.GONE);
        centerPlay.setOnClickListener(view -> togglePlay());
        stageFrame.addView(centerPlay, new FrameLayout.LayoutParams(dp(66), dp(66), Gravity.CENTER));
        backButton = action("‹", "返回视频库", 28);
        backButton.setOnClickListener(view -> onBackPressed());
        FrameLayout.LayoutParams backBounds = new FrameLayout.LayoutParams(dp(52), dp(52), Gravity.TOP | Gravity.LEFT);
        backBounds.setMargins(dp(14), dp(12), 0, 0);
        stageFrame.addView(backButton, backBounds);
        fullscreenTitle = text("", 14, Color.WHITE, true);
        fullscreenTitle.setSingleLine(true);
        fullscreenTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
        fullscreenTitle.setGravity(Gravity.CENTER_VERTICAL);
        fullscreenTitle.setContentDescription("当前播放标题");
        fullscreenTitle.setPadding(dp(12), 0, dp(12), 0);
        fullscreenTitle.setBackground(shape(0x55304055, 16));
        FrameLayout.LayoutParams fullscreenTitleBounds = new FrameLayout.LayoutParams(-1, dp(48),
                Gravity.TOP | Gravity.LEFT);
        fullscreenTitleBounds.setMargins(dp(72), dp(14), dp(132), 0);
        fullscreenTitle.setVisibility(View.GONE);
        stageFrame.addView(fullscreenTitle, fullscreenTitleBounds);
        LinearLayout cornerActions = new LinearLayout(this);
        lockButton = action("锁定", "锁定全屏触控", 12);
        lockButton.setOnClickListener(view -> setTouchLocked(!touchLocked));
        cornerActions.addView(lockButton, new LinearLayout.LayoutParams(dp(56), dp(52)));
        pipButton = action("浮窗", "进入浮动播放窗口", 12);
        pipButton.setOnClickListener(view -> enterFloatingPlayback());
        cornerActions.addView(pipButton, new LinearLayout.LayoutParams(dp(56), dp(52)));
        FrameLayout.LayoutParams cornerBounds = new FrameLayout.LayoutParams(-2, dp(52), Gravity.TOP | Gravity.RIGHT);
        cornerBounds.setMargins(0, dp(12), dp(14), 0);
        stageFrame.addView(cornerActions, cornerBounds);
        fullTransport = new LinearLayout(this);
        ((LinearLayout) fullTransport).setGravity(Gravity.CENTER);
        fullPrevious = action("‹ 上一条", "全屏播放上一条", 13);
        fullNext = action("下一条 ›", "全屏播放下一条", 13);
        fullPrevious.setOnClickListener(view -> seekRelativeItem(-1));
        fullNext.setOnClickListener(view -> seekRelativeItem(1));
        ((LinearLayout) fullTransport).addView(fullPrevious, new LinearLayout.LayoutParams(dp(110), dp(44)));
        ((LinearLayout) fullTransport).addView(fullNext, new LinearLayout.LayoutParams(dp(110), dp(44)));
        ((LinearLayout) controls).addView(fullTransport, 0);
        bufferingIndicator = new ProgressBar(this);
        bufferingIndicator.setContentDescription("加载中");
        bufferingIndicator.setVisibility(View.GONE);
        stageFrame.addView(bufferingIndicator, new FrameLayout.LayoutParams(dp(44), dp(44), Gravity.CENTER));
        LinearLayout failure = new LinearLayout(this);
        failure.setOrientation(LinearLayout.VERTICAL);
        failure.setGravity(Gravity.CENTER);
        failure.setPadding(dp(12), dp(8), dp(12), dp(8));
        failure.setBackground(shape(0xE6192333, 12));
        errorText = text("", 12, Color.WHITE, false);
        errorText.setGravity(Gravity.CENTER);
        errorText.setMaxLines(3);
        failure.addView(errorText, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout recovery = new LinearLayout(this);
        TextView retry = action("重试", "重试当前视频", 13);
        retry.setOnClickListener(view -> { if (controller != null) { controller.prepare(); controller.play(); updatePlaybackUi(); } });
        TextView skip = action("下一条", "跳过失败视频", 13);
        skip.setOnClickListener(view -> seekRelativeItem(1));
        recovery.addView(retry, new LinearLayout.LayoutParams(dp(90), dp(44)));
        recovery.addView(skip, new LinearLayout.LayoutParams(dp(90), dp(44)));
        failure.addView(recovery);
        errorPanel = failure;
        failure.setVisibility(View.GONE);
        stageFrame.addView(failure, new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER));
        gestureFeedback = text("", 14, Color.WHITE, true);
        gestureFeedback.setGravity(Gravity.CENTER);
        gestureFeedback.setPadding(dp(18), dp(10), dp(18), dp(10));
        gestureFeedback.setBackground(shape(0x55304055, 24));
        gestureFeedback.setShadowLayer(dp(1), 0, dp(1), 0x99000000);
        gestureFeedback.setVisibility(View.GONE);
        stageFrame.addView(gestureFeedback, new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER));
        root.addView(stage, new LinearLayout.LayoutParams(-1, -2));

        detailScroll = new ScrollView(this);
        detailScroll.setFillViewport(true);
        detailScroll.setClipToPadding(false);
        details = new LinearLayout(this);
        details.setOrientation(LinearLayout.VERTICAL);
        details.setPadding(dp(16), dp(12), dp(16), dp(24));
        detailScroll.addView(details, new ScrollView.LayoutParams(-1, -2));

        title = text("正在打开视频…", 18, INK, true);
        title.setMaxLines(3);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        title.setBreakStrategy(android.text.Layout.BREAK_STRATEGY_HIGH_QUALITY);
        details.addView(title, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout metaRow = new LinearLayout(this);
        metaRow.setGravity(Gravity.CENTER_VERTICAL);
        author = text("", 12, MUTED, false);
        author.setMaxLines(1);
        author.setContentDescription("查看作者视频");
        author.setTextColor(BLUE);
        author.setOnClickListener(view -> {
            PlaybackQueue.Track track = trackAt(controller == null ? queue.startIndex : controller.getCurrentMediaItemIndex());
            if (track == null || track.author == null || track.author.trim().isEmpty()) return;
            if (controller != null) {
                authorReturnIndex = controller.getCurrentMediaItemIndex();
                authorReturnPosition = controller.getCurrentPosition();
                controller.pause();
            }
            startActivity(new Intent(this, MainActivity.class).putExtra("author_scope", track.author));
        });
        author.setEllipsize(android.text.TextUtils.TruncateAt.END);
        metaRow.addView(author, new LinearLayout.LayoutParams(0, dp(44), 1));
        count = text("0 / 0", 12, MUTED, false);
        count.setGravity(Gravity.CENTER_VERTICAL | Gravity.RIGHT);
        count.setContentDescription("播放列表位置");
        metaRow.addView(count, new LinearLayout.LayoutParams(-2, dp(44)));
        LinearLayout.LayoutParams metaBounds = new LinearLayout.LayoutParams(-1, dp(44));
        metaBounds.topMargin = dp(2);
        details.addView(metaRow, metaBounds);

        LinearLayout transport = new LinearLayout(this);
        transport.setGravity(Gravity.CENTER);
        transport.setOrientation(LinearLayout.HORIZONTAL);
        previousButton = playerAction("‹ 上一条", "播放上一条", false);
        nextButton = playerAction("下一条 ›", "播放下一条", false);
        LinearLayout.LayoutParams previousBounds = new LinearLayout.LayoutParams(0, dp(44), 1);
        previousBounds.setMargins(0, 0, dp(6), 0);
        transport.addView(previousButton, previousBounds);
        LinearLayout.LayoutParams nextBounds = new LinearLayout.LayoutParams(0, dp(44), 1);
        nextBounds.setMargins(0, 0, dp(6), 0);
        transport.addView(nextButton, nextBounds);
        previousButton.setOnClickListener(view -> seekRelativeItem(-1));
        nextButton.setOnClickListener(view -> seekRelativeItem(1));
        audioModeButton = playerAction("音频", "切换仅音频播放", false);
        audioModeButton.setOnClickListener(view -> setAudioOnly(!audioOnly));
        LinearLayout.LayoutParams audioBounds = new LinearLayout.LayoutParams(dp(60), dp(44));
        audioBounds.rightMargin = dp(6);
        transport.addView(audioModeButton, audioBounds);
        playbackSummaryButton = playerAction("设置", "打开播放设置", false);
        playbackSummaryButton.setContentDescription("打开播放设置");
        playbackSummaryButton.setOnClickListener(view -> showPlayerSettings());
        transport.addView(playbackSummaryButton, new LinearLayout.LayoutParams(dp(60), dp(44)));
        LinearLayout.LayoutParams transportBounds = new LinearLayout.LayoutParams(-1, dp(44));
        transportBounds.topMargin = dp(6);
        details.addView(transport, transportBounds);
        modeCaption = text("", 11, MUTED, false);
        modeCaption.setSingleLine();
        modeCaption.setEllipsize(android.text.TextUtils.TruncateAt.END);
        modeCaption.setGravity(Gravity.CENTER_VERTICAL);
        details.addView(modeCaption, new LinearLayout.LayoutParams(-1, dp(36)));
        View divider = new View(this);
        divider.setBackgroundColor(0xFFEFF2F6);
        details.addView(divider, new LinearLayout.LayoutParams(-1, dp(1)));

        LinearLayout recHeading = new LinearLayout(this);
        recHeading.setGravity(Gravity.CENTER_VERTICAL);
        TextView recTitle = text("播放列表 · " + queue.tracks.size(), 16, INK, true);
        recHeading.addView(recTitle, new LinearLayout.LayoutParams(0, dp(44), 1));
        TextView scrollHint = text("上下滑动浏览", 12, MUTED, false);
        recHeading.addView(scrollHint, new LinearLayout.LayoutParams(-2, dp(44)));
        details.addView(recHeading);
        recommendations = new LinearLayout(this);
        recommendations.setOrientation(LinearLayout.VERTICAL);
        queueScroll = new ScrollView(this);
        queueScroll.setContentDescription("可上下滑动的播放列表");
        queueScroll.addView(recommendations, new ScrollView.LayoutParams(-1, -2));
        details.addView(queueScroll, new LinearLayout.LayoutParams(-1, dp(320)));
        queueScroll.setOnTouchListener((view, event) -> {
            view.getParent().requestDisallowInterceptTouchEvent(event.getActionMasked() != MotionEvent.ACTION_UP
                    && event.getActionMasked() != MotionEvent.ACTION_CANCEL);
            return false;
        });
        queueScroll.setOnScrollChangeListener((View view, int scrollX, int scrollY, int oldScrollX, int oldScrollY) -> {
            int dy = scrollY - oldScrollY;
            loadVisibleQueueThumbnails();
            if (dy == 0 || queueWindowLoading) return;
            int contentHeight = recommendations.getHeight();
            if (dy > 0 && scrollY + queueScroll.getHeight() >= contentHeight - dp(180)
                    && queueWindowEnd < displayedQueueOrder.size()) {
                extendQueueWindow(false);
            } else if (dy < 0 && scrollY <= dp(100)
                    && queueWindowStart > 0) {
                extendQueueWindow(true);
            }
        });

        root.addView(detailScroll, new LinearLayout.LayoutParams(-1, 0, 1));
        playerView.setOnTouchListener(createPlayerTouchListener());
        centerPlay.setOnTouchListener(new View.OnTouchListener() {
            @Override public boolean onTouch(View view, MotionEvent event) {
                MotionEvent mapped = MotionEvent.obtain(event);
                mapped.offsetLocation(view.getLeft()-playerView.getLeft(), view.getTop()-playerView.getTop());
                // Keep the center play affordance on the same gesture path as the video surface.
                // Otherwise each tap becomes an independent button click and a double tap toggles twice.
                playerView.dispatchTouchEvent(mapped);
                mapped.recycle();
                return true;
            }
        });
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (fullscreen) {
                root.setPadding(0, 0, 0, 0);
                stage.setTranslationX(0f);
                int safeLeft = 0, safeTop = 0, safeRight = 0;
                if (Build.VERSION.SDK_INT >= 28 && insets.getDisplayCutout() != null) {
                    safeLeft = insets.getDisplayCutout().getSafeInsetLeft();
                    safeTop = insets.getDisplayCutout().getSafeInsetTop();
                    safeRight = insets.getDisplayCutout().getSafeInsetRight();
                }
                FrameLayout.LayoutParams back = (FrameLayout.LayoutParams) backButton.getLayoutParams();
                back.setMargins(dp(14) + safeLeft, dp(12) + safeTop, 0, 0);
                backButton.setLayoutParams(back);
                FrameLayout.LayoutParams heading = (FrameLayout.LayoutParams) fullscreenTitle.getLayoutParams();
                heading.setMargins(dp(72) + safeLeft, dp(14) + safeTop, dp(132) + safeRight, 0);
                fullscreenTitle.setLayoutParams(heading);
                ViewGroup cornerActionsContainer = (ViewGroup) lockButton.getParent();
                FrameLayout.LayoutParams corners = (FrameLayout.LayoutParams) cornerActionsContainer.getLayoutParams();
                corners.setMargins(0, dp(12) + safeTop, dp(14) + safeRight, 0);
                cornerActionsContainer.setLayoutParams(corners);
            }
            else root.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(root);
        root.requestApplyInsets();
        if (fullscreen) applyFullscreenLayout();
        updatePlaybackSummary();
        updateCurrentDetails(queue.startIndex);
        renderRecommendations();
    }

    private View.OnTouchListener createPlayerTouchListener() {
        GestureDetector detector = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            @Override public boolean onDown(MotionEvent event) {
                gestureKind = GESTURE_NONE;
                gestureStartPosition = controller == null ? 0 : controller.getCurrentPosition();
                gestureTargetPosition = gestureStartPosition;
                gestureDuration = controller == null ? C.TIME_UNSET : controller.getDuration();
                gestureMediaIndex = controller == null ? -1 : controller.getCurrentMediaItemIndex();
                return true;
            }
            @Override public boolean onSingleTapConfirmed(MotionEvent event) {
                if (isCenterPlayTap(event)) {
                    togglePlay();
                    return true;
                }
                setControlsVisible(!controlsVisible);
                return true;
            }
            @Override public boolean onDoubleTap(MotionEvent event) {
                // Left and right screen zones are not seek shortcuts. Seeking is explicit in the
                // control bar or continuous through horizontal scrubbing.
                togglePlay();
                return true;
            }
            @Override public boolean onScroll(MotionEvent first, MotionEvent current, float distanceX, float distanceY) {
                float totalX = current.getX() - first.getX();
                float totalY = current.getY() - first.getY();
                if (gestureKind == GESTURE_NONE) {
                    if (Math.max(Math.abs(totalX), Math.abs(totalY)) < dp(14)) return false;
                    if (Math.abs(totalX) > Math.abs(totalY) * 1.2f) gestureKind = GESTURE_SEEK;
                    else if (Math.abs(totalY) > Math.abs(totalX) * 1.2f) {
                        float startRatio = first.getX() / Math.max(1f, playerView.getWidth());
                        if (startRatio <= 1f / 3f) {
                            gestureKind = GESTURE_BRIGHTNESS;
                            gestureStartBrightness = getWindow().getAttributes().screenBrightness;
                            if (gestureStartBrightness < 0f) {
                                int systemBrightness = Settings.System.getInt(getContentResolver(),
                                        Settings.System.SCREEN_BRIGHTNESS, 128);
                                gestureStartBrightness = Math.max(0.02f, Math.min(1f, systemBrightness / 255f));
                            }
                        } else if (startRatio >= 2f / 3f) {
                            gestureKind = GESTURE_VOLUME;
                            AudioManager audio = (AudioManager) getSystemService(AUDIO_SERVICE);
                            gestureStartVolume = audio.getStreamVolume(AudioManager.STREAM_MUSIC);
                        }
                        else gestureKind = GESTURE_IGNORE_ADJUSTMENT;
                    }
                    else return false;
                }
                if (gestureKind == GESTURE_IGNORE_ADJUSTMENT) return true;
                if (gestureKind == GESTURE_SEEK) {
                    if (controller == null || gestureDuration <= 0 || gestureDuration == C.TIME_UNSET
                            || controller.getCurrentMediaItemIndex() != gestureMediaIndex) return true;
                    long range = Math.min(gestureDuration, 120000L);
                    gestureTargetPosition = Math.max(0, Math.min(gestureDuration - 1,
                            gestureStartPosition + Math.round(totalX / Math.max(1f, playerView.getWidth()) * range)));
                    long delta = gestureTargetPosition - gestureStartPosition;
                    showGestureFeedback((delta < 0 ? "后退 " : "前进 ") + formatTime(Math.abs(delta))
                            + "\n" + formatTime(gestureTargetPosition) + " / " + formatTime(gestureDuration));
                    setControlsVisible(false);
                    return true;
                }
                if (gestureKind == GESTURE_BRIGHTNESS) {
                    float brightness = Math.max(0.02f, Math.min(1f,
                            gestureStartBrightness - totalY / Math.max(1f, playerView.getHeight()) * 1.5f));
                    WindowManager.LayoutParams attributes = getWindow().getAttributes();
                    attributes.screenBrightness = brightness;
                    getWindow().setAttributes(attributes);
                    screenBrightnessChanged = true;
                    showGestureFeedback("亮度  " + Math.round(brightness * 100) + "%");
                } else {
                    AudioManager audio = (AudioManager) getSystemService(AUDIO_SERVICE);
                    int max = Math.max(1, audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
                    int volume = Math.max(0, Math.min(max, gestureStartVolume - Math.round(totalY / Math.max(1f,
                            playerView.getHeight()) * max * 1.5f)));
                    audio.setStreamVolume(AudioManager.STREAM_MUSIC, volume, 0);
                    showGestureFeedback("音量  " + Math.round(volume * 100f / max) + "%");
                }
                setControlsVisible(false);
                return true;
            }
            @Override public void onLongPress(MotionEvent event) {
                if (controller == null || longSpeed) return;
                longSpeed = true;
                originalSpeed = controller.getPlaybackParameters().speed;
                controller.setPlaybackSpeed(2f);
                showLongPressSpeedFeedback();
            }
        });
        return (view, event) -> {
            if (touchLocked || isInPictureInPictureMode()) return true;
            detector.onTouchEvent(event);
            if (event.getActionMasked() == MotionEvent.ACTION_UP && gestureKind == GESTURE_SEEK && controller != null
                    && gestureDuration > 0 && gestureDuration != C.TIME_UNSET
                    && controller.getCurrentMediaItemIndex() == gestureMediaIndex) {
                controller.seekTo(gestureTargetPosition);
                setControlsVisible(true);
            }
            if (event.getActionMasked() == MotionEvent.ACTION_UP || event.getActionMasked() == MotionEvent.ACTION_CANCEL)
                gestureKind = GESTURE_NONE;
            if ((event.getActionMasked() == MotionEvent.ACTION_UP || event.getActionMasked() == MotionEvent.ACTION_CANCEL) && longSpeed) {
                longSpeed = false;
                if (controller != null) controller.setPlaybackSpeed(originalSpeed);
                if (gestureFeedback != null) gestureFeedback.setVisibility(View.GONE);
            }
            return true;
        };
    }

    private void showGestureFeedback(String message) {
        if (gestureFeedback == null) return;
        gestureFeedback.setText(message);
        gestureFeedback.setTextSize(14);
        gestureFeedback.setPadding(dp(18), dp(10), dp(18), dp(10));
        gestureFeedback.setBackground(shape(0x55304055, 24));
        gestureFeedback.setVisibility(View.VISIBLE);
        ui.removeCallbacks(hideGestureFeedback);
        ui.postDelayed(hideGestureFeedback, 900);
    }

    private void showLongPressSpeedFeedback() {
        if (gestureFeedback == null) return;
        ui.removeCallbacks(hideGestureFeedback);
        gestureFeedback.setText("2×");
        gestureFeedback.setTextSize(12);
        gestureFeedback.setPadding(dp(9), dp(5), dp(9), dp(5));
        gestureFeedback.setBackground(shape(0x22304055, 18));
        gestureFeedback.setVisibility(View.VISIBLE);
    }

    private boolean isCenterPlayTap(MotionEvent event) {
        if (centerPlay == null || centerPlay.getVisibility() != View.VISIBLE) return false;
        float left = centerPlay.getLeft() - playerView.getLeft();
        float top = centerPlay.getTop() - playerView.getTop();
        return event.getX() >= left && event.getX() <= left + centerPlay.getWidth()
                && event.getY() >= top && event.getY() <= top + centerPlay.getHeight();
    }

    private final Runnable hideGestureFeedback = () -> {
        if (gestureFeedback != null) gestureFeedback.setVisibility(View.GONE);
    };

    private void connectPlayer(MediaController connected) {
        if (isFinishing() || destroyed) return;
        controller = connected;
        playerView.setPlayer(connected);
        audioOnly = PlaybackService.audioOnly(this);
        applyAudioOnly();
        connected.addListener(new Player.Listener() {
            @Override public void onMediaItemTransition(@Nullable MediaItem item, int reason) {
                hasStartedCurrent = false;
                updatePlaybackUi();
                updateCurrentDetails(connected.getCurrentMediaItemIndex());
                renderRecommendations();
                loadCurrentPoster();
            }
            @Override public void onMediaMetadataChanged(androidx.media3.common.MediaMetadata metadata) { updatePlaybackUi(); }
            @Override public void onVideoSizeChanged(VideoSize size) {
                if (fullscreen && size.width > 0 && size.height > 0) updateFullscreenOrientation(size);
                updatePictureInPictureParams();
            }
            @Override public void onShuffleModeEnabledChanged(boolean enabled) {
                updatePlaybackSummary();
                renderRecommendations();
            }
            @Override public void onRepeatModeChanged(int mode) {
                updatePlaybackSummary(); updateTransportAvailability(); renderRecommendations();
            }
            @Override public void onPlaybackParametersChanged(androidx.media3.common.PlaybackParameters parameters) {
                updatePlaybackSummary();
            }
            @Override public void onIsPlayingChanged(boolean playing) {
                if (playing) hasStartedCurrent = true;
                updatePlaybackUi();
                updatePictureInPictureParams();
                setControlsVisible(true);
            }
            @Override public void onPlaybackStateChanged(int playbackState) {
                updatePlaybackUi();
                updatePictureInPictureParams();
            }
            @Override public void onPlayerError(PlaybackException error) {
                updatePlaybackUi();
            }
        });
        updatePlaybackSummary();
        updatePlaybackUi();
        updatePictureInPictureParams();
        updateCurrentDetails(connected.getCurrentMediaItemIndex());
        renderRecommendations();
        loadCurrentPoster();
        if (fullscreen) updateFullscreenOrientation(connected.getVideoSize());
        ui.removeCallbacks(updateProgress);
        ui.post(updateProgress);
    }

    private void updatePlaybackUi() {
        if (controller == null) return;
        int current = controller.getCurrentMediaItemIndex();
        int total = controller.getMediaItemCount();
        if (count != null) count.setText(total == 0 ? "0 / 0" : (displayQueuePosition + 1) + " / " + total);
        boolean playing = controller.isPlaying();
        if (playing) hasStartedCurrent = true;
        boolean pip = isInPictureInPictureMode();
        PlaybackException error = controller.getPlayerError();
        boolean buffering = controller.getPlaybackState() == Player.STATE_BUFFERING;
        bufferingIndicator.setVisibility(buffering && error == null && !pip ? View.VISIBLE : View.GONE);
        errorPanel.setVisibility(error != null && !pip && !touchLocked ? View.VISIBLE : View.GONE);
        if (error != null) errorText.setText("播放失败（" + error.errorCode + "）\n"
                + (error.getMessage() == null ? "无法读取或解码，请重试或切换下一条" : error.getMessage()));
        updateOverlayVisibility();
        playButton.setText(playing ? "Ⅱ" : "▶");
        if (transportPlayButton != null) {
            transportPlayButton.setText(playing ? "Ⅱ" : "▶");
            transportPlayButton.setContentDescription(playing ? "暂停" : "播放");
        }
        centerPlay.setVisibility(playing || buffering || error != null || pip || touchLocked ? View.GONE : View.VISIBLE);
        if (poster != null && !audioOnly) poster.setVisibility(hasStartedCurrent ? View.GONE : View.VISIBLE);
        getWindow().getDecorView().setKeepScreenOn(playing);
        long duration = controller.getDuration();
        long position = controller.getCurrentPosition();
        TextView elapsed = controls.findViewWithTag("elapsed");
        TextView durationLabel = controls.findViewWithTag("duration");
        elapsed.setText(formatTime(position));
        durationLabel.setText(formatTime(duration));
        if (!seeking && duration > 0 && duration != C.TIME_UNSET)
            seekBar.setProgress((int) Math.max(0, Math.min(1000, position * 1000 / duration)));
        updateTransportAvailability();
        if (!playing && controlsVisible) ui.removeCallbacks(hideControls);
    }

    private void updateCurrentDetails(int index) {
        PlaybackQueue.Track track = trackAt(index);
        if (track == null) return;
        String displayTitle = track.title == null || track.title.isEmpty() ? "本地视频" : track.title;
        title.setText(displayTitle);
        if (fullscreenTitle != null) fullscreenTitle.setText(displayTitle);
        String creator = track.author == null || track.author.isEmpty() ? "本地视频" : track.author;
        String date = date(track.uploadTime);
        StringBuilder summary = new StringBuilder(creator);
        if (!date.isEmpty()) summary.append(" · ").append(date);
        if (track.views >= 0) summary.append(" · ").append(count(track.views)).append(" 次播放");
        author.setText(summary);
        audioBanner.setText(track.title == null || track.title.isEmpty() ? "仅音频播放" : track.title);
    }

    private PlaybackQueue.Track trackAt(int index) {
        if (queue == null || index < 0 || index >= queue.tracks.size()) return null;
        return queue.tracks.get(index);
    }

    private void renderRecommendations() {
        if (recommendations == null || queue == null) return;
        recommendations.removeAllViews();
        int current = controller == null ? queue.startIndex : controller.getCurrentMediaItemIndex();
        ArrayList<Integer> indexes = queueDisplayIndexes(current);
        displayedQueueOrder = indexes;
        displayQueuePosition = Math.max(0, indexes.indexOf(current));
        if (count != null) count.setText((displayQueuePosition + 1) + " / " + indexes.size());
        int position = Math.max(0, indexes.indexOf(current));
        if (position < queueWindowStart || position >= queueWindowEnd || queueWindowEnd <= queueWindowStart) {
            queueWindowStart = Math.max(0, position - 8);
            queueWindowEnd = Math.min(indexes.size(), queueWindowStart + 32);
        } else {
            queueWindowEnd = Math.min(indexes.size(), Math.max(queueWindowEnd, queueWindowStart + 32));
        }
        for (int i = queueWindowStart; i < queueWindowEnd; i++) appendQueueCard(i, false);
        queueScroll.post(() -> {
            loadVisibleQueueThumbnails();
            int offset = Math.max(0, position - queueWindowStart - 1);
            queueScroll.scrollTo(0, offset * dp(90));
        });
    }

    private void appendQueueCard(int orderIndex, boolean atTop) {
        if (orderIndex < 0 || orderIndex >= displayedQueueOrder.size()) return;
        int trackIndex = displayedQueueOrder.get(orderIndex);
        PlaybackQueue.Track track = queue.tracks.get(trackIndex);
        View card = recommendationCard(track, trackIndex, orderIndex + 1,
                trackIndex == (controller == null ? queue.startIndex : controller.getCurrentMediaItemIndex()));
        if (atTop) {
            recommendations.addView(card, 0, new LinearLayout.LayoutParams(-1, dp(84)));
            if (recommendations.getChildCount() > 1) recommendations.addView(queueSpacer(), 1,
                    new LinearLayout.LayoutParams(1, dp(6)));
        } else {
            if (recommendations.getChildCount() > 0) recommendations.addView(queueSpacer(),
                    new LinearLayout.LayoutParams(1, dp(6)));
            recommendations.addView(card, new LinearLayout.LayoutParams(-1, dp(84)));
        }
    }

    private View queueSpacer() { return new View(this); }

    private void extendQueueWindow(boolean towardStart) {
        if (queueWindowLoading) return;
        queueWindowLoading = true;
        final int batch = 24;
        final int oldScroll = queueScroll.getScrollY();
        final int oldHeight = recommendations.getHeight();
        if (towardStart) {
            int newStart = Math.max(0, queueWindowStart - batch);
            for (int i = queueWindowStart - 1; i >= newStart; i--) appendQueueCard(i, true);
            queueWindowStart = newStart;
            recommendations.post(() -> {
                int added = Math.max(0, recommendations.getHeight() - oldHeight);
                queueScroll.scrollTo(0, oldScroll + added);
                trimQueueWindow(false);
                queueWindowLoading = false;
                loadVisibleQueueThumbnails();
            });
        } else {
            int newEnd = Math.min(displayedQueueOrder.size(), queueWindowEnd + batch);
            for (int i = queueWindowEnd; i < newEnd; i++) appendQueueCard(i, false);
            queueWindowEnd = newEnd;
            recommendations.post(() -> {
                trimQueueWindow(true);
                queueWindowLoading = false;
                loadVisibleQueueThumbnails();
            });
        }
    }

    private void trimQueueWindow(boolean fromStart) {
        final int retain = 56, trim = 24;
        if (queueWindowEnd - queueWindowStart <= retain) return;
        int count = Math.min(trim, queueWindowEnd - queueWindowStart - 32);
        if (fromStart) {
            int oldHeight = recommendations.getHeight();
            int oldScroll = queueScroll.getScrollY();
            for (int i = 0; i < count * 2 && recommendations.getChildCount() > 0; i++)
                recommendations.removeViewAt(0);
            queueWindowStart += count;
            recommendations.post(() -> {
                int newHeight = recommendations.getHeight();
                queueScroll.scrollTo(0, Math.max(0, oldScroll - Math.max(0, oldHeight - newHeight)));
            });
        } else {
            for (int i = 0; i < count * 2 && recommendations.getChildCount() > 0; i++)
                recommendations.removeViewAt(recommendations.getChildCount() - 1);
            queueWindowEnd -= count;
        }
    }

    private ArrayList<Integer> queueDisplayIndexes(int current) {
        ArrayList<Integer> indexes = new ArrayList<>();
        if (queue == null) return indexes;
        int size = queue.tracks.size();
        if (size == 0) return indexes;
        if (controller == null || controller.getMediaItemCount() != size) {
            for (int i = 0; i < size; i++) indexes.add(i);
            return indexes;
        }
        Timeline timeline = controller.getCurrentTimeline();
        if (timeline.isEmpty() || current < 0 || current >= size) {
            for (int i = 0; i < size; i++) indexes.add(i);
            return indexes;
        }
        HashSet<Integer> seen = new HashSet<>();
        int index = timeline.getFirstWindowIndex(controller.getShuffleModeEnabled());
        for (int i = 0; i < size && index >= 0 && index < size && seen.add(index); i++) {
            indexes.add(index);
            index = timeline.getNextWindowIndex(index, Player.REPEAT_MODE_OFF, controller.getShuffleModeEnabled());
        }
        // In stop-after-list mode, keep already-played queue items accessible after upcoming items.
        for (int i = 0; i < size; i++) if (seen.add(i)) indexes.add(i);
        return indexes;
    }

    private View recommendationCard(PlaybackQueue.Track track, int index, int order, boolean current) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.HORIZONTAL);
        card.setGravity(Gravity.CENTER_VERTICAL);
        card.setPadding(dp(6), dp(7), dp(8), dp(7));
        GradientDrawable cardBackground = shape(current ? 0xFFF0F5FF : Color.WHITE, 12);
        card.setBackground(cardBackground);
        card.setForeground(new android.graphics.drawable.RippleDrawable(
                android.content.res.ColorStateList.valueOf(0x183B82F6), null, shape(Color.WHITE, 14)));
        card.setClipToOutline(true);
        card.setClickable(true);

        FrameLayout cover = new FrameLayout(this);
        cover.setBackground(shape(0xFFE5ECF6, 10));
        cover.setClipToOutline(true);
        ImageView image = new ImageView(this);
        image.setScaleType(ImageView.ScaleType.CENTER_CROP);
        image.setTag(track);
        cover.addView(image, new FrameLayout.LayoutParams(-1, -1));
        TextView orderLabel = text(current ? "当前视频" : String.format(Locale.ROOT, "%02d", order),
                current ? 10 : 11, Color.WHITE, true);
        orderLabel.setGravity(Gravity.CENTER);
        orderLabel.setPadding(dp(6), 0, dp(6), 0);
        orderLabel.setBackground(shape(current ? 0xFF2563EB : 0xC9233149, 10));
        FrameLayout.LayoutParams orderBounds = new FrameLayout.LayoutParams(-2, dp(22), Gravity.LEFT | Gravity.BOTTOM);
        orderBounds.setMargins(dp(4), 0, 0, dp(4));
        cover.addView(orderLabel, orderBounds);
        card.addView(cover, new LinearLayout.LayoutParams(dp(112), dp(63)));
        registerThumbnailTarget(image, track);

        LinearLayout info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        info.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams infoBounds = new LinearLayout.LayoutParams(0, -1, 1);
        infoBounds.leftMargin = dp(10);
        card.addView(info, infoBounds);
        TextView itemTitle = text(track.title == null || track.title.isEmpty() ? "本地视频" : track.title,
                14, current ? BLUE : INK, current);
        itemTitle.setMaxLines(2);
        itemTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
        itemTitle.setBreakStrategy(android.text.Layout.BREAK_STRATEGY_HIGH_QUALITY);
        info.addView(itemTitle, new LinearLayout.LayoutParams(-1, 0, 1));
        String creator = track.author == null || track.author.isEmpty() ? "本地视频" : track.author;
        String date = date(track.uploadTime);
        String detail = creator + (date.isEmpty() ? "" : " · " + date);
        if (track.views >= 0) detail += " · " + count(track.views) + " 播放";
        TextView itemMeta = text(detail, 11, MUTED, false);
        itemMeta.setSingleLine();
        itemMeta.setEllipsize(android.text.TextUtils.TruncateAt.END);
        info.addView(itemMeta, new LinearLayout.LayoutParams(-1, dp(20)));

        card.setContentDescription((track.title == null ? "本地视频" : track.title) + "，" + creator +
                (current ? "，当前视频" : "，播放队列第 " + order + " 条"));
        card.setOnClickListener(view -> selectQueuedItem(index));
        return card;
    }

    private void selectQueuedItem(int index) {
        if (controller == null || index < 0 || index >= controller.getMediaItemCount()) return;
        controller.seekTo(index, C.TIME_UNSET);
        hasStartedCurrent = true;
        controller.play();
        updateCurrentDetails(index);
        if (poster != null) poster.setVisibility(View.GONE);
        updatePlaybackUi();
        renderRecommendations();
    }

    private void loadCurrentPoster() {
        if (poster == null || queue == null) return;
        PlaybackQueue.Track track = trackAt(controller == null ? queue.startIndex : controller.getCurrentMediaItemIndex());
        if (track == null) return;
        poster.setVisibility(audioOnly || hasStartedCurrent ? View.GONE : View.VISIBLE);
        registerThumbnailTarget(poster, track);
        loadThumbnail(poster, track);
    }

    private String thumbnailKey(PlaybackQueue.Track track) {
        return track.uri + "|" + track.size + "|" + track.modified;
    }

    private void registerThumbnailTarget(ImageView image, PlaybackQueue.Track track) {
        String key = thumbnailKey(track);
        image.setTag(new ThumbnailRef(key, track));
    }

    private void loadVisibleQueueThumbnails() {
        if (recommendations == null) return;
        android.graphics.Rect visible = new android.graphics.Rect();
        for (int i = 0; i < recommendations.getChildCount(); i++) {
            View row = recommendations.getChildAt(i);
            if (!(row instanceof ViewGroup) || !row.getGlobalVisibleRect(visible)) continue;
            View cover = ((ViewGroup) row).getChildAt(0);
            if (!(cover instanceof ViewGroup)) continue;
            View child = ((ViewGroup) cover).getChildAt(0);
            if (!(child instanceof ImageView)) continue;
            Object tag = child.getTag();
            if (tag instanceof ThumbnailRef) loadThumbnail((ImageView) child, ((ThumbnailRef) tag).track);
        }
    }

    private void loadThumbnail(ImageView image, PlaybackQueue.Track track) {
        if (destroyed) return;
        String key = thumbnailKey(track);
        Bitmap cached = thumbnailCache.get(key);
        if (cached != null) { image.setImageBitmap(cached); return; }
        if (thumbnailFailures.contains(key)) return;
        android.graphics.Rect visible = new android.graphics.Rect();
        if (!image.getGlobalVisibleRect(visible)) return;
        image.setImageDrawable(null);
        synchronized (thumbnailJobs) {
            if (!thumbnailJobs.contains(key) && thumbnailJobs.size() >= 8) return;
            synchronized (thumbnailTargets) {
                ArrayList<WeakReference<ImageView>> targets = thumbnailTargets.get(key);
                if (targets == null) { targets = new ArrayList<>(); thumbnailTargets.put(key, targets); }
                targets.removeIf(reference -> reference.get() == null);
                targets.add(new WeakReference<>(image));
            }
            if (!thumbnailJobs.add(key)) return;
        }
        try {
            thumbnails.execute(() -> {
                Bitmap bitmap = null;
                try {
                    String cacheName = Fingerprints.full(() -> new ByteArrayInputStream(key.getBytes(java.nio.charset.StandardCharsets.UTF_8)), () -> false);
                    File cachedFile = new File(new File(getCacheDir(), "covers"), cacheName + ".jpg");
                    bitmap = BitmapFactory.decodeFile(cachedFile.getPath());
                    if (bitmap == null) bitmap = extractFrame(track.uri);
                    if (bitmap != null && !destroyed) thumbnailCache.put(key, bitmap);
                } catch (Exception ignored) {
                } finally { thumbnailJobs.remove(key); }
                if (bitmap == null) thumbnailFailures.add(key);
                Bitmap result = bitmap;
                ui.post(() -> {
                    synchronized (thumbnailTargets) {
                        ArrayList<WeakReference<ImageView>> targets = thumbnailTargets.remove(key);
                        if (targets == null || result == null || destroyed) return;
                        targets.removeIf(reference -> {
                            ImageView target = reference.get();
                            if (target == null) return true;
                            Object tag = target.getTag();
                            if (tag instanceof ThumbnailRef && key.equals(((ThumbnailRef) tag).key)) target.setImageBitmap(result);
                            return false;
                        });
                    }
                });
            });
        } catch (java.util.concurrent.RejectedExecutionException ignored) {
            thumbnailJobs.remove(key);
            synchronized (thumbnailTargets) { thumbnailTargets.remove(key); }
        }
    }

    private void showPlayerSettings() {
        if (settingsDialog != null && settingsDialog.isShowing()) return;
        Dialog dialog = new Dialog(this);
        settingsDialog = dialog;
        dialog.setOnDismissListener(ignored -> {
            if (settingsDialog == dialog) { settingsDialog = null; settingsSheet = null; }
            updatePictureInPictureParams();
        });
        ScrollView scroll = new ScrollView(this);
        LinearLayout sheet = new LinearLayout(this);
        settingsSheet = sheet;
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setPadding(dp(20), dp(16), dp(20), dp(24));
        sheet.setBackground(shape(Color.WHITE, 24));
        scroll.addView(sheet, new ScrollView.LayoutParams(-1, -2));

        LinearLayout heading = new LinearLayout(this);
        heading.setGravity(Gravity.CENTER_VERTICAL);
        TextView headingText = text("播放设置", 19, INK, true);
        heading.addView(headingText, new LinearLayout.LayoutParams(0, dp(44), 1));
        TextView close = text("完成", 13, BLUE, true);
        close.setGravity(Gravity.CENTER);
        close.setPadding(dp(12), 0, dp(12), 0);
        close.setBackground(shape(0xFFEAF1FF, 16));
        heading.addView(close, new LinearLayout.LayoutParams(-2, dp(44)));
        close.setOnClickListener(view -> dialog.dismiss());
        sheet.addView(heading);

        addSettingHeading(sheet, "播放顺序");
        addChoiceRow(sheet, new String[]{"顺序播放", "随机播放"},
                (controller != null ? controller.getShuffleModeEnabled() : PlaybackService.shuffleEnabled(this)) ? 1 : 0,
                selected -> setShuffle(selected == 1));
        addSettingHeading(sheet, "播放完成后");
        addChoiceRow(sheet, new String[]{"播完停止", "列表循环", "单条循环"}, repeatSelection(),
                selected -> setRepeatMode(selected == 0 ? Player.REPEAT_MODE_OFF
                        : selected == 1 ? Player.REPEAT_MODE_ALL : Player.REPEAT_MODE_ONE));
        addSettingHeading(sheet, "播放速度");
        final float[] speeds = new float[]{0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f};
        float activeSpeed = controller == null ? PlaybackService.playbackSpeed(this)
                : controller.getPlaybackParameters().speed;
        String[] speedLabels = new String[speeds.length];
        int activeSpeedIndex = 2;
        for (int i = 0; i < speeds.length; i++) {
            speedLabels[i] = speedLabel(speeds[i]);
            if (Math.abs(speeds[i] - activeSpeed) < 0.02f) activeSpeedIndex = i;
        }
        addChoiceGrid(sheet, speedLabels, activeSpeedIndex, selected -> {
            if (controller != null) controller.setPlaybackSpeed(speeds[selected]);
            PlaybackService.savePlaybackSpeed(this, speeds[selected]);
            updatePlaybackSummary();
        }, 3);
        addSettingHeading(sheet, "画面");
        addChoiceRow(sheet, new String[]{"视频画面", "仅音频"}, audioOnly ? 1 : 0,
                selected -> setAudioOnly(selected == 1));
        addChoiceRow(sheet, new String[]{"适应画面", "填满屏幕"}, isFit ? 0 : 1,
                selected -> setFit(selected == 0));
        addSettingHeading(sheet, "后台播放");
        addChoiceRow(sheet, new String[]{"切换应用时暂停", "自动进入画中画"}, autoPip ? 1 : 0,
                selected -> setAutoPip(selected == 1));
        TextView pipHelp = text("开启后，播放视频时切换应用或返回桌面会进入系统画中画。无需悬浮窗权限；若无效，请在系统设置中允许本应用使用画中画。", 11, MUTED, false);
        pipHelp.setPadding(dp(4), dp(2), dp(4), dp(8));
        sheet.addView(pipHelp, new LinearLayout.LayoutParams(-1, -2));

        dialog.setContentView(scroll);
        dialog.setCanceledOnTouchOutside(true);
        dialog.show();
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            resizeSettingsSheet();
            window.setGravity(Gravity.BOTTOM);
            WindowManager.LayoutParams attributes = window.getAttributes();
            attributes.dimAmount = 0.28f;
            window.setAttributes(attributes);
            window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        }
    }

    private void resizeSettingsSheet() {
        if (settingsDialog == null || settingsSheet == null || !settingsDialog.isShowing()) return;
        Window window = settingsDialog.getWindow();
        if (window == null) return;
        android.util.DisplayMetrics metrics = getResources().getDisplayMetrics();
        settingsSheet.measure(View.MeasureSpec.makeMeasureSpec(metrics.widthPixels, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        window.setLayout(-1, Math.min(settingsSheet.getMeasuredHeight(), (int) (metrics.heightPixels * 0.86f)));
    }

    private void addSettingHeading(LinearLayout sheet, String caption) {
        TextView heading = text(caption, 13, MUTED, true);
        heading.setPadding(dp(2), dp(15), dp(2), dp(8));
        sheet.addView(heading, new LinearLayout.LayoutParams(-1, -2));
    }

    private int repeatSelection() {
        int mode = controller == null ? repeatMode : controller.getRepeatMode();
        return mode == Player.REPEAT_MODE_ALL ? 1 : mode == Player.REPEAT_MODE_ONE ? 2 : 0;
    }

    private void addChoiceRow(LinearLayout parent, String[] labels, int selected, IntConsumer onSelected) {
        addChoiceGrid(parent, labels, selected, onSelected, labels.length);
    }

    private void addChoiceGrid(LinearLayout parent, String[] labels, int selected,
            IntConsumer onSelected, int columns) {
        LinearLayout row = null;
        ArrayList<TextView> buttons = new ArrayList<>();
        for (int i = 0; i < labels.length; i++) {
            if (row == null || i % columns == 0) {
                row = new LinearLayout(this);
                row.setGravity(Gravity.CENTER_VERTICAL);
                LinearLayout.LayoutParams rowBounds = new LinearLayout.LayoutParams(-1, dp(44));
                rowBounds.bottomMargin = dp(6);
                parent.addView(row, rowBounds);
            }
            final int choice = i;
            TextView button = text(labels[i], 12, selected == i ? BLUE : INK, selected == i);
            button.setGravity(Gravity.CENTER);
            button.setMinHeight(dp(44));
            setChoiceStyle(button, selected == i, labels[i]);
            LinearLayout.LayoutParams itemBounds = new LinearLayout.LayoutParams(0, dp(44), 1);
            itemBounds.setMargins(dp(3), 0, dp(3), 0);
            row.addView(button, itemBounds);
            buttons.add(button);
            button.setOnClickListener(view -> {
                onSelected.accept(choice);
                for (int j = 0; j < buttons.size(); j++) setChoiceStyle(buttons.get(j), j == choice, labels[j]);
            });
        }
    }

    private void setChoiceStyle(TextView button, boolean selected, String label) {
        button.setTextColor(selected ? BLUE : INK);
        button.setTypeface(null, selected ? Typeface.BOLD : Typeface.NORMAL);
        GradientDrawable background = shape(selected ? 0xFFEAF1FF : 0xFFF5F7FB, 14);
        background.setStroke(dp(selected ? 1.5f : 1f), selected ? 0xFF8CB4FF : 0xFFE1E7F0);
        button.setBackground(background);
        button.setContentDescription(label + (selected ? "，当前选择" : ""));
    }

    private String speedLabel(float speed) {
        String value = speed == (long) speed ? String.format(Locale.ROOT, "%.0f", speed)
                : String.format(Locale.ROOT, "%.2f", speed).replaceAll("0+$", "").replaceAll("\\.$", "");
        return value + "×";
    }

    private Bitmap extractFrame(String uri) throws Exception {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(getApplicationContext(), Uri.parse(uri));
            String rawDuration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            long duration = rawDuration == null ? 0 : Long.parseLong(rawDuration);
            long time = duration <= 0 ? 1000000L : (long) (duration * 0.35) * 1000L;
            if (Build.VERSION.SDK_INT >= 27)
                return retriever.getScaledFrameAtTime(time, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 360, 203);
            Bitmap frame = retriever.getFrameAtTime(time, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
            if (frame == null) return null;
            float ratio = Math.min(360f / frame.getWidth(), 203f / frame.getHeight());
            Bitmap scaled = Bitmap.createScaledBitmap(frame, Math.max(1, Math.round(frame.getWidth() * ratio)),
                    Math.max(1, Math.round(frame.getHeight() * ratio)), true);
            if (scaled != frame) frame.recycle();
            return scaled;
        } finally { retriever.release(); }
    }

    private void togglePlay() {
        if (controller == null) return;
        if (controller.isPlaying()) controller.pause();
        else {
            hasStartedCurrent = true;
            if (poster != null) poster.setVisibility(View.GONE);
            if (controller.getPlaybackState() == Player.STATE_ENDED) controller.seekTo(0);
            controller.play();
        }
        updatePlaybackUi();
        setControlsVisible(true);
    }

    private void seekRelativeItem(int delta) {
        if (controller == null) return;
        boolean wasPlaying = controller.getPlayWhenReady();
        boolean failed = controller.getPlayerError() != null;
        if (!PlaybackNavigation.move(controller, delta)) return;
        if (failed) controller.prepare();
        hasStartedCurrent = wasPlaying;
        updateCurrentDetails(controller.getCurrentMediaItemIndex());
        if (hasStartedCurrent && poster != null) poster.setVisibility(View.GONE);
        else loadCurrentPoster();
        updatePlaybackUi();
        renderRecommendations();
    }

    private void setAudioOnly(boolean enabled) {
        audioOnly = enabled;
        PlaybackService.setAudioOnly(this, enabled);
        applyAudioOnly();
        updatePlaybackSummary();
    }

    private void applyAudioOnly() {
        if (playerView == null) return;
        playerView.setVisibility(audioOnly ? View.GONE : View.VISIBLE);
        audioCard.setVisibility(audioOnly ? View.VISIBLE : View.GONE);
        poster.setVisibility(audioOnly || hasStartedCurrent ? View.GONE : View.VISIBLE);
        if (controller != null) {
            TrackSelectionParameters parameters = controller.getTrackSelectionParameters().buildUpon()
                    .setTrackTypeDisabled(C.TRACK_TYPE_VIDEO, audioOnly).build();
            controller.setTrackSelectionParameters(parameters);
        }
    }

    private void setShuffle(boolean enabled) {
        if (controller != null) controller.setShuffleModeEnabled(enabled);
        int repeat = controller == null ? repeatMode : controller.getRepeatMode();
        PlaybackService.saveMode(this, repeat, enabled);
        updatePlaybackSummary();
        renderRecommendations();
    }

    private void setRepeatMode(int mode) {
        repeatMode = mode;
        if (controller != null) controller.setRepeatMode(mode);
        PlaybackService.saveMode(this, mode, PlaybackService.shuffleEnabled(this));
        updatePlaybackSummary();
        renderRecommendations();
    }

    private void setFit(boolean fit) {
        isFit = fit;
        PlaybackService.saveFitMode(this, fit);
        if (playerView != null) playerView.setResizeMode(isFit
                ? AspectRatioFrameLayout.RESIZE_MODE_FIT : AspectRatioFrameLayout.RESIZE_MODE_ZOOM);
        updatePosterScale();
        updatePlaybackSummary();
    }

    private void updatePlaybackSummary() {
        if (playbackSummaryButton == null) return;
        boolean shuffle = controller == null ? PlaybackService.shuffleEnabled(this) : controller.getShuffleModeEnabled();
        int repeat = controller == null ? repeatMode : controller.getRepeatMode();
        float speed = controller == null ? PlaybackService.playbackSpeed(this)
                : controller.getPlaybackParameters().speed;
        String repeatLabel = repeat == Player.REPEAT_MODE_ONE ? "单条循环"
                : repeat == Player.REPEAT_MODE_ALL ? "列表循环" : "播完停止";
        if (modeCaption != null) modeCaption.setText((shuffle ? "随机播放" : "顺序播放") + " · " + repeatLabel
                + " · " + speedLabel(speed) + " · " + (isFit ? "适应画面" : "填满屏幕"));
        if (audioModeButton != null) {
            audioModeButton.setText(audioOnly ? "视频" : "音频");
            audioModeButton.setContentDescription(audioOnly ? "切换视频播放" : "切换仅音频播放");
            audioModeButton.setTextColor(audioOnly ? BLUE : INK);
            audioModeButton.setBackground(shape(audioOnly ? 0xFFEAF1FF : 0xFFF5F7FB, 14));
        }
        playbackSummaryButton.setContentDescription("播放设置：" + (shuffle ? "随机播放" : "顺序播放")
                + "，" + repeatLabel + "，速度 " + speedLabel(speed)
                + (audioOnly ? "，仅音频" : "，视频画面"));
    }

    private void updateTransportAvailability() {
        if (controller == null || previousButton == null) return;
        boolean previousAvailable = controller.hasPreviousMediaItem() || controller.getCurrentPosition() > 3000;
        previousButton.setEnabled(previousAvailable);
        previousButton.setAlpha(previousAvailable ? 1f : 0.45f);
        boolean nextAvailable = controller.hasNextMediaItem();
        nextButton.setEnabled(nextAvailable);
        nextButton.setAlpha(nextAvailable ? 1f : 0.45f);
        fullPrevious.setEnabled(previousAvailable);
        fullPrevious.setAlpha(previousAvailable ? 1f : 0.45f);
        fullNext.setEnabled(nextAvailable);
        fullNext.setAlpha(nextAvailable ? 1f : 0.45f);
    }

    private void setControlsVisible(boolean visible) {
        if (controls == null) return;
        controlsVisible = visible;
        updateOverlayVisibility();
        ui.removeCallbacks(hideControls);
        if (visible && controller != null && controller.isPlaying()) ui.postDelayed(hideControls, 3500);
    }

    private void setTouchLocked(boolean locked) {
        touchLocked = fullscreen && locked;
        lockButton.setText(touchLocked ? "解锁" : "锁定");
        lockButton.setContentDescription(touchLocked ? "解锁全屏触控" : "锁定全屏触控");
        setControlsVisible(true);
        updatePlaybackUi();
    }

    private void updateOverlayVisibility() {
        boolean pip = isInPictureInPictureMode();
        controls.setVisibility(controlsVisible && !touchLocked && !pip ? View.VISIBLE : View.GONE);
        backButton.setVisibility(controlsVisible && !touchLocked && !pip ? View.VISIBLE : View.GONE);
        fullscreenTitle.setVisibility(fullscreen && controlsVisible && !touchLocked && !pip ? View.VISIBLE : View.GONE);
        lockButton.setVisibility(fullscreen && !pip && (controlsVisible || touchLocked) ? View.VISIBLE : View.GONE);
        lockButton.setText(touchLocked ? "解锁" : "锁定");
        lockButton.setContentDescription(touchLocked ? "解锁全屏触控" : "锁定全屏触控");
        pipButton.setVisibility(controlsVisible && !touchLocked && !pip ? View.VISIBLE : View.GONE);
        fullTransport.setVisibility(fullscreen ? View.VISIBLE : View.GONE);
    }

    private PictureInPictureParams floatingParams() {
        VideoSize size = controller == null ? VideoSize.UNKNOWN : controller.getVideoSize();
        float ratio = size.width > 0 && size.height > 0 ? size.width * size.pixelWidthHeightRatio / size.height : 16f / 9f;
        ratio = Math.max(1f / 2.39f, Math.min(2.39f, ratio));
        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder()
                .setAspectRatio(new Rational(Math.round(ratio * 1000), 1000));
        if (Build.VERSION.SDK_INT >= 31) builder.setAutoEnterEnabled(shouldAutoEnterPip());
        return builder.build();
    }

    private boolean shouldAutoEnterPip() {
        if (!autoPip || audioOnly || controller == null || !controller.isConnected()
                || isFinishing() || isInPictureInPictureMode()
                || (settingsDialog != null && settingsDialog.isShowing())) return false;
        if (controller.isPlaying()) return true;
        return controller.getPlayWhenReady() && controller.getPlaybackState() == Player.STATE_BUFFERING;
    }

    private void updatePictureInPictureParams() {
        if (Build.VERSION.SDK_INT < 26 || !getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) return;
        try { setPictureInPictureParams(floatingParams()); }
        catch (IllegalStateException | IllegalArgumentException ignored) { }
    }

    private void setAutoPip(boolean enabled) {
        autoPip = enabled;
        getSharedPreferences("player_settings", MODE_PRIVATE).edit().putBoolean("auto_pip", enabled).apply();
        updatePictureInPictureParams();
    }

    private void enterFloatingPlayback() {
        if (!getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE) || audioOnly) {
            Toast.makeText(this, audioOnly ? "请先切回视频模式" : "此设备不支持画中画", Toast.LENGTH_SHORT).show();
            return;
        }
        if (settingsDialog != null) settingsDialog.dismiss();
        try {
            if (!enterPictureInPictureMode(floatingParams()))
                Toast.makeText(this, "浮窗未开启，请检查系统画中画权限", Toast.LENGTH_LONG).show();
        } catch (IllegalStateException | IllegalArgumentException error) {
            Toast.makeText(this, "无法开启浮窗，请检查系统画中画权限", Toast.LENGTH_LONG).show();
        }
    }

    @Override public void onPictureInPictureModeChanged(boolean inPip, Configuration configuration) {
        super.onPictureInPictureModeChanged(inPip, configuration);
        if (inPip) {
            pipSession = true;
            touchLocked = false;
            root.setPadding(0, 0, 0, 0);
            detailScroll.setVisibility(View.GONE);
            stage.setLayoutParams(new LinearLayout.LayoutParams(-1, -1));
            gestureFeedback.setVisibility(View.GONE);
        } else if (!isFinishing()) {
            if (fullscreen) applyFullscreenLayout();
            else {
                detailScroll.setVisibility(View.VISIBLE);
                stage.setLayoutParams(new LinearLayout.LayoutParams(-1, -2));
                showSystemBars();
            }
        }
        updatePlaybackUi();
        updatePosterScale();
        root.requestApplyInsets();
        root.requestLayout();
    }

    private void setFullscreen(boolean enabled) {
        if (fullscreen == enabled || root == null) return;
        fullscreen = enabled;
        if (!enabled) touchLocked = false;
        updateOverlayVisibility();
        updatePosterScale();
        if (enabled) {
            fullScreenButton.setText("×");
            fullScreenButton.setContentDescription("退出全屏");
            detailScroll.setVisibility(View.GONE);
            root.setBackgroundColor(Color.BLACK);
            root.setPadding(0, 0, 0, 0);
            stage.setLayoutParams(new LinearLayout.LayoutParams(-1, -1));
            if (Build.VERSION.SDK_INT >= 28) setFullscreenCutout(true);
            getWindow().setStatusBarColor(Color.BLACK);
            getWindow().setNavigationBarColor(Color.BLACK);
            hideSystemBars();
            updateFullscreenOrientation(controller == null ? VideoSize.UNKNOWN : controller.getVideoSize());
        } else {
            fullScreenButton.setText("⛶");
            fullScreenButton.setContentDescription("进入全屏");
            detailScroll.setVisibility(View.VISIBLE);
            root.setBackgroundColor(0xFFF3F6FB);
            root.setPadding(0, 0, 0, 0);
            stage.setLayoutParams(new LinearLayout.LayoutParams(-1, -2));
            if (Build.VERSION.SDK_INT >= 28) setFullscreenCutout(false);
            getWindow().setStatusBarColor(0xFFF3F6FB);
            getWindow().setNavigationBarColor(0xFFF3F6FB);
            setRequestedOrientation(normalOrientation);
            showSystemBars();
        }
        root.requestApplyInsets();
        root.requestLayout();
    }

    private void applyFullscreenLayout() {
        updatePosterScale();
        detailScroll.setVisibility(View.GONE);
        root.setBackgroundColor(Color.BLACK);
        root.setPadding(0, 0, 0, 0);
        stage.setLayoutParams(new LinearLayout.LayoutParams(-1, -1));
        if (Build.VERSION.SDK_INT >= 28) setFullscreenCutout(true);
        updateFullscreenOrientation(controller == null ? VideoSize.UNKNOWN : controller.getVideoSize());
        hideSystemBars();
    }

    static int fullscreenOrientation(VideoSize size, int fallback) {
        if (size == null || size.width <= 0 || size.height <= 0) return fallback;
        return size.height >= size.width * size.pixelWidthHeightRatio
                ? ActivityInfo.SCREEN_ORIENTATION_PORTRAIT : ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE;
    }

    private void updatePosterScale() {
        if (poster != null) poster.setScaleType(fullscreen && isFit
                ? ImageView.ScaleType.FIT_CENTER : ImageView.ScaleType.CENTER_CROP);
    }

    private void updateFullscreenOrientation(VideoSize size) {
        int orientation = fullscreenOrientation(size, normalOrientation);
        if (getRequestedOrientation() != orientation) setRequestedOrientation(orientation);
    }

    @androidx.annotation.RequiresApi(28)
    private void setFullscreenCutout(boolean enabled) {
        WindowManager.LayoutParams attributes = getWindow().getAttributes();
        int mode = enabled ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES : initialCutoutMode;
        if (attributes.layoutInDisplayCutoutMode == mode) return;
        attributes.layoutInDisplayCutoutMode = mode;
        getWindow().setAttributes(attributes);
    }

    private void applyWindowStyle() {
        if (fullscreen) {
            getWindow().setStatusBarColor(Color.BLACK);
            getWindow().setNavigationBarColor(Color.BLACK);
            hideSystemBars();
        } else {
            getWindow().setStatusBarColor(0xFFF3F6FB);
            getWindow().setNavigationBarColor(0xFFF3F6FB);
            showSystemBars();
        }
    }

    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    private void showSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (stage != null) stage.requestLayout();
        if (root != null) {
            if (fullscreen) root.setPadding(0, 0, 0, 0);
            root.requestApplyInsets();
        }
        // Fullscreen rotation can finish after the settings button is tapped.
        // Re-measure the open sheet instead of keeping the old landscape bounds.
        resizeSettingsSheet();
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putBoolean("fullscreen", fullscreen);
        state.putInt("normal_orientation", normalOrientation);
        state.putInt("author_return_index", authorReturnIndex);
        state.putLong("author_return_position", authorReturnPosition);
    }

    private TextView text(String value, int size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value); view.setTextSize(size); view.setTextColor(color);
        view.setIncludeFontPadding(false);
        if (bold) view.setTypeface(null, Typeface.BOLD);
        return view;
    }

    private TextView action(String value, String description, int size) {
        TextView view = text(value, size, Color.WHITE, false);
        view.setGravity(Gravity.CENTER);
        view.setContentDescription(description);
        view.setFocusable(true);
        view.setClickable(true);
        view.setBackground(shape(Color.TRANSPARENT, 6));
        view.setOnTouchListener((target, event) -> {
            if (event.getActionMasked() == MotionEvent.ACTION_DOWN) target.setAlpha(.65f);
            else if (event.getActionMasked() == MotionEvent.ACTION_UP || event.getActionMasked() == MotionEvent.ACTION_CANCEL) target.setAlpha(1f);
            return false;
        });
        return view;
    }

    private TextView playerAction(String value, String description, boolean primary) {
        TextView view = text(value, primary ? 20 : 13, primary ? Color.WHITE : INK, true);
        view.setGravity(Gravity.CENTER);
        view.setContentDescription(description);
        view.setFocusable(true);
        view.setClickable(true);
        GradientDrawable background = shape(primary ? BLUE : 0xFFF5F7FB, 12);
        view.setBackground(background);
        view.setForeground(new android.graphics.drawable.RippleDrawable(
                android.content.res.ColorStateList.valueOf(0x183B82F6), null, shape(Color.WHITE, 12)));
        return view;
    }

    private GradientDrawable shape(int color, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color); drawable.setCornerRadius(dp(radius));
        return drawable;
    }

    private GradientDrawable outline(int color, int radius) {
        GradientDrawable drawable = shape(color, radius);
        drawable.setStroke(dp(1), 0xFFE1E8F2);
        return drawable;
    }

    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private String formatTime(long milliseconds) {
        if (milliseconds < 0 || milliseconds == C.TIME_UNSET) return "0:00";
        long total = milliseconds / 1000;
        return total >= 3600 ? String.format(Locale.ROOT, "%d:%02d:%02d", total / 3600, (total / 60) % 60, total % 60)
                : String.format(Locale.ROOT, "%d:%02d", total / 60, total % 60);
    }

    private String date(long time) {
        if (time <= 0) return "";
        return new SimpleDateFormat("yyyy/M/d", Locale.CHINA).format(new Date(time < 100000000000L ? time * 1000 : time));
    }

    private String count(long value) {
        return value >= 10000 ? String.format(Locale.CHINA, "%.1f万", value / 10000.0) : String.valueOf(value);
    }

    private static final class VideoStage extends FrameLayout {
        VideoStage(Activity activity) { super(activity); }
        @Override protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
            if (MeasureSpec.getMode(heightMeasureSpec) == MeasureSpec.EXACTLY) {
                super.onMeasure(widthMeasureSpec, heightMeasureSpec);
                return;
            }
            int width = MeasureSpec.getSize(widthMeasureSpec);
            int desiredHeight = Math.round(width * 9f / 16f);
            if (MeasureSpec.getMode(heightMeasureSpec) == MeasureSpec.AT_MOST)
                desiredHeight = Math.min(desiredHeight, MeasureSpec.getSize(heightMeasureSpec));
            super.onMeasure(widthMeasureSpec, MeasureSpec.makeMeasureSpec(desiredHeight, MeasureSpec.EXACTLY));
        }
    }

    @Override protected void onStart() {
        super.onStart();
        if (controller != null && (!controller.isConnected() || !queueId.equals(PlaybackQueueStore.activeId(this)))) {
            Intent restore = new Intent(this, PlaybackService.class).putExtra("queue_id", queueId).putExtra("autoplay", false);
            if (authorReturnIndex >= 0) restore.putExtra("restore_index", authorReturnIndex).putExtra("restore_position", authorReturnPosition);
            startService(restore);
            connectSession();
        }
        if (fullscreen) hideSystemBars(); else showSystemBars();
        if (playerView != null && controller != null) playerView.setPlayer(controller);
        if (controller != null) {
            ui.removeCallbacks(updateProgress);
            ui.post(updateProgress);
        }
    }

    @Override protected void onResume() {
        super.onResume();
        if (!isInPictureInPictureMode()) pipSession = false;
        updatePictureInPictureParams();
    }

    @Override protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (Build.VERSION.SDK_INT >= 31 || !shouldAutoEnterPip()) return;
        try { enterPictureInPictureMode(floatingParams()); }
        catch (IllegalStateException | IllegalArgumentException ignored) { }
    }

    @Override protected void onStop() {
        ui.removeCallbacks(updateProgress);
        if (pipSession && !isInPictureInPictureMode()) requestPlaybackStop();
        else if (!isInPictureInPictureMode() && controller != null && !audioOnly) controller.pause();
        if (playerView != null && !isInPictureInPictureMode()) playerView.setPlayer(null);
        super.onStop();
    }

    @Override protected void onDestroy() {
        if (settingsDialog != null) settingsDialog.dismiss();
        if (isFinishing()) requestPlaybackStop();
        if (screenBrightnessChanged) {
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            attributes.screenBrightness = initialScreenBrightness;
            getWindow().setAttributes(attributes);
        }
        if (Build.VERSION.SDK_INT >= 28) setFullscreenCutout(false);
        destroyed = true;
        ui.removeCallbacksAndMessages(null);
        thumbnails.shutdownNow();
        thumbnailCache.evictAll();
        thumbnailFailures.clear();
        synchronized (thumbnailTargets) { thumbnailTargets.clear(); }
        if (controllerFuture != null) MediaController.releaseFuture(controllerFuture);
        controller = null;
        super.onDestroy();
    }

    @Override public void onBackPressed() {
        if (touchLocked) { showGestureFeedback("已锁定，请先点右上角解锁"); return; }
        if (fullscreen) setFullscreen(false);
        else {
            requestPlaybackStop();
            finish();
        }
    }

    private void requestPlaybackStop() {
        if (stopRequested || queue == null) return;
        stopRequested = true;
        PlaybackService.requestStop(this, queueId);
    }
}
