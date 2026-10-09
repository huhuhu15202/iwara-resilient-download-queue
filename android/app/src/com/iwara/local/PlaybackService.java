package com.iwara.local;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionParameters;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

/** Owns one local ExoPlayer and MediaSession while the screen or audio keeps playing. */
public final class PlaybackService extends MediaSessionService {
    private static final String TAG = "IwaraPlayback";
    private static final String PREFS = "playback_session";
    private static final String KEY_AUDIO_ONLY = "audio_only";
    private static final String KEY_REPEAT = "repeat_mode";
    private static final String KEY_SHUFFLE = "shuffle";
    private static final String KEY_SPEED = "playback_speed";
    private static final String ACTION_STOP_PLAYBACK = "com.iwara.local.action.STOP_PLAYBACK";
    private static final long POSITION_SAVE_MS = 5000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private ExoPlayer player;
    private MediaSession session;
    private String queueId = "";
    private String lastSavedMediaId = "";
    private long lastSavedPosition;

    private final Runnable savePosition = new Runnable() {
        @Override public void run() {
            persistPosition(false);
            if (player != null && player.isPlaying()) handler.postDelayed(this, POSITION_SAVE_MS);
        }
    };

    public static void open(Activity activity, List<LibraryDb.Video> videos, String selectedUri) throws Exception {
        PlaybackQueue queue = PlaybackQueue.snapshot(videos, selectedUri);
        PlaybackQueueStore.save(activity, queue);
        Intent service = new Intent(activity, PlaybackService.class).putExtra("queue_id", queue.id).putExtra("autoplay", true);
        activity.startService(service);
        activity.startActivity(new Intent(activity, PlayerActivity.class).putExtra("queue_id", queue.id));
    }

    public static void requestStop(Context context, String queueId) {
        Intent stop = new Intent(context, PlaybackService.class).setAction(ACTION_STOP_PLAYBACK)
                .putExtra("queue_id", queueId == null ? "" : queueId);
        context.startService(stop);
    }

    public static boolean audioOnly(Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_AUDIO_ONLY, false);
    }

    public static void setAudioOnly(Context context, boolean enabled) {
        context.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_AUDIO_ONLY, enabled).apply();
    }

    public static int repeatMode(Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE).getInt(KEY_REPEAT, Player.REPEAT_MODE_OFF);
    }

    public static boolean shuffleEnabled(Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_SHUFFLE, false);
    }

    public static void saveMode(Context context, int repeat, boolean shuffle) {
        context.getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putInt(KEY_REPEAT, repeat).putBoolean(KEY_SHUFFLE, shuffle).apply();
    }

    public static float playbackSpeed(Context context) {
        float speed = context.getSharedPreferences(PREFS, MODE_PRIVATE).getFloat(KEY_SPEED, 1f);
        return speed >= 0.25f && speed <= 3f ? speed : 1f;
    }

    public static void savePlaybackSpeed(Context context, float speed) {
        if (speed < 0.25f || speed > 3f) speed = 1f;
        context.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putFloat(KEY_SPEED, speed).apply();
    }

    public static boolean fitMode(Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("fit_mode", true);
    }

    public static void saveFitMode(Context context, boolean fit) {
        context.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("fit_mode", fit).apply();
    }

    @Override public void onCreate() {
        super.onCreate();
        createPlaybackSession();
        String active = PlaybackQueueStore.activeId(this);
        if (active != null && !active.isEmpty()) loadQueue(active, false);
    }

    private void createPlaybackSession() {
        if (player != null) return;
        player = new ExoPlayer.Builder(this).setHandleAudioBecomingNoisy(true).build();
        player.setAudioAttributes(new androidx.media3.common.AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true);
        player.setRepeatMode(repeatMode(this));
        player.setShuffleModeEnabled(shuffleEnabled(this));
        player.setPlaybackSpeed(playbackSpeed(this));
        player.addListener(new Player.Listener() {
            @Override public void onIsPlayingChanged(boolean isPlaying) {
                handler.removeCallbacks(savePosition);
                if (isPlaying) handler.postDelayed(savePosition, POSITION_SAVE_MS);
                else persistPosition(false);
            }

            @Override public void onMediaItemTransition(@Nullable MediaItem mediaItem, int reason) {
                lastSavedMediaId = "";
                lastSavedPosition = 0;
                updateActiveTrack(mediaItem);
            }

            @Override public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_ENDED) persistPosition(true);
            }
        });
        session = new MediaSession.Builder(this, player).build();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP_PLAYBACK.equals(intent.getAction())) {
            String requestedStopQueue = intent.getStringExtra("queue_id");
            if (requestedStopQueue == null || requestedStopQueue.isEmpty() || requestedStopQueue.equals(queueId)) {
                stopPlaybackNow();
                stopSelfResult(startId);
            }
            return START_NOT_STICKY;
        }
        String requested = intent == null ? null : intent.getStringExtra("queue_id");
        if (requested != null && !requested.isEmpty()) {
            if (!requested.equals(queueId)) loadQueue(requested, intent.getBooleanExtra("autoplay", true));
            else if (intent.getBooleanExtra("autoplay", false)) player.play();
            int restoreIndex = intent.getIntExtra("restore_index", -1);
            if (player != null && requested.equals(queueId) && restoreIndex >= 0 && restoreIndex < player.getMediaItemCount())
                player.seekTo(restoreIndex, Math.max(0, intent.getLongExtra("restore_position", 0)));
        }
        return super.onStartCommand(intent, flags, startId);
    }

    private void loadQueue(String id, boolean play) {
        try {
            PlaybackQueue queue = PlaybackQueueStore.load(this, id);
            createPlaybackSession();
            List<MediaItem> items = new ArrayList<>(queue.tracks.size());
            for (PlaybackQueue.Track track : queue.tracks) {
                MediaMetadata metadata = new MediaMetadata.Builder().setTitle(track.title)
                        .setArtist(track.author == null || track.author.isEmpty() ? "" : track.author).build();
                items.add(new MediaItem.Builder().setMediaId(track.mediaId).setUri(Uri.parse(track.uri))
                        .setMediaMetadata(metadata).build());
            }
            queueId = id;
            player.setMediaItems(items, queue.startIndex, savedPosition(items.get(queue.startIndex).mediaId));
            player.prepare();
            if (play) player.play();
            updateActiveTrack(player.getCurrentMediaItem());
            handler.removeCallbacks(savePosition);
            handler.postDelayed(savePosition, POSITION_SAVE_MS);
        } catch (Exception error) {
            Log.w(TAG, "Could not restore local playback queue", error);
            stopSelf();
        }
    }

    private String currentMediaId() {
        MediaItem current = player == null ? null : player.getCurrentMediaItem();
        return current == null ? "" : current.mediaId;
    }

    private long savedPosition(String mediaId) {
        if (audioOnly(this)) return 0;
        String encoded = getSharedPreferences("video_watch_positions", MODE_PRIVATE).getString(mediaId, "");
        if (encoded.isEmpty()) return 0;
        try {
            JSONObject value = new JSONObject(encoded);
            long position = Math.max(0, value.getLong("position"));
            long duration = value.optLong("duration", 0);
            if (isAtSavedEnd(position, duration)) {
                getSharedPreferences("video_watch_positions", MODE_PRIVATE).edit().remove(mediaId).apply();
                return 0;
            }
            return position;
        }
        catch (Exception ignored) { return 0; }
    }

    private static boolean isAtSavedEnd(long position, long duration) {
        if (duration <= 0 || position < 0 || position >= duration) return duration > 0 && position >= duration;
        if (duration <= 10000) return false;
        long tolerance = Math.min(2000L, Math.max(500L, duration / 100));
        return position >= duration - tolerance;
    }

    private void stopPlaybackNow() {
        handler.removeCallbacks(savePosition);
        if (player != null) {
            player.pause();
            persistPosition(false);
            player.clearMediaItems();
        }
        String stoppedQueue = queueId;
        queueId = "";
        PlaybackQueueStore.clear(this, stoppedQueue);
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove("active_media_id").remove("active_index").apply();
        // A finishing screen can remain bound for several seconds. Retire its platform
        // session now so delayed notification STOP commands cannot stop a new queue.
        if (session != null) session.release();
        if (player != null) player.release();
        session = null;
        player = null;
    }

    private void persistPosition(boolean ended) {
        if (player == null || audioOnly(this) || player.getCurrentMediaItem() == null) return;
        String mediaId = currentMediaId();
        long position = ended ? 0 : player.getCurrentPosition();
        long duration = player.getDuration();
        boolean completed = ended || player.getPlaybackState() == Player.STATE_ENDED ||
                isAtSavedEnd(position, duration);
        if (mediaId.isEmpty()) return;
        if (completed) {
            getSharedPreferences("video_watch_positions", MODE_PRIVATE).edit().remove(mediaId).apply();
            lastSavedMediaId = mediaId;
            lastSavedPosition = 0;
            return;
        }
        if (position <= 0) return;
        if (mediaId.equals(lastSavedMediaId) && position == lastSavedPosition && !ended) return;
        {
            JSONObject value = new JSONObject();
            try {
                value.put("position", position);
                value.put("duration", Math.max(0, duration));
                getSharedPreferences("video_watch_positions", MODE_PRIVATE).edit().putString(mediaId, value.toString()).apply();
            } catch (Exception ignored) {}
        }
        lastSavedMediaId = mediaId;
        lastSavedPosition = position;
    }

    private void updateActiveTrack(@Nullable MediaItem item) {
        if (item == null) return;
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("active_media_id", item.mediaId)
                .putInt("active_index", Math.max(0, player.getCurrentMediaItemIndex())).apply();
    }

    @Nullable @Override public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        createPlaybackSession();
        return session;
    }

    @Override public void onTaskRemoved(@Nullable Intent rootIntent) {
        stopPlaybackNow();
        stopSelf();
    }

    @Override public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        persistPosition(false);
        if (session != null) session.release();
        if (player != null) player.release();
        PlaybackQueueStore.clear(this, queueId);
        super.onDestroy();
    }
}
