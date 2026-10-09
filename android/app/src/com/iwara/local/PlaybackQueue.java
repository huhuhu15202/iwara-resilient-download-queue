package com.iwara.local;

import android.net.Uri;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** Stable snapshot of the exact filtered library order sent to the player. */
public final class PlaybackQueue {
    public final String id;
    public final ArrayList<Track> tracks;
    public final int startIndex;

    private PlaybackQueue(String id, ArrayList<Track> tracks, int startIndex) {
        this.id = id;
        this.tracks = tracks;
        this.startIndex = startIndex;
    }

    public static PlaybackQueue snapshot(List<LibraryDb.Video> videos, String selectedUri) {
        if (videos == null || videos.isEmpty()) throw new IllegalArgumentException("当前列表没有可播放视频");
        ArrayList<Track> tracks = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        int start = -1;
        for (LibraryDb.Video video : videos) {
            if (video.uri == null || !"content".equals(Uri.parse(video.uri).getScheme()) || !seen.add(video.uri)) continue;
            String mediaId = stableId(video);
            if (video.uri.equals(selectedUri)) start = tracks.size();
            tracks.add(new Track(mediaId, video.uri, video.displayTitle(), video.author,
                    video.size, video.modified, video.uploadTime, video.views));
        }
        if (start < 0) throw new IllegalArgumentException("所选视频已不在当前列表，请刷新后重试");
        return new PlaybackQueue(UUID.randomUUID().toString(), tracks, start);
    }

    private static String stableId(LibraryDb.Video video) {
        if (video.sha256 != null && video.sha256.matches("[0-9a-f]{64}")) return "sha256:" + video.sha256;
        if (video.taskId != null && !video.taskId.isEmpty()) return "task:" + video.taskId;
        return "uri:" + Uri.encode(video.uri);
    }

    public JSONObject toJson() throws Exception {
        JSONArray list = new JSONArray();
        for (Track track : tracks) {
            JSONObject item = new JSONObject();
            item.put("media_id", track.mediaId);
            item.put("uri", track.uri);
            item.put("title", track.title);
            if (track.author != null) item.put("author", track.author);
            item.put("size", track.size);
            item.put("modified", track.modified);
            item.put("upload_time", track.uploadTime);
            item.put("views", track.views);
            list.put(item);
        }
        JSONObject json = new JSONObject();
        json.put("version", 1);
        json.put("id", id);
        json.put("start", startIndex);
        json.put("tracks", list);
        return json;
    }

    public static PlaybackQueue fromJson(JSONObject json) throws Exception {
        if (json.optInt("version") != 1) throw new IllegalArgumentException("播放队列版本不支持");
        String id = json.getString("id");
        if (!id.matches("[0-9a-fA-F-]{36}")) throw new IllegalArgumentException("播放队列编号无效");
        JSONArray array = json.getJSONArray("tracks");
        if (array.length() == 0 || array.length() > 10000) throw new IllegalArgumentException("播放列表项目数量无效");
        ArrayList<Track> tracks = new ArrayList<>(array.length());
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.getJSONObject(i);
            String uri = item.getString("uri");
            if (!"content".equals(Uri.parse(uri).getScheme())) throw new IllegalArgumentException("播放列表包含无效文件地址");
            tracks.add(new Track(item.getString("media_id"), uri, item.optString("title", "视频"),
                    item.optString("author", ""), item.optLong("size", 0), item.optLong("modified", 0),
                    item.optLong("upload_time", 0), item.optLong("views", -1)));
        }
        int start = json.getInt("start");
        if (start < 0 || start >= tracks.size()) throw new IllegalArgumentException("播放起始位置无效");
        return new PlaybackQueue(id, tracks, start);
    }

    public static final class Track {
        public final String mediaId, uri, title, author;
        public final long size, modified, uploadTime, views;
        Track(String mediaId, String uri, String title, String author, long size, long modified,
                long uploadTime, long views) {
            this.mediaId = mediaId;
            this.uri = uri;
            this.title = title;
            this.author = author;
            this.size = size;
            this.modified = modified;
            this.uploadTime = uploadTime;
            this.views = views;
        }
    }
}
