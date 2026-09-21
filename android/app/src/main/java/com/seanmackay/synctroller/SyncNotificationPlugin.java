package com.seanmackay.synctroller;

import android.content.Intent;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS-facing control for the persistent status notification (see
 * SyncStatusService) -- services.js calls show() once a Sync Box is paired
 * and again whenever renderer.js reports syncActive changing, and hide()
 * when the box is forgotten.
 */
@CapacitorPlugin(name = "SyncNotification")
public class SyncNotificationPlugin extends Plugin {

  @PluginMethod
  public void show(PluginCall call) {
    String title = call.getString("title", "SyncTroller");
    String text = call.getString("text", "Standby");
    Intent intent = new Intent(getContext(), SyncStatusService.class);
    intent.putExtra(SyncStatusService.EXTRA_TITLE, title);
    intent.putExtra(SyncStatusService.EXTRA_TEXT, text);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      getContext().startForegroundService(intent);
    } else {
      getContext().startService(intent);
    }
    call.resolve();
  }

  @PluginMethod
  public void hide(PluginCall call) {
    getContext().stopService(new Intent(getContext(), SyncStatusService.class));
    call.resolve();
  }
}
