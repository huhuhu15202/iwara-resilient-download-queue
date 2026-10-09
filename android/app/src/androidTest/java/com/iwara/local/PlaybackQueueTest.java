package com.iwara.local;

import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.view.View;
import android.view.ViewGroup;
import android.view.MotionEvent;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.media3.common.Player;
import androidx.media3.common.MediaItem;
import androidx.media3.common.VideoSize;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.ShuffleOrder.DefaultShuffleOrder;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import androidx.media3.ui.PlayerView;
import com.google.common.util.concurrent.ListenableFuture;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.File;
import java.io.FileOutputStream;
import android.graphics.Bitmap;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import static org.junit.Assert.*;

/** Device-side checks for the local queue snapshot and its process-recovery file. */
@RunWith(AndroidJUnit4.class)
public final class PlaybackQueueTest {
    @Test public void authorPageUsesAuthorQueueAndRestoresOriginalPlayer() throws Exception {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        String creator = "Author QA " + UUID.randomUUID();
        ArrayList<Uri> media = new ArrayList<>();
        ArrayList<LibraryDb.Video> videos = new ArrayList<>();
        LibraryDb db = new LibraryDb(context);
        Activity original = null, creatorPage = null, child = null;
        PlaybackQueue queue = null;
        boolean oldAudio = PlaybackService.audioOnly(context);
        try {
            PlaybackService.setAudioOnly(context, false);
            for (int i=0;i<3;i++) {
                Uri uri = importPlaybackAsset(instrumentation, "playback-portrait.mp4");
                media.add(uri);
                LibraryDb.Video video = video(uri.toString(), "Author fixture " + i, "");
                video.taskId = UUID.randomUUID().toString();
                video.author = i<2 ? creator : "Different QA author";
                videos.add(video);
                ContentValues catalogue = new ContentValues();
                catalogue.put("task_id",video.taskId); catalogue.put("title",video.title); catalogue.put("author",video.author);
                db.getWritableDatabase().insertOrThrow("catalogue",null,catalogue);
                ContentValues local = new ContentValues();
                local.put("uri",video.uri); local.put("name",video.title); local.put("task_id",video.taskId);
                db.getWritableDatabase().insertOrThrow("local_files",null,local);
            }
            queue = PlaybackQueue.snapshot(videos,videos.get(0).uri);
            PlaybackQueueStore.save(context,queue);
            original = instrumentation.startActivitySync(new Intent(context,PlayerActivity.class)
                    .putExtra("queue_id",queue.id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            Activity source = original;
            java.lang.reflect.Field controllerField = PlayerActivity.class.getDeclaredField("controller");controllerField.setAccessible(true);
            assertTrue(awaitControllerState(instrumentation, () -> {
                try { MediaController current=(MediaController)controllerField.get(source); return current!=null && current.isPlaying(); }
                catch(Exception error){throw new RuntimeException(error);}
            }));
            instrumentation.runOnMainSync(() -> {
                try { MediaController current=(MediaController)controllerField.get(source); current.pause(); current.seekTo(1,1000); }
                catch(Exception error){throw new RuntimeException(error);}
            });
            android.app.Instrumentation.ActivityMonitor authorMonitor = instrumentation.addMonitor(MainActivity.class.getName(),null,false);
            instrumentation.runOnMainSync(() -> findByDescription(source.getWindow().getDecorView(),"查看作者视频").performClick());
            creatorPage = instrumentation.waitForMonitorWithTimeout(authorMonitor,10000);
            instrumentation.removeMonitor(authorMonitor);
            assertNotNull("Author page must open",creatorPage);
            Activity authorActivity = creatorPage;
            java.lang.reflect.Field itemsField = MainActivity.class.getDeclaredField("items");
            itemsField.setAccessible(true);
            assertTrue("Author page must exclude other creators",awaitControllerState(instrumentation,()-> {
                try { return ((List<?>)itemsField.get(authorActivity)).size()==2; }
                catch(Exception error) { throw new RuntimeException(error); }
            }));
            captureUi(instrumentation,"author-library-v034");
            java.lang.reflect.Field gridField = MainActivity.class.getDeclaredField("grid");gridField.setAccessible(true);
            android.widget.GridView grid = (android.widget.GridView)gridField.get(creatorPage);
            android.app.Instrumentation.ActivityMonitor childMonitor = instrumentation.addMonitor(PlayerActivity.class.getName(),null,false);
            instrumentation.runOnMainSync(() -> grid.performItemClick(grid.getChildAt(0),0,0));
            child = instrumentation.waitForMonitorWithTimeout(childMonitor,10000);
            instrumentation.removeMonitor(childMonitor);
            assertNotNull("Author video must open the shared player",child);
            PlaybackQueue authorQueue = PlaybackQueueStore.load(context,child.getIntent().getStringExtra("queue_id"));
            assertEquals(2,authorQueue.tracks.size());
            for(PlaybackQueue.Track track:authorQueue.tracks)assertEquals(creator,track.author);
            Activity childActivity = child;
            instrumentation.runOnMainSync(childActivity::onBackPressed);
            instrumentation.waitForIdleSync();
            instrumentation.runOnMainSync(authorActivity::finish);
            instrumentation.waitForIdleSync();
            assertTrue("Returning through author page must reconnect original queue",awaitControllerState(instrumentation,()-> {
                try {
                    MediaController controller=(MediaController)controllerField.get(source);
                    return controller != null && controller.isConnected() && controller.getMediaItemCount()==3
                            && controller.getPlaybackState()==Player.STATE_READY && !controller.getPlayWhenReady()
                            && controller.getCurrentMediaItemIndex()==1 && Math.abs(controller.getCurrentPosition()-1000)<300;
                } catch(Exception error) { throw new RuntimeException(error); }
            }));
            captureUi(instrumentation,"player-author-return-v034");
        } finally {
            for(Activity activity:new Activity[]{child,creatorPage,original})if(activity!=null)instrumentation.runOnMainSync(activity::finish);
            context.stopService(new Intent(context,PlaybackService.class));
            for(LibraryDb.Video video:videos) {
                db.getWritableDatabase().delete("local_files","uri=?",new String[]{video.uri});
                db.getWritableDatabase().delete("catalogue","task_id=?",new String[]{video.taskId});
            }
            db.close();
            for(Uri uri:media)context.getContentResolver().delete(uri,null,null);
            if(queue!=null)PlaybackQueueStore.clear(context,queue.id);
            PlaybackService.setAudioOnly(context,oldAudio);
        }
    }
    @Test public void autoplayNoisyLockRecoveryAndFloatingWindow() throws Exception {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        Uri media = importPlaybackAsset(instrumentation, "playback-portrait.mp4");
        Uri secondMedia = importPlaybackAsset(instrumentation, "playback-portrait.mp4");
        PlaybackQueue queue = null;
        PlayerActivity page = null;
        ListenableFuture<MediaController> future = null;
        boolean oldAudio = PlaybackService.audioOnly(context);
        int oldRepeat = PlaybackService.repeatMode(context);
        boolean oldShuffle = PlaybackService.shuffleEnabled(context);
        try {
            PlaybackService.setAudioOnly(context, false);
            PlaybackService.saveMode(context, Player.REPEAT_MODE_ALL, false);
            ArrayList<LibraryDb.Video> videos = new ArrayList<>();
            videos.add(video(media.toString(), "First fixture", ""));
            videos.add(video(secondMedia.toString(), "Second fixture", ""));
            videos.add(video("content://media/external/video/media/999999999", "Missing fixture", ""));
            queue = PlaybackQueue.snapshot(videos, videos.get(0).uri);
            PlaybackQueueStore.save(context, queue);
            page = (PlayerActivity) instrumentation.startActivitySync(new Intent(context, PlayerActivity.class)
                    .putExtra("queue_id", queue.id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            PlayerActivity active = page;
            future = new MediaController.Builder(context, new SessionToken(context,
                    new android.content.ComponentName(context, PlaybackService.class))).buildAsync();
            MediaController controller = future.get(10, TimeUnit.SECONDS);
            assertTrue("Open must autoplay", awaitControllerState(instrumentation, controller::isPlaying));
            try (android.os.ParcelFileDescriptor command = instrumentation.getUiAutomation().executeShellCommand(
                    "su 0 am broadcast -a android.media.AUDIO_BECOMING_NOISY")) {
                java.io.FileInputStream input = new java.io.FileInputStream(command.getFileDescriptor());
                while (input.read(new byte[4096]) != -1) { }
            }
            assertTrue("Unplug headphones must pause", awaitControllerState(instrumentation, () -> !controller.getPlayWhenReady()));
            View decor = active.getWindow().getDecorView();
            instrumentation.runOnMainSync(() -> findByDescription(decor, "进入全屏").performClick());
            instrumentation.waitForIdleSync();
            assertNotNull(findByDescription(decor, "全屏播放下一条"));
            instrumentation.runOnMainSync(() -> findByDescription(decor, "全屏播放下一条").performClick());
            assertTrue(awaitControllerState(instrumentation, () -> controller.getCurrentMediaItemIndex() == 1));
            instrumentation.runOnMainSync(() -> findByDescription(decor, "全屏播放上一条").performClick());
            assertTrue(awaitControllerState(instrumentation, () -> controller.getCurrentMediaItemIndex() == 0));
            java.lang.reflect.Field surfaceField = PlayerActivity.class.getDeclaredField("playerView");
            surfaceField.setAccessible(true);
            View surface = (View)surfaceField.get(active);
            instrumentation.runOnMainSync(() -> {
                controller.seekTo(2000);
                findByDescription(decor, "锁定全屏触控").performClick();
                assertEquals(View.GONE, findByDescription(decor, "全屏播放下一条").getParent() instanceof View
                        ? ((View)findByDescription(decor, "全屏播放下一条").getParent().getParent()).getVisibility() : View.VISIBLE);
                long start = SystemClock.uptimeMillis();
                playerTouch(active, surface, MotionEvent.ACTION_DOWN, start, .2f, .4f);
                playerTouch(active, surface, MotionEvent.ACTION_MOVE, start, .8f, .4f);
                playerTouch(active, surface, MotionEvent.ACTION_UP, start, .8f, .4f);
                assertEquals(2000, controller.getCurrentPosition());
                active.onBackPressed();
                assertFalse(active.isFinishing());
                findByDescription(decor, "解锁全屏触控").performClick();
                controller.seekTo(2, 0); controller.prepare(); controller.play();
            });
            assertTrue("Missing file must report persistent failure", awaitControllerState(instrumentation, () -> controller.getPlayerError() != null));
            instrumentation.waitForIdleSync();
            assertEquals(View.VISIBLE, findByDescription(decor, "重试当前视频").getParent().getParent() instanceof View
                    ? ((View)findByDescription(decor, "重试当前视频").getParent().getParent()).getVisibility() : View.GONE);
            instrumentation.runOnMainSync(() -> findByDescription(decor, "跳过失败视频").performClick());
            assertTrue("Skipping failure must prepare and play next item", awaitControllerState(instrumentation, controller::isPlaying));
            int fullWidth = surface.getWidth();
            instrumentation.runOnMainSync(() -> findByDescription(decor, "进入浮动播放窗口").performClick());
            assertTrue("System PiP must open", awaitControllerState(instrumentation, active::isInPictureInPictureMode));
            assertTrue("PiP must keep playing", awaitControllerState(instrumentation, controller::isPlaying));
            assertTrue("PiP must hide app controls after transition", awaitControllerState(instrumentation, () ->
                    ((View)findByDescription(decor, "播放或暂停").getParent().getParent()).getVisibility() == View.GONE));
            assertTrue("Floating window must finish resizing", awaitControllerState(instrumentation,
                    () -> surface.getWidth() > 0 && surface.getWidth() < fullWidth));
            Thread.sleep(1200);
            captureUi(instrumentation, "player-floating-v034");
            instrumentation.runOnMainSync(active::finish);
            assertTrue("Closing the player should stop the manual PiP session", awaitControllerState(instrumentation,
                    () -> !controller.isPlaying()));
        } finally {
            if (page != null) { PlayerActivity close = page; instrumentation.runOnMainSync(close::finish); }
            if (future != null) { ListenableFuture<MediaController> release = future; instrumentation.runOnMainSync(() -> MediaController.releaseFuture(release)); }
            context.stopService(new Intent(context, PlaybackService.class));
            if (queue != null) PlaybackQueueStore.clear(context, queue.id);
            PlaybackService.setAudioOnly(context, oldAudio);
            PlaybackService.saveMode(context, oldRepeat, oldShuffle);
            context.getContentResolver().delete(media, null, null);
            context.getContentResolver().delete(secondMedia, null, null);
        }
    }
    private int playbackState(android.app.Instrumentation instrumentation, MediaController controller) {
        int[] state = new int[1];
        instrumentation.runOnMainSync(() -> state[0] = controller.getPlaybackState());
        return state[0];
    }

    private boolean isPlaying(android.app.Instrumentation instrumentation, MediaController controller) {
        boolean[] playing = new boolean[1];
        instrumentation.runOnMainSync(() -> playing[0] = controller.isPlaying());
        return playing[0];
    }

    private boolean awaitControllerState(android.app.Instrumentation instrumentation, BooleanSupplier check)
            throws InterruptedException {
        long deadline = SystemClock.elapsedRealtime() + 10000;
        boolean[] result = new boolean[1];
        do {
            instrumentation.runOnMainSync(() -> result[0] = check.getAsBoolean());
            if (result[0]) return true;
            Thread.sleep(30);
        } while (SystemClock.elapsedRealtime() < deadline);
        return false;
    }

    private long currentPosition(android.app.Instrumentation instrumentation, MediaController controller) {
        long[] value = new long[1];
        instrumentation.runOnMainSync(() -> value[0] = controller.getCurrentPosition());
        return value[0];
    }

    private long currentDuration(android.app.Instrumentation instrumentation, MediaController controller) {
        long[] value = new long[1];
        instrumentation.runOnMainSync(() -> value[0] = controller.getDuration());
        return value[0];
    }

    private View findByDescription(View view, String description) {
        if (description.equals(view.getContentDescription())) return view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                View match = findByDescription(group.getChildAt(i), description);
                if (match != null) return match;
            }
        }
        return null;
    }

    private View findByDescriptionPrefix(View view, String prefix) {
        CharSequence description = view.getContentDescription();
        if (description != null && description.toString().startsWith(prefix)) return view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                View match = findByDescriptionPrefix(group.getChildAt(i), prefix);
                if (match != null) return match;
            }
        }
        return null;
    }

    private boolean clickAccessibilityText(android.app.Instrumentation instrumentation, String label)
            throws InterruptedException {
        long deadline = SystemClock.elapsedRealtime() + 3000;
        while (SystemClock.elapsedRealtime() < deadline) {
            AccessibilityNodeInfo root = instrumentation.getUiAutomation().getRootInActiveWindow();
            if (root != null) {
                List<AccessibilityNodeInfo> matches = root.findAccessibilityNodeInfosByText(label);
                for (AccessibilityNodeInfo node : matches) {
                    if (!node.isVisibleToUser()) {
                        node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.getId());
                        continue;
                    }
                    if (node.isClickable() && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
                }
            }
            Thread.sleep(50);
        }
        return false;
    }

    private boolean hasAccessibilityText(android.app.Instrumentation instrumentation, String label)
            throws InterruptedException {
        long deadline = SystemClock.elapsedRealtime() + 3000;
        while (SystemClock.elapsedRealtime() < deadline) {
            AccessibilityNodeInfo root = instrumentation.getUiAutomation().getRootInActiveWindow();
            if (root != null && !root.findAccessibilityNodeInfosByText(label).isEmpty()) return true;
            Thread.sleep(50);
        }
        return false;
    }

    private void captureUi(android.app.Instrumentation instrumentation, String name) throws Exception {
        if (!"true".equals(InstrumentationRegistry.getArguments().getString("capture_player_ui"))) return;
        instrumentation.waitForIdleSync();
        Thread.sleep(250);
        Bitmap screenshot = instrumentation.getUiAutomation().takeScreenshot();
        if (screenshot == null) return;
        File output = new File(instrumentation.getTargetContext().getExternalFilesDir(null), name + ".png");
        try (FileOutputStream stream = new FileOutputStream(output)) {
            screenshot.compress(Bitmap.CompressFormat.PNG, 100, stream);
        } finally { screenshot.recycle(); }
    }

    private void swipe(View target, float x, float fromY, float toY) {
        long downTime = SystemClock.uptimeMillis();
        MotionEvent down = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, x, fromY, 0);
        target.dispatchTouchEvent(down);
        down.recycle();
        for (int step = 1; step <= 4; step++) {
            float fraction = step / 4f;
            long eventTime = downTime + step * 35L;
            MotionEvent move = MotionEvent.obtain(downTime, eventTime, MotionEvent.ACTION_MOVE,
                    x, fromY + (toY - fromY) * fraction, 0);
            target.dispatchTouchEvent(move);
            move.recycle();
        }
        long upTime = downTime + 150L;
        MotionEvent up = MotionEvent.obtain(downTime, upTime, MotionEvent.ACTION_UP, x, toY, 0);
        target.dispatchTouchEvent(up);
        up.recycle();
    }

    private void playerTouch(Activity activity, View surface, int action, long start, float x, float y) {
        MotionEvent event=MotionEvent.obtain(start,SystemClock.uptimeMillis(),action,
                surface.getWidth()*x,surface.getHeight()*y,0);
        activity.dispatchTouchEvent(event);event.recycle();
    }

    private void dispatchDoubleTap(android.app.Instrumentation instrumentation, Activity activity, View surface,
                                   float x, float y) throws InterruptedException {
        instrumentation.runOnMainSync(() -> {
            long start=SystemClock.uptimeMillis();
            playerTouch(activity,surface,MotionEvent.ACTION_DOWN,start,x,y);
            playerTouch(activity,surface,MotionEvent.ACTION_UP,start,x,y);
        });
        Thread.sleep(90);
        instrumentation.runOnMainSync(() -> {
            long start=SystemClock.uptimeMillis();
            playerTouch(activity,surface,MotionEvent.ACTION_DOWN,start,x,y);
            playerTouch(activity,surface,MotionEvent.ACTION_UP,start,x,y);
        });
        Thread.sleep(350); // Let GestureDetector finish the double-tap sequence before the next assertion.
    }

    private boolean hasSelectedChoice(android.app.Instrumentation instrumentation, String label)
            throws InterruptedException {
        long deadline = SystemClock.elapsedRealtime() + 3000;
        do {
            AccessibilityNodeInfo root = instrumentation.getUiAutomation().getRootInActiveWindow();
            if (root != null) for (AccessibilityNodeInfo node : root.findAccessibilityNodeInfosByText(label)) {
                CharSequence description = node.getContentDescription();
                if (description != null && description.toString().equals(label + "，当前选择")) return true;
            }
            Thread.sleep(50);
        } while (SystemClock.elapsedRealtime() < deadline);
        return false;
    }

    private List<LibraryDb.Video> fixture() {
        List<LibraryDb.Video> videos = new ArrayList<>();
        videos.add(video("content://media/external/video/media/701", "first", "a"));
        videos.add(video("content://media/external/video/media/702", "selected", "b"));
        videos.add(video("content://media/external/video/media/703", "last", "c"));
        return videos;
    }

    private LibraryDb.Video video(String uri, String title, String hashSuffix) {
        LibraryDb.Video video = new LibraryDb.Video();
        video.uri = uri;
        video.title = title;
        video.author = "fixture-author";
        StringBuilder hash = new StringBuilder(64);
        for (int i = 0; i < 64; i++) hash.append(hashSuffix);
        video.sha256 = hash.toString();
        video.taskId = "fixture-" + title;
        return video;
    }

    @Test public void snapshotKeepsVisibleOrderAndSelectedStart() throws Exception {
        List<LibraryDb.Video> videos = fixture();
        videos.add(videos.get(1));
        PlaybackQueue queue = PlaybackQueue.snapshot(videos, videos.get(1).uri);

        assertEquals(3, queue.tracks.size());
        assertEquals(1, queue.startIndex);
        assertEquals("first", queue.tracks.get(0).title);
        assertEquals("selected", queue.tracks.get(1).title);
        assertEquals("last", queue.tracks.get(2).title);
        StringBuilder expectedHash = new StringBuilder(64);
        for (int i = 0; i < 64; i++) expectedHash.append('b');
        assertEquals("sha256:" + expectedHash, queue.tracks.get(1).mediaId);

        PlaybackQueue restored = PlaybackQueue.fromJson(queue.toJson());
        assertEquals(queue.id, restored.id);
        assertEquals(queue.startIndex, restored.startIndex);
        assertEquals(Arrays.asList(
                "content://media/external/video/media/701",
                "content://media/external/video/media/702",
                "content://media/external/video/media/703"), Arrays.asList(
                restored.tracks.get(0).uri, restored.tracks.get(1).uri, restored.tracks.get(2).uri));
    }

    @Test public void queueStoreRestoresAndClearsOnlyItsSnapshot() throws Exception {
        android.content.Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        PlaybackQueue queue = PlaybackQueue.snapshot(fixture(), "content://media/external/video/media/702");
        PlaybackQueueStore.save(context, queue);
        try {
            assertEquals(queue.id, PlaybackQueueStore.activeId(context));
            PlaybackQueue restored = PlaybackQueueStore.load(context, queue.id);
            assertEquals(queue.tracks.size(), restored.tracks.size());
            assertEquals(1, restored.startIndex);
            assertEquals(queue.tracks.get(1).mediaId, restored.tracks.get(1).mediaId);
        } finally {
            PlaybackQueueStore.clear(context, queue.id);
        }
        assertEquals("", PlaybackQueueStore.activeId(context));
    }

    @Test public void clearingOldQueueDoesNotEraseReplacementQueue() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        PlaybackQueue oldQueue = PlaybackQueue.snapshot(fixture(), "content://media/external/video/media/701");
        PlaybackQueue replacement = PlaybackQueue.snapshot(fixture(), "content://media/external/video/media/703");
        PlaybackQueueStore.save(context, oldQueue);
        PlaybackQueueStore.save(context, replacement);
        try {
            PlaybackQueueStore.clear(context, oldQueue.id);
            assertEquals("Finishing an old player must not clear the active queue pointer",
                    replacement.id, PlaybackQueueStore.activeId(context));
            assertEquals("The replacement queue must still be readable", replacement.id,
                    PlaybackQueueStore.load(context, replacement.id).id);
        } finally {
            PlaybackQueueStore.clear(context, replacement.id);
        }
    }

    @Test public void horizontalNavigationKeepsGlassSurfaceAndRenderer() throws Exception {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(
                new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            instrumentation.waitForIdleSync();
            java.lang.reflect.Field glassField = MainActivity.class.getDeclaredField("navGlass");
            java.lang.reflect.Field gridField = MainActivity.class.getDeclaredField("grid");
            java.lang.reflect.Field randomField = MainActivity.class.getDeclaredField("randomOrder");
            java.lang.reflect.Field rendererField = GlassSurface.class.getDeclaredField("renderer");
            glassField.setAccessible(true); gridField.setAccessible(true);
            randomField.setAccessible(true); rendererField.setAccessible(true);
            GlassSurface glass = (GlassSurface) glassField.get(activity);
            Object renderer = rendererField.get(glass);
            View grid = (View) gridField.get(activity);
            for (int direction : new int[]{-1, 1, -1, 1}) {
                instrumentation.runOnMainSync(() -> {
                    int[] location = new int[2]; grid.getLocationOnScreen(location);
                    float fromX = location[0] + grid.getWidth() * (direction < 0 ? .85f : .15f);
                    float toX = location[0] + grid.getWidth() * (direction < 0 ? .15f : .85f);
                    float y = location[1] + grid.getHeight() * .35f;
                    long start = SystemClock.uptimeMillis();
                    for (int step = 0; step <= 5; step++) {
                        int action = step == 0 ? MotionEvent.ACTION_DOWN : step == 5 ? MotionEvent.ACTION_UP : MotionEvent.ACTION_MOVE;
                        MotionEvent event = MotionEvent.obtain(start, start + step * 30L, action,
                                fromX + (toX - fromX) * step / 5f, y, 0);
                        activity.dispatchTouchEvent(event); event.recycle();
                    }
                });
                instrumentation.waitForIdleSync();
                assertEquals("Horizontal swipe should change the library tab", direction < 0, randomField.getBoolean(activity));
                assertSame("Switching tabs must retain the glass view", glass, glassField.get(activity));
                assertSame("Switching tabs must retain the shader renderer", renderer, rendererField.get(glass));
            }
            captureUi(instrumentation, "library-navigation-v032");
        } finally { instrumentation.runOnMainSync(activity::finish); }
    }

    @Test public void fullscreenOrientationUsesDisplayedVideoSize() {
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,
                PlayerActivity.fullscreenOrientation(new VideoSize(180, 320), ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE,
                PlayerActivity.fullscreenOrientation(new VideoSize(320, 180), ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,
                PlayerActivity.fullscreenOrientation(VideoSize.UNKNOWN, ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,
                PlayerActivity.fullscreenOrientation(new VideoSize(320, 320), ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
    }

    private Uri importPlaybackAsset(android.app.Instrumentation instrumentation, String asset) throws Exception {
        Context context = instrumentation.getTargetContext();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Video.Media.DISPLAY_NAME, UUID.randomUUID() + ".mp4");
        values.put(MediaStore.Video.Media.MIME_TYPE, "video/mp4");
        values.put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/IwaraPlaybackSmoke/");
        values.put(MediaStore.Video.Media.IS_PENDING, 1);
        Uri uri = context.getContentResolver().insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values);
        assertNotNull(uri);
        try {
            try (InputStream input = instrumentation.getContext().getAssets().open(asset);
                    OutputStream output = context.getContentResolver().openOutputStream(uri, "w")) {
                assertNotNull(output);
                byte[] buffer = new byte[8192]; int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            }
            values.clear(); values.put(MediaStore.Video.Media.IS_PENDING, 0);
            context.getContentResolver().update(uri, values, null, null);
            return uri;
        } catch (Exception error) { context.getContentResolver().delete(uri, null, null); throw error; }
    }

    @Test public void portraitFullscreenAndHorizontalSeekFollowPlaybackFlow() throws Exception {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        ArrayList<Uri> media = new ArrayList<>();
        PlayerActivity page = null;
        ListenableFuture<MediaController> future = null;
        PlaybackQueue queue = null;
        boolean previousAudio = PlaybackService.audioOnly(context);
        boolean previousShuffle = PlaybackService.shuffleEnabled(context);
        int previousRepeat = PlaybackService.repeatMode(context);
        try {
            media.add(importPlaybackAsset(instrumentation, "playback-portrait.mp4"));
            media.add(importPlaybackAsset(instrumentation, "playback-smoke.mp4"));
            ArrayList<LibraryDb.Video> videos = new ArrayList<>();
            for (int i=0;i<media.size();i++) videos.add(video(media.get(i).toString(), "Orientation fixture " + i, ""));
            queue = PlaybackQueue.snapshot(videos, videos.get(0).uri);
            PlaybackQueueStore.save(context, queue);
            PlaybackService.setAudioOnly(context, false);
            PlaybackService.saveMode(context, Player.REPEAT_MODE_OFF, false);
            page = (PlayerActivity) instrumentation.startActivitySync(new Intent(context, PlayerActivity.class)
                    .putExtra("queue_id", queue.id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            PlayerActivity active = page;
            future = new MediaController.Builder(context,
                    new SessionToken(context, new android.content.ComponentName(context, PlaybackService.class))).buildAsync();
            MediaController controller = future.get(10, TimeUnit.SECONDS);
            assertTrue("Portrait video should prepare with a real video size", awaitControllerState(instrumentation,
                    () -> controller.getPlaybackState() == Player.STATE_READY && controller.getVideoSize().height > controller.getVideoSize().width));
            assertTrue("Entering the page must autoplay", awaitControllerState(instrumentation, controller::isPlaying));
            instrumentation.runOnMainSync(controller::pause);
            View fullscreen = findByDescription(page.getWindow().getDecorView(), "进入全屏");
            instrumentation.runOnMainSync(fullscreen::performClick);
            assertTrue("Portrait content must enter portrait fullscreen", awaitControllerState(instrumentation,
                    () -> active.getRequestedOrientation() == ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                            && active.getResources().getConfiguration().orientation == android.content.res.Configuration.ORIENTATION_PORTRAIT));
            ViewGroup root = (ViewGroup)((ViewGroup)page.findViewById(android.R.id.content)).getChildAt(0);
            assertTrue("Portrait fullscreen layout should settle", awaitControllerState(instrumentation,
                    () -> root.getHeight()>0 && root.getChildAt(0).getHeight()==root.getHeight()));
            instrumentation.runOnMainSync(() -> {
                assertEquals(View.GONE, root.getChildAt(1).getVisibility());
                assertEquals(root.getHeight(), root.getChildAt(0).getHeight());
                assertEquals(root.getWidth(), root.getChildAt(0).getWidth());
            });
            View fullscreenHeading=findByDescription(page.getWindow().getDecorView(),"当前播放标题");
            View lockControl=findByDescription(page.getWindow().getDecorView(),"锁定全屏触控");
            View floatingControl=findByDescription(page.getWindow().getDecorView(),"进入浮动播放窗口");
            assertNotNull("Fullscreen should identify the currently playing title",fullscreenHeading);
            assertNotNull("Fullscreen touch lock must be reachable",lockControl);
            assertNotNull("Fullscreen floating playback must be reachable",floatingControl);
            assertEquals("The current title should be visible while fullscreen controls are shown",View.VISIBLE,fullscreenHeading.getVisibility());
            int minTouchTarget=Math.round(48*context.getResources().getDisplayMetrics().density);
            instrumentation.runOnMainSync(()->{
                assertTrue("Touch lock should have a comfortable touch target",lockControl.getWidth()>=minTouchTarget
                        && lockControl.getHeight()>=minTouchTarget);
                assertTrue("Floating playback should have a comfortable touch target",floatingControl.getWidth()>=minTouchTarget
                        && floatingControl.getHeight()>=minTouchTarget);
            });
            java.lang.reflect.Field surfaceField = PlayerActivity.class.getDeclaredField("playerView");
            surfaceField.setAccessible(true);
            View surface = (View) surfaceField.get(page);
            java.lang.reflect.Field pageControllerField=PlayerActivity.class.getDeclaredField("controller");
            pageControllerField.setAccessible(true);
            MediaController gestureController=(MediaController)pageControllerField.get(page);
            assertNotNull(gestureController);
            for (int direction : new int[]{1, -1, 1}) {
                instrumentation.runOnMainSync(() -> gestureController.seekTo(3500));
                instrumentation.runOnMainSync(() -> {
                    long start = SystemClock.uptimeMillis();
                    float from = surface.getWidth() * .5f, to = surface.getWidth() * (direction > 0 ? .8f : .2f);
                    float y = surface.getHeight() * .5f;
                    MotionEvent down = MotionEvent.obtain(start,start,MotionEvent.ACTION_DOWN,from,y,0);
                    active.dispatchTouchEvent(down); down.recycle();
                    MotionEvent move = MotionEvent.obtain(start,start+90,MotionEvent.ACTION_MOVE,to,y,0);
                    active.dispatchTouchEvent(move); move.recycle();
                    assertEquals("Dragging should only preview until release",3500,gestureController.getCurrentPosition());
                    MotionEvent up = MotionEvent.obtain(start,start+140,MotionEvent.ACTION_UP,to,y,0);
                    active.dispatchTouchEvent(up); up.recycle();
                    assertTrue("Release should seek in the swipe direction", direction>0
                            ? gestureController.getCurrentPosition()>3500 : gestureController.getCurrentPosition()<3500);
                    assertFalse("Seeking must keep a paused video paused",gestureController.isPlaying());
                });
            }
            instrumentation.runOnMainSync(() -> {
                gestureController.seekTo(3500);
                long start=SystemClock.uptimeMillis(); float y=surface.getHeight()*.5f;
                for (int action : new int[]{MotionEvent.ACTION_DOWN,MotionEvent.ACTION_MOVE,MotionEvent.ACTION_CANCEL}) {
                    MotionEvent event=MotionEvent.obtain(start,start+(action==0?0:100),action,
                            surface.getWidth()*(action==0?.3f:.8f),y,0);
                    active.dispatchTouchEvent(event);event.recycle();
                }
                assertEquals("Cancelled swipe must not change progress",3500,gestureController.getCurrentPosition());
            });
            java.lang.reflect.Field controlsField=PlayerActivity.class.getDeclaredField("controlsVisible");
            controlsField.setAccessible(true);
            for(int tap=0;tap<2;tap++) {
                boolean before=controlsField.getBoolean(active);
                instrumentation.runOnMainSync(()->{
                    long start=SystemClock.uptimeMillis();
                    playerTouch(active,surface,MotionEvent.ACTION_DOWN,start,.2f,.25f);
                    playerTouch(active,surface,MotionEvent.ACTION_UP,start,.2f,.25f);
                });
                assertTrue("Single tap must toggle controls",awaitControllerState(instrumentation,()->{
                    try{return controlsField.getBoolean(active)!=before;}
                    catch(Exception error){throw new RuntimeException(error);}
                }));
            }
            assertNull("The dedicated 10-second rewind button should be removed",
                    findByDescription(page.getWindow().getDecorView(),"快退 10 秒"));
            assertNull("The dedicated 10-second forward button should be removed",
                    findByDescription(page.getWindow().getDecorView(),"快进 10 秒"));
            assertNotNull("Timeline seeking should remain available",findByDescription(page.getWindow().getDecorView(),"播放进度"));

            instrumentation.runOnMainSync(()->gestureController.seekTo(3500));
            dispatchDoubleTap(instrumentation,active,surface,.5f,.5f);
            assertTrue("Double tapping the central play affordance must start playback once",
                    awaitControllerState(instrumentation,gestureController::isPlaying));
            dispatchDoubleTap(instrumentation,active,surface,.2f,.3f);
            assertTrue("Double tapping the left side must pause instead of seeking",awaitControllerState(instrumentation,
                    ()->!gestureController.isPlaying()));
            assertTrue("A left-side double tap must preserve the playhead",Math.abs(currentPosition(instrumentation,gestureController)-3500)<700);
            dispatchDoubleTap(instrumentation,active,surface,.8f,.3f);
            assertTrue("Double tapping the right side must resume instead of seeking",awaitControllerState(instrumentation,
                    gestureController::isPlaying));
            assertTrue("A right-side double tap must preserve the playhead",Math.abs(currentPosition(instrumentation,gestureController)-3500)<900);
            instrumentation.runOnMainSync(gestureController::pause);
            float[] savedSpeed=new float[1];
            long pressStart=SystemClock.uptimeMillis();
            instrumentation.runOnMainSync(()->{
                savedSpeed[0]=gestureController.getPlaybackParameters().speed;
                playerTouch(active,surface,MotionEvent.ACTION_DOWN,pressStart,.5f,.5f);
            });
            Thread.sleep(650);
            assertTrue("Long press should temporarily use 2x",awaitControllerState(instrumentation,
                    ()->gestureController.getPlaybackParameters().speed==2f));
            java.lang.reflect.Field feedbackField=PlayerActivity.class.getDeclaredField("gestureFeedback");
            feedbackField.setAccessible(true);
            instrumentation.runOnMainSync(()->{
                try {
                    TextView speedFeedback=(TextView)feedbackField.get(active);
                    assertEquals("Long-press acceleration should use a compact in-player badge", "2×", speedFeedback.getText());
                    assertTrue("The 2x badge should use small text", speedFeedback.getTextSize() <= 12.1f * active.getResources().getDisplayMetrics().scaledDensity);
                    assertTrue("The 2x badge background should be nearly transparent",
                            speedFeedback.getBackground() instanceof android.graphics.drawable.GradientDrawable
                                    && ((((android.graphics.drawable.GradientDrawable)speedFeedback.getBackground())
                                            .getColor().getDefaultColor() >>> 24) & 0xFF) <= 0x30);
                } catch (Exception error) { throw new RuntimeException(error); }
            });
            instrumentation.runOnMainSync(()->{
                playerTouch(active,surface,MotionEvent.ACTION_UP,pressStart,.5f,.5f);
                assertEquals("Releasing long press restores speed",savedSpeed[0],gestureController.getPlaybackParameters().speed,.001f);
                try { assertEquals("The 2x badge should disappear on release",View.GONE,((TextView)feedbackField.get(active)).getVisibility()); }
                catch (Exception error) { throw new RuntimeException(error); }
                assertFalse("Long press on the central play icon must not accidentally start playback",gestureController.isPlaying());
                gestureController.seekTo(1000);gestureController.play();
            });
            assertTrue("Playback should start after explicit play",awaitControllerState(instrumentation,gestureController::isPlaying));
            instrumentation.runOnMainSync(()->{
                long start=SystemClock.uptimeMillis();
                playerTouch(active,surface,MotionEvent.ACTION_DOWN,start,.2f,.25f);
                playerTouch(active,surface,MotionEvent.ACTION_MOVE,start,.6f,.25f);
                playerTouch(active,surface,MotionEvent.ACTION_UP,start,.6f,.25f);
                assertTrue("Seeking a playing video must keep playback active",gestureController.getPlayWhenReady());
                gestureController.pause();controller.seekTo(1,0);
            });
            assertTrue("Switching to landscape content must update fullscreen orientation", awaitControllerState(instrumentation,
                    () -> active.getRequestedOrientation()==ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                            && active.getResources().getConfiguration().orientation==android.content.res.Configuration.ORIENTATION_LANDSCAPE));
            instrumentation.runOnMainSync(() -> controller.seekTo(0,0));
            assertTrue("Returning to portrait content must restore portrait fullscreen", awaitControllerState(instrumentation,
                    () -> active.getRequestedOrientation()==ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                            && active.getResources().getConfiguration().orientation==android.content.res.Configuration.ORIENTATION_PORTRAIT));
            Thread.sleep(800);
            if(!controlsField.getBoolean(active)) {
                instrumentation.runOnMainSync(()->{
                    long start=SystemClock.uptimeMillis();
                    playerTouch(active,surface,MotionEvent.ACTION_DOWN,start,.2f,.25f);
                    playerTouch(active,surface,MotionEvent.ACTION_UP,start,.2f,.25f);
                });
                assertTrue("Portrait fullscreen controls should be reachable",awaitControllerState(instrumentation,()->{
                    try{return controlsField.getBoolean(active);}
                    catch(Exception error){throw new RuntimeException(error);}
                }));
            }
            captureUi(instrumentation,"player-portrait-fullscreen-v033");
            instrumentation.runOnMainSync(active::onBackPressed);
            assertFalse("Back from fullscreen returns to details, not closes the page",active.isFinishing());
            instrumentation.runOnMainSync(active::onBackPressed);
            assertTrue("Second back exits the watch page",active.isFinishing());
        } finally {
            if(page!=null){PlayerActivity close=page;instrumentation.runOnMainSync(close::finish);}
            if(future!=null){ListenableFuture<MediaController> close=future;instrumentation.runOnMainSync(()->MediaController.releaseFuture(close));}
            context.stopService(new Intent(context,PlaybackService.class));
            PlaybackService.setAudioOnly(context,previousAudio);
            PlaybackService.saveMode(context,previousRepeat,previousShuffle);
            if(queue!=null)PlaybackQueueStore.clear(context,queue.id);
            for(Uri uri:media)context.getContentResolver().delete(uri,null,null);
        }
    }

    @Test public void autoPictureInPictureCanBeEnabledForHomeTransition() throws Exception {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        if (!context.getPackageManager().hasSystemFeature(android.content.pm.PackageManager.FEATURE_PICTURE_IN_PICTURE)) return;
        Uri media = importPlaybackAsset(instrumentation, "playback-portrait.mp4");
        PlaybackQueue queue = null;
        PlayerActivity page = null;
        ListenableFuture<MediaController> future = null;
        android.content.SharedPreferences preferences = context.getSharedPreferences("player_settings", Context.MODE_PRIVATE);
        boolean oldAutoPip = preferences.getBoolean("auto_pip", false);
        boolean oldAudio = PlaybackService.audioOnly(context);
        try {
            PlaybackService.setAudioOnly(context, false);
            queue = PlaybackQueue.snapshot(java.util.Collections.singletonList(video(media.toString(), "Auto PiP fixture", "")), media.toString());
            PlaybackQueueStore.save(context, queue);
            page = (PlayerActivity) instrumentation.startActivitySync(new Intent(context, PlayerActivity.class)
                    .putExtra("queue_id", queue.id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            PlayerActivity active = page;
            future = new MediaController.Builder(context, new SessionToken(context,
                    new android.content.ComponentName(context, PlaybackService.class))).buildAsync();
            MediaController controller = future.get(10, TimeUnit.SECONDS);
            assertTrue("The player should autoplay before testing automatic PiP", awaitControllerState(instrumentation, controller::isPlaying));
            View decor = active.getWindow().getDecorView();
            instrumentation.runOnMainSync(() -> findByDescription(decor, "播放设置").performClick());
            assertTrue("Player settings must offer an optional automatic PiP choice",
                    clickAccessibilityText(instrumentation, "自动进入画中画"));
            assertTrue("Automatic PiP preference should be saved", preferences.getBoolean("auto_pip", false));
            assertTrue("Settings sheet should be dismissible", clickAccessibilityText(instrumentation, "完成"));
            java.lang.reflect.Field dialogField = PlayerActivity.class.getDeclaredField("settingsDialog");
            dialogField.setAccessible(true);
            assertTrue("Settings sheet should close before backgrounding", awaitControllerState(instrumentation, () -> {
                try { android.app.Dialog dialog = (android.app.Dialog)dialogField.get(active); return dialog == null || !dialog.isShowing(); }
                catch (Exception error) { throw new RuntimeException(error); }
            }));

            try (android.os.ParcelFileDescriptor command = instrumentation.getUiAutomation().executeShellCommand("input keyevent KEYCODE_HOME")) {
                java.io.FileInputStream input = new java.io.FileInputStream(command.getFileDescriptor());
                while (input.read(new byte[4096]) != -1) { }
            }
            assertTrue("Leaving the playback page for Home should enter PiP when enabled",
                    awaitControllerState(instrumentation, active::isInPictureInPictureMode));
            assertTrue("Playback should continue inside automatic PiP", awaitControllerState(instrumentation, controller::isPlaying));
            long positionInPip = currentPosition(instrumentation, controller);
            Thread.sleep(700);
            assertTrue("The playhead should advance while the PiP window is active",
                    currentPosition(instrumentation, controller) > positionInPip);
            instrumentation.runOnMainSync(active::finish);
            assertTrue("Closing automatic PiP should stop playback", awaitControllerState(instrumentation,
                    () -> !controller.isPlaying()));
        } finally {
            if (page != null) { PlayerActivity close = page; instrumentation.runOnMainSync(close::finish); }
            if (future != null) { ListenableFuture<MediaController> release = future; instrumentation.runOnMainSync(() -> MediaController.releaseFuture(release)); }
            context.stopService(new Intent(context, PlaybackService.class));
            if (queue != null) PlaybackQueueStore.clear(context, queue.id);
            PlaybackService.setAudioOnly(context, oldAudio);
            preferences.edit().putBoolean("auto_pip", oldAutoPip).commit();
            context.getContentResolver().delete(media, null, null);
        }
    }

    @Test public void expandedQueueBuildsOnlyABoundedWindow() throws Exception {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        Activity library = null, player = null;
        PlaybackQueue queue = null;
        try {
            ArrayList<LibraryDb.Video> videos = new ArrayList<>();
            for (int i = 0; i < 2000; i++) videos.add(video("content://fixture/large/" + i,
                    "Large queue fixture " + i, "x"));
            queue = PlaybackQueue.snapshot(videos, videos.get(1000).uri);
            PlaybackQueueStore.save(context, queue);
            Intent intent = new Intent(context, PlayerActivity.class).putExtra("queue_id", queue.id)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            player = instrumentation.startActivitySync(intent);
            assertNotNull("Player should open a large playlist", player);
            java.lang.reflect.Field recommendationsField = PlayerActivity.class.getDeclaredField("recommendations");
            recommendationsField.setAccessible(true);
            LinearLayout rows = (LinearLayout) recommendationsField.get(player);
            assertTrue("Scrollable queue should render only its bounded initial set", rows.getChildCount() <= 63);
            instrumentation.waitForIdleSync();
            assertTrue("Expanding a 2,000 item queue must keep card construction bounded", rows.getChildCount() <= 63);
            java.lang.reflect.Field scrollField = PlayerActivity.class.getDeclaredField("queueScroll");
            scrollField.setAccessible(true);
            android.widget.ScrollView scroll = (android.widget.ScrollView) scrollField.get(player);
            java.lang.reflect.Field startField = PlayerActivity.class.getDeclaredField("queueWindowStart");
            java.lang.reflect.Field endField = PlayerActivity.class.getDeclaredField("queueWindowEnd");
            startField.setAccessible(true);
            endField.setAccessible(true);
            int initialStart = startField.getInt(player);
            int initialEnd = endField.getInt(player);
            Activity playerForScroll = player;
            assertTrue("Expanded rows should complete layout before scrolling", awaitControllerState(instrumentation,
                    () -> rows.getHeight() > scroll.getHeight() * 2));
            instrumentation.runOnMainSync(() -> scroll.scrollTo(0, scroll.getChildAt(0).getHeight()));
            assertTrue("The next batch should be available", awaitControllerState(instrumentation,
                    () -> { try { return endField.getInt(playerForScroll) > initialEnd; }
                        catch (Exception error) { throw new RuntimeException(error); } }));
            assertTrue("Scrolling down should append the next queue batch (start=" + initialStart + ", end=" + initialEnd
                    + "→" + endField.getInt(player) + ", scroll=" + scroll.getScrollY() + "/"
                    + (scroll.getChildAt(0) == null ? 0 : scroll.getChildAt(0).getHeight()) + ")",
                    endField.getInt(player) > initialEnd);
            assertTrue("Queue card views must remain bounded while scrolling down", rows.getChildCount() <= 111);
            int afterDownStart = startField.getInt(player);
            instrumentation.runOnMainSync(() -> scroll.scrollTo(0, 0));
            assertTrue("The previous batch should be available", awaitControllerState(instrumentation,
                    () -> { try { return startField.getInt(playerForScroll) < afterDownStart; }
                        catch (Exception error) { throw new RuntimeException(error); } }));
            assertTrue("Scrolling back up should prepend the previous queue batch", startField.getInt(player) < afterDownStart);
            assertTrue("Queue card views must remain bounded while scrolling up", rows.getChildCount() <= 111);
            assertTrue("The expanded queue should move its retained window as you scroll", startField.getInt(player) < initialStart);
            java.lang.reflect.Field thumbnailsField = PlayerActivity.class.getDeclaredField("thumbnailJobs");
            thumbnailsField.setAccessible(true);
            java.util.Set<?> jobs = (java.util.Set<?>) thumbnailsField.get(player);
            assertTrue("Off-screen rows must not start a burst of frame extraction", jobs.size() <= 8);
        } finally {
            context.stopService(new Intent(context, PlaybackService.class));
            if (player != null) { Activity close = player; instrumentation.runOnMainSync(close::finish); }
            if (library != null) { Activity close = library; instrumentation.runOnMainSync(close::finish); }
            if (queue != null) PlaybackQueueStore.clear(context, queue.id);
        }
    }

    @Test public void staleSelectionIsRejected() {
        try {
            PlaybackQueue.snapshot(fixture(), "content://media/external/video/media/999");
            fail("A selected item outside the visible snapshot must not silently change");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("所选视频"));
        }
    }

    @Test public void queueNavigationFollowsShuffleRepeatAndPauseState() {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        ExoPlayer[] player = new ExoPlayer[1];
        int[] shuffledNext = new int[1];
        int[] shuffledActual = new int[1];
        int[] repeatedNext = new int[1];
        int[] repeatedActual = new int[1];
        boolean[] preservedPaused = new boolean[1];
        boolean[] stoppedAtEnd = new boolean[1];
        instrumentation.runOnMainSync(() -> {
            player[0] = new ExoPlayer.Builder(context).build();
            List<MediaItem> media = new ArrayList<>();
            for (int i = 0; i < 4; i++) media.add(new MediaItem.Builder()
                    .setMediaId("navigation-" + i).setUri("file:///navigation-" + i + ".mp4").build());
            player[0].setMediaItems(media, 0, 0);
            player[0].setShuffleOrder(new DefaultShuffleOrder(new int[]{2, 0, 3, 1}, 7L));
            player[0].setShuffleModeEnabled(true);
            player[0].seekTo(0, 0);
            shuffledNext[0] = player[0].getNextMediaItemIndex();
            PlaybackNavigation.move(player[0], 1);
            shuffledActual[0] = player[0].getCurrentMediaItemIndex();
            preservedPaused[0] = !player[0].getPlayWhenReady();

            player[0].setShuffleModeEnabled(false);
            player[0].setRepeatMode(Player.REPEAT_MODE_ALL);
            player[0].seekTo(3, 0);
            repeatedNext[0] = player[0].getNextMediaItemIndex();
            PlaybackNavigation.move(player[0], 1);
            repeatedActual[0] = player[0].getCurrentMediaItemIndex();

            player[0].setRepeatMode(Player.REPEAT_MODE_OFF);
            player[0].seekTo(3, 0);
            stoppedAtEnd[0] = !PlaybackNavigation.move(player[0], 1);
            player[0].release();
        });
        assertEquals("Shuffle navigation must use Media3's shuffled successor, not index + 1",
                3, shuffledNext[0]);
        assertEquals(shuffledNext[0], shuffledActual[0]);
        assertTrue("Skipping while paused must not start playback", preservedPaused[0]);
        assertEquals("List-repeat should wrap from the final item to the first", 0, repeatedNext[0]);
        assertEquals(repeatedNext[0], repeatedActual[0]);
        assertTrue("Stop-after-list mode must not wrap at the end", stoppedAtEnd[0]);
    }

    @Test public void mediaSessionPlaysLocalH264AacFixtureToEnd() throws Exception {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        String previousQueue = PlaybackQueueStore.activeId(context);
        boolean previousAudioOnly = PlaybackService.audioOnly(context);
        int previousRepeat = PlaybackService.repeatMode(context);
        boolean previousShuffle = PlaybackService.shuffleEnabled(context);
        float previousSpeed = PlaybackService.playbackSpeed(context);
        boolean previousFit = PlaybackService.fitMode(context);
        String mediaId = "task:player-smoke-" + UUID.randomUUID();
        Uri mediaUri = null;
        Activity libraryActivity = null;
        Activity foregroundActivity = null;
        PlaybackQueue queue = null;
        ListenableFuture<MediaController> future = null;
        MediaController controller = null;
        try {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Video.Media.DISPLAY_NAME, "iwara-player-smoke-" + UUID.randomUUID() + ".mp4");
            values.put(MediaStore.Video.Media.MIME_TYPE, "video/mp4");
            values.put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/IwaraPlaybackSmoke/");
            values.put(MediaStore.Video.Media.IS_PENDING, 1);
            mediaUri = context.getContentResolver().insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values);
            assertNotNull("Could not create an isolated MediaStore fixture", mediaUri);
            try (InputStream input = instrumentation.getContext().getAssets().open("playback-smoke.mp4");
                 OutputStream output = context.getContentResolver().openOutputStream(mediaUri, "w")) {
                assertNotNull("Could not open the test video for writing", output);
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            }
            values.clear();
            values.put(MediaStore.Video.Media.IS_PENDING, 0);
            context.getContentResolver().update(mediaUri, values, null, null);

            LibraryDb.Video video = new LibraryDb.Video();
            video.uri = mediaUri.toString();
            video.title = "Generated playback smoke test";
            video.author = "isolated test";
            video.taskId = mediaId;
            queue = PlaybackQueue.snapshot(Arrays.asList(video), video.uri);
            PlaybackQueueStore.save(context, queue);
            PlaybackService.setAudioOnly(context, false);
            PlaybackService.saveMode(context, Player.REPEAT_MODE_OFF, false);
            libraryActivity = instrumentation.startActivitySync(new Intent(context, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            Intent foreground = new Intent(context, PlayerActivity.class).putExtra("queue_id", queue.id);
            android.app.Instrumentation.ActivityMonitor firstPlayer = instrumentation.addMonitor(
                    PlayerActivity.class.getName(), null, false);
            Activity launchFromLibrary = libraryActivity;
            instrumentation.runOnMainSync(() -> launchFromLibrary.startActivity(foreground));
            foregroundActivity = instrumentation.waitForMonitorWithTimeout(firstPlayer, 10000);
            instrumentation.removeMonitor(firstPlayer);
            assertNotNull("The player page should open above the library in the same task", foregroundActivity);

            future = new MediaController.Builder(context,
                    new SessionToken(context, new android.content.ComponentName(context, PlaybackService.class))).buildAsync();
            controller = future.get(10, TimeUnit.SECONDS);
            MediaController connectedController = controller;
            int[] itemCount = new int[1];
            instrumentation.runOnMainSync(() -> {
                connectedController.pause();
                connectedController.seekTo(0);
                itemCount[0] = connectedController.getMediaItemCount();
                connectedController.setRepeatMode(Player.REPEAT_MODE_OFF);
                connectedController.setShuffleModeEnabled(false);
            });
            assertEquals(1, itemCount[0]);

            long readyDeadline = SystemClock.elapsedRealtime() + 10000;
            while (playbackState(instrumentation, controller) != Player.STATE_READY &&
                    playbackState(instrumentation, controller) != Player.STATE_ENDED &&
                    SystemClock.elapsedRealtime() < readyDeadline) Thread.sleep(50);
            int readyState = playbackState(instrumentation, controller);
            assertTrue("ExoPlayer never became ready (state=" + readyState + ")",
                    readyState == Player.STATE_READY || readyState == Player.STATE_ENDED);
            instrumentation.runOnMainSync(controller::pause);
            assertFalse("Manual pause must remain paused", isPlaying(instrumentation, controller));
            PlayerActivity page = (PlayerActivity) foregroundActivity;
            instrumentation.waitForIdleSync();
            View fullScreen = findByDescription(page.getWindow().getDecorView(), "进入全屏");
            assertNotNull("The watch page must expose fullscreen control", fullScreen);
            ViewGroup content = page.findViewById(android.R.id.content);
            ViewGroup layout = (ViewGroup) content.getChildAt(0);
            assertEquals("The detail page should contain the video stage and scrollable details", 2, layout.getChildCount());
            View stage = layout.getChildAt(0);
            int[] portraitSize = new int[2];
            instrumentation.runOnMainSync(() -> {
                portraitSize[0] = stage.getWidth();
                portraitSize[1] = stage.getHeight();
                assertEquals(View.VISIBLE, layout.getChildAt(1).getVisibility());
            });
            assertTrue("Portrait player stage should maintain 16:9, got " + portraitSize[0] + "x" + portraitSize[1],
                    Math.abs(portraitSize[1] - portraitSize[0] * 9 / 16) <= 3);
            captureUi(instrumentation, "player-portrait-v032");
            instrumentation.runOnMainSync(fullScreen::performClick);
            assertEquals("Fullscreen should rotate to landscape", ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE,
                    page.getRequestedOrientation());
            instrumentation.runOnMainSync(() -> assertEquals(View.GONE, layout.getChildAt(1).getVisibility()));
            assertTrue("Fullscreen rotation should complete", awaitControllerState(instrumentation,
                    () -> page.getResources().getConfiguration().orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE
                            && page.getResources().getDisplayMetrics().widthPixels > page.getResources().getDisplayMetrics().heightPixels));
            Thread.sleep(800); // Let the OS rotation animation finish before the visual capture.
            int[] fullscreenSize = new int[2];
            instrumentation.runOnMainSync(() -> {
                fullscreenSize[0] = stage.getWidth();
                fullscreenSize[1] = stage.getHeight();
                assertEquals("Fullscreen video stage must use the full available width", layout.getWidth(), stage.getWidth());
                assertEquals("Fullscreen video stage must use the full available height", layout.getHeight(), stage.getHeight());
                assertEquals("Fullscreen video stage must be horizontally centered", layout.getWidth() / 2,
                        stage.getLeft() + stage.getWidth() / 2);
            });
            assertTrue("Fullscreen stage should be a landscape viewport", fullscreenSize[0] > fullscreenSize[1]);
            captureUi(instrumentation, "player-fullscreen-v032");

            java.lang.reflect.Field playerViewField = PlayerActivity.class.getDeclaredField("playerView");
            playerViewField.setAccessible(true);
            PlayerView playerSurface = (PlayerView) playerViewField.get(page);
            java.lang.reflect.Field feedbackField = PlayerActivity.class.getDeclaredField("gestureFeedback");
            feedbackField.setAccessible(true);
            TextView feedback = (TextView) feedbackField.get(page);
            android.media.AudioManager audio = (android.media.AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            int originalVolume = audio.getStreamVolume(android.media.AudioManager.STREAM_MUSIC);
            android.view.WindowManager.LayoutParams originalWindowAttributes = page.getWindow().getAttributes();
            float originalBrightness = originalWindowAttributes.screenBrightness;
            instrumentation.runOnMainSync(() -> {
                feedback.setVisibility(View.GONE);
                swipe(playerSurface, playerSurface.getWidth() * .5f,
                        playerSurface.getHeight() * .75f, playerSurface.getHeight() * .25f);
            });
            assertEquals("A center vertical swipe must not monitor or alter brightness",
                    originalBrightness, page.getWindow().getAttributes().screenBrightness, .001f);
            assertEquals("A center vertical swipe must not monitor or alter volume", originalVolume,
                    audio.getStreamVolume(android.media.AudioManager.STREAM_MUSIC));
            assertEquals("A center vertical swipe must not show brightness/volume feedback", View.GONE,
                    feedback.getVisibility());
            instrumentation.runOnMainSync(() -> {
                float baseline = originalWindowAttributes.screenBrightness;
                if (baseline < 0f) baseline = android.provider.Settings.System.getInt(context.getContentResolver(),
                        android.provider.Settings.System.SCREEN_BRIGHTNESS, 128) / 255f;
                float from = playerSurface.getHeight() * (baseline >= .85f ? .25f : .75f);
                float to = playerSurface.getHeight() * (baseline >= .85f ? .75f : .25f);
                swipe(playerSurface, playerSurface.getWidth() * .2f, from, to);
            });
            assertTrue("Left-side vertical swipe should adjust screen brightness",
                    page.getWindow().getAttributes().screenBrightness >= 0f);
            assertTrue("Brightness gesture should show an on-screen value", feedback.getVisibility() == View.VISIBLE
                    && feedback.getText().toString().startsWith("亮度"));
            instrumentation.runOnMainSync(() -> {
                int maxVolume = audio.getStreamMaxVolume(android.media.AudioManager.STREAM_MUSIC);
                float from = playerSurface.getHeight() * (originalVolume >= maxVolume ? .25f : .75f);
                float to = playerSurface.getHeight() * (originalVolume >= maxVolume ? .75f : .25f);
                swipe(playerSurface, playerSurface.getWidth() * .8f, from, to);
            });
            assertTrue("Right-side vertical swipe should adjust media volume",
                    audio.getStreamVolume(android.media.AudioManager.STREAM_MUSIC) != originalVolume);
            assertTrue("Volume gesture should show an on-screen value", feedback.getText().toString().startsWith("音量"));
            instrumentation.runOnMainSync(() -> {
                audio.setStreamVolume(android.media.AudioManager.STREAM_MUSIC, originalVolume, 0);
                page.getWindow().setAttributes(originalWindowAttributes);
                try {
                    java.lang.reflect.Field changed = PlayerActivity.class.getDeclaredField("screenBrightnessChanged");
                    changed.setAccessible(true);
                    changed.setBoolean(page, false);
                } catch (Exception error) { throw new AssertionError(error); }
            });

            View exitFullscreen = findByDescription(page.getWindow().getDecorView(), "退出全屏");
            assertNotNull("Fullscreen must provide an exit control", exitFullscreen);
            instrumentation.runOnMainSync(exitFullscreen::performClick);
            assertEquals("Exiting fullscreen should restore portrait", ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,
                    page.getRequestedOrientation());
            instrumentation.runOnMainSync(() -> assertEquals(View.VISIBLE, layout.getChildAt(1).getVisibility()));

            assertTrue("Portrait layout must settle after fullscreen rotation", awaitControllerState(instrumentation,
                    () -> page.getResources().getDisplayMetrics().heightPixels >
                            page.getResources().getDisplayMetrics().widthPixels));
            instrumentation.waitForIdleSync();

            View playbackSettings = findByDescriptionPrefix(page.getWindow().getDecorView(), "播放设置：");
            assertNotNull("The player should provide a reachable settings button", playbackSettings);
            instrumentation.runOnMainSync(playbackSettings::performClick);
            instrumentation.waitForIdleSync();
            assertTrue("Settings panel should expose playback speed", hasAccessibilityText(instrumentation, "播放速度"));
            assertTrue("Settings panel should expose playback completion behavior", hasAccessibilityText(instrumentation, "播放完成后"));
            captureUi(instrumentation, "player-settings-v032");
            assertTrue("Shuffle must be selectable", clickAccessibilityText(instrumentation, "随机播放"));
            assertTrue("Shuffle selection must update the Media3 player",
                    awaitControllerState(instrumentation, connectedController::getShuffleModeEnabled));
            assertTrue("Shuffle choice must be saved", PlaybackService.shuffleEnabled(context));
            assertTrue("Repeat mode must be selectable", clickAccessibilityText(instrumentation, "列表循环"));
            assertTrue("List loop selection must update the Media3 player", awaitControllerState(instrumentation,
                    () -> connectedController.getRepeatMode() == Player.REPEAT_MODE_ALL));
            assertEquals(Player.REPEAT_MODE_ALL, PlaybackService.repeatMode(context));
            assertTrue("Playback speed must be selectable", clickAccessibilityText(instrumentation, "1.5×"));
            assertTrue("Playback speed selection must update Media3", awaitControllerState(instrumentation,
                    () -> Math.abs(connectedController.getPlaybackParameters().speed - 1.5f) < 0.01f));
            assertEquals(1.5f, PlaybackService.playbackSpeed(context), 0.01f);
            assertTrue("Audio-only mode must be selectable", clickAccessibilityText(instrumentation, "仅音频"));
            assertTrue("Audio-only choice must be applied", PlaybackService.audioOnly(context));
            assertTrue("Video mode must be selectable", clickAccessibilityText(instrumentation, "视频画面"));
            assertFalse("Video mode choice must be applied", PlaybackService.audioOnly(context));
            assertTrue("Video fit mode must be selectable", clickAccessibilityText(instrumentation, "填满屏幕"));
            assertFalse("Fill mode must be saved", PlaybackService.fitMode(context));
            assertTrue("Video fit mode must be restorable", clickAccessibilityText(instrumentation, "适应画面"));
            assertTrue("Fit mode must be saved", PlaybackService.fitMode(context));
            assertTrue("Settings panel should have a clear close action", clickAccessibilityText(instrumentation, "完成"));
            instrumentation.runOnMainSync(playbackSettings::performClick);
            assertTrue("Reopening settings must retain shuffle selection", hasSelectedChoice(instrumentation, "随机播放"));
            assertTrue("Reopening settings must retain repeat selection", hasSelectedChoice(instrumentation, "列表循环"));
            assertTrue("Reopening settings must retain speed selection", hasSelectedChoice(instrumentation, "1.5×"));
            assertTrue("Reopened settings must be closable", clickAccessibilityText(instrumentation, "完成"));
            instrumentation.runOnMainSync(() -> {
                connectedController.setShuffleModeEnabled(false);
                connectedController.setRepeatMode(Player.REPEAT_MODE_OFF);
                connectedController.setPlaybackSpeed(1f);
                PlaybackService.saveMode(context, Player.REPEAT_MODE_OFF, false);
                PlaybackService.savePlaybackSpeed(context, 1f);
            });
            instrumentation.runOnMainSync(connectedController::play);
            long startDeadline = SystemClock.elapsedRealtime() + 3000;
            while (!isPlaying(instrumentation, controller) && SystemClock.elapsedRealtime() < startDeadline)
                Thread.sleep(25);
            assertTrue("The explicit play action did not start playback", isPlaying(instrumentation, controller));
            Thread.sleep(700);
            instrumentation.runOnMainSync(page::onBackPressed);
            assertTrue("Back from the detail page should close it", page.isFinishing());
            long stopDeadline = SystemClock.elapsedRealtime() + 3000;
            while (isPlaying(instrumentation, controller) && SystemClock.elapsedRealtime() < stopDeadline)
                Thread.sleep(25);
            assertFalse("Playback must stop when leaving the detail page", isPlaying(instrumentation, controller));
            String saved = context.getSharedPreferences("video_watch_positions", Context.MODE_PRIVATE)
                    .getString(queue.tracks.get(0).mediaId, "");
            assertFalse("Leaving the page should preserve a valid resume position", saved.isEmpty());
            JSONObject savedProgress = new JSONObject(saved);
            assertTrue("Resume position should be past the beginning", savedProgress.getLong("position") > 0);
            assertTrue("Resume position must not be the video end",
                    savedProgress.getLong("position") < savedProgress.getLong("duration"));
            long savedPosition = savedProgress.getLong("position");
            String stableMediaId = queue.tracks.get(0).mediaId;
            ListenableFuture<MediaController> previousFuture = future;
            instrumentation.runOnMainSync(() -> MediaController.releaseFuture(previousFuture));
            future = null;
            controller = null;
            long serviceReleaseDeadline = SystemClock.elapsedRealtime() + 5000;
            while (!PlaybackQueueStore.activeId(context).isEmpty() &&
                    SystemClock.elapsedRealtime() < serviceReleaseDeadline) Thread.sleep(25);
            assertEquals("Stopped playback service should release its old queue", "", PlaybackQueueStore.activeId(context));

            queue = PlaybackQueue.snapshot(Arrays.asList(video), video.uri);
            assertEquals("A reopened snapshot should retain the same video identity", stableMediaId, queue.tracks.get(0).mediaId);
            PlaybackQueueStore.save(context, queue);
            Intent reopened = new Intent(context, PlayerActivity.class).putExtra("queue_id", queue.id);
            android.app.Instrumentation.ActivityMonitor reopenedPlayer = instrumentation.addMonitor(
                    PlayerActivity.class.getName(), null, false);
            Activity reopenFromLibrary = libraryActivity;
            instrumentation.runOnMainSync(() -> reopenFromLibrary.startActivity(reopened));
            foregroundActivity = instrumentation.waitForMonitorWithTimeout(reopenedPlayer, 10000);
            instrumentation.removeMonitor(reopenedPlayer);
            assertNotNull("The reopened player should stay in the existing library task", foregroundActivity);
            future = new MediaController.Builder(context,
                    new SessionToken(context, new android.content.ComponentName(context, PlaybackService.class))).buildAsync();
            controller = future.get(10, TimeUnit.SECONDS);
            MediaController resumedController = controller;
            int[] resumedState = new int[1];
            long resumeReadyDeadline = SystemClock.elapsedRealtime() + 10000;
            while (playbackState(instrumentation, resumedController) != Player.STATE_READY &&
                    SystemClock.elapsedRealtime() < resumeReadyDeadline) Thread.sleep(50);
            assertEquals("Reopened video must prepare successfully", Player.STATE_READY,
                    playbackState(instrumentation, resumedController));
            assertTrue("Reopened video must autoplay", awaitControllerState(instrumentation, resumedController::isPlaying));
            instrumentation.runOnMainSync(resumedController::pause);
            long[] restoredPosition = new long[1];
            instrumentation.runOnMainSync(() -> restoredPosition[0] = resumedController.getCurrentPosition());
            assertTrue("Reopened video should resume near the saved position (saved=" + savedPosition +
                    ", restored=" + restoredPosition[0] + ")", Math.abs(restoredPosition[0] - savedPosition) < 1000);
            assertTrue("Reopened video must not resume at the end", restoredPosition[0] < savedProgress.getLong("duration"));
            instrumentation.runOnMainSync(resumedController::play);
            long endDeadline = SystemClock.elapsedRealtime() + 15000;
            while (playbackState(instrumentation, controller) != Player.STATE_ENDED &&
                    SystemClock.elapsedRealtime() < endDeadline) Thread.sleep(50);
            assertEquals("The local H.264/AAC video did not complete", Player.STATE_ENDED,
                    playbackState(instrumentation, controller));
        } finally {
            if (future != null) {
                ListenableFuture<MediaController> release = future;
                instrumentation.runOnMainSync(() -> MediaController.releaseFuture(release));
            }
            context.stopService(new Intent(context, PlaybackService.class));
            Thread.sleep(250);
            if (foregroundActivity != null) {
                Activity closeActivity = foregroundActivity;
                instrumentation.runOnMainSync(closeActivity::finish);
            }
            if (libraryActivity != null) {
                Activity closeLibrary = libraryActivity;
                instrumentation.runOnMainSync(closeLibrary::finish);
            }
            if (queue != null) PlaybackQueueStore.clear(context, queue.id);
            if (previousQueue != null && !previousQueue.isEmpty()) {
                context.getSharedPreferences("playback_session", Context.MODE_PRIVATE).edit().putString("active_id", previousQueue).apply();
            }
            PlaybackService.setAudioOnly(context, previousAudioOnly);
            PlaybackService.saveMode(context, previousRepeat, previousShuffle);
            PlaybackService.savePlaybackSpeed(context, previousSpeed);
            PlaybackService.saveFitMode(context, previousFit);
            context.getSharedPreferences("video_watch_positions", Context.MODE_PRIVATE).edit().remove(mediaId).apply();
            if (mediaUri != null) context.getContentResolver().delete(mediaUri, null, null);
        }
    }
}
