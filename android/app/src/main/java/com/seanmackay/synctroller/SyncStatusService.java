package com.seanmackay.synctroller;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * Keeps a persistent, ongoing notification up ("SyncTroller / Standby" or
 * "SyncTroller / Syncing") for as long as a Sync Box is paired, with
 * a tap action that reopens the app -- this app is meant to be reachable
 * from the notification shade the same way a media-player app is, not
 * something the user has to go dig out of the app drawer/recents.
 */
public class SyncStatusService extends Service {
  public static final String CHANNEL_ID = "synctroller_status";
  public static final int NOTIFICATION_ID = 1001;
  public static final String EXTRA_TITLE = "title";
  public static final String EXTRA_TEXT = "text";

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    String title = "SyncTroller";
    String text = "Standby";
    if (intent != null) {
      if (intent.hasExtra(EXTRA_TITLE)) title = intent.getStringExtra(EXTRA_TITLE);
      if (intent.hasExtra(EXTRA_TEXT)) text = intent.getStringExtra(EXTRA_TEXT);
    }
    createChannel();
    Notification notification = buildNotification(title, text);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
    } else {
      startForeground(NOTIFICATION_ID, notification);
    }
    return START_STICKY;
  }

  private void createChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationManager mgr = getSystemService(NotificationManager.class);
      NotificationChannel channel = new NotificationChannel(
        CHANNEL_ID, "Sync status", NotificationManager.IMPORTANCE_LOW);
      channel.setShowBadge(false);
      mgr.createNotificationChannel(channel);
    }
  }

  private Notification buildNotification(String title, String text) {
    Intent openIntent = new Intent(this, MainActivity.class);
    openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
    PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, openIntent, flags);

    return new NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle(title)
      .setContentText(text)
      .setContentIntent(pendingIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build();
  }

  @Nullable
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
