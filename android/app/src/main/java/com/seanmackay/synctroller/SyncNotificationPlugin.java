package com.seanmackay.synctroller;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS-facing control for the ongoing status notification ("SyncTroller /
 * Standby" or "SyncTroller / Syncing") with a tap action that reopens the
 * app -- services.js calls show() once a Sync Box is paired and again
 * whenever renderer.js reports syncActive changing, and hide() when the
 * box is forgotten.
 *
 * Deliberately a plain notification, not a foreground service: the app has
 * no real background work to justify one (Play's FGS-type review would
 * reject "keep a notification up" as a dataSync use), and Android 15+ caps
 * dataSync services at 6h/day anyway. The trade-off is that on Android 14+
 * the user can swipe it away; it comes back on the next app launch.
 */
@CapacitorPlugin(name = "SyncNotification")
public class SyncNotificationPlugin extends Plugin {
  private static final String CHANNEL_ID = "synctroller_status";
  static final int NOTIFICATION_ID = 1001;

  @PluginMethod
  public void show(PluginCall call) {
    String title = call.getString("title", "SyncTroller");
    String text = call.getString("text", "Standby");
    Context ctx = getContext();
    NotificationManager mgr = ctx.getSystemService(NotificationManager.class);
    createChannel(mgr);
    try {
      mgr.notify(NOTIFICATION_ID, buildNotification(ctx, title, text));
    } catch (SecurityException e) {
      // POST_NOTIFICATIONS denied on Android 13+ -- non-fatal, app still works.
    }
    call.resolve();
  }

  @PluginMethod
  public void hide(PluginCall call) {
    getContext().getSystemService(NotificationManager.class).cancel(NOTIFICATION_ID);
    call.resolve();
  }

  private static void createChannel(NotificationManager mgr) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationChannel channel = new NotificationChannel(
        CHANNEL_ID, "Sync status", NotificationManager.IMPORTANCE_LOW);
      channel.setShowBadge(false);
      mgr.createNotificationChannel(channel);
    }
  }

  private static Notification buildNotification(Context ctx, String title, String text) {
    Intent openIntent = new Intent(ctx, MainActivity.class);
    openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    PendingIntent pendingIntent = PendingIntent.getActivity(ctx, 0, openIntent, flags);

    return new NotificationCompat.Builder(ctx, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle(title)
      .setContentText(text)
      .setContentIntent(pendingIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build();
  }
}
