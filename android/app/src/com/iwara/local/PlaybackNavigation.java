package com.iwara.local;

import androidx.media3.common.Player;

/** Queue navigation that follows Media3's configured shuffle and repeat order. */
public final class PlaybackNavigation {
    private PlaybackNavigation() {}

    public static boolean move(Player player, int direction) {
        if (player == null || player.getMediaItemCount() == 0 || direction == 0) return false;
        boolean shouldResume = player.getPlayWhenReady();
        if (direction < 0) {
            if (!player.hasPreviousMediaItem()) {
                if (player.getCurrentPosition() <= 3000) return false;
                player.seekTo(0);
            } else {
                player.seekToPreviousMediaItem();
            }
        } else {
            if (!player.hasNextMediaItem()) return false;
            player.seekToNextMediaItem();
        }
        if (shouldResume) player.play();
        else player.pause();
        return true;
    }
}
