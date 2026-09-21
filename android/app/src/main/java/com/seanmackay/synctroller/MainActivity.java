package com.seanmackay.synctroller;

import android.Manifest;
import android.app.NotificationManager;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.SslErrorHandler;
import android.webkit.WebView;
import android.net.http.SslError;
import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

/**
 * The Sync Box and Hue Bridge both serve their local control APIs over
 * HTTPS with self-signed certificates -- the same reason the desktop
 * (Electron) version of this app disables Node's TLS verification for
 * these two hosts specifically. A stock WebView has no such override, so
 * without this, every fetch() in services.js to either device would fail
 * with a certificate error before ever reaching the device. This accepts
 * every SSL error unconditionally, same trust model as the desktop app:
 * both devices are only ever identified by a LAN IP address the user
 * entered themselves, never a hostname/CA-validated identity.
 */
public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(LocalHttpPlugin.class);
    registerPlugin(DiscoveryPlugin.class);
    registerPlugin(SyncNotificationPlugin.class);
    super.onCreate(savedInstanceState);
    WebView webView = getBridge().getWebView();
    webView.setWebViewClient(
      new BridgeWebViewClient(getBridge()) {
        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
          handler.proceed();
        }
      }
    );

    // The web app has no browser history (every screen is just a class
    // toggle in renderer.js, see showView()), so without this, system
    // back/the edge-swipe gesture never has anything to "go back" to and
    // just backgrounds or finishes the Activity outright regardless of how
    // many screens deep you are. This always intercepts it instead and
    // asks the page itself (android-ui.js's handleAndroidBack()) whether
    // there's an in-app screen to go up to; only once that says no (i.e.
    // we're already on a home screen) do we treat it as a real quit.
    getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
      @Override
      public void handleOnBackPressed() {
        webView.evaluateJavascript(
          // A bare boolean here (not String(...)) matters: evaluateJavascript's
          // callback receives the JS result JSON-encoded, so a real boolean
          // comes back as the literal 4/5-char "true"/"false" -- a JS *string*
          // "true" comes back as the literally-quoted `"true"` instead, which
          // never matches the comparison below and made this treat every back
          // press as unhandled, killing the app from any screen instead of
          // just navigating up one level.
          "(function(){ return (typeof handleAndroidBack === 'function') ? !!handleAndroidBack() : false; })()",
          (String value) -> {
            if (!"true".equals(value)) {
              // Swiping back from a home screen means "quit", not just
              // "close this Activity" -- take the status notification down
              // with it so "quit" really looks quit. It comes right back
              // next launch (services.js re-shows it on boot whenever a
              // box is still paired), so nothing about pairing state is
              // lost by this.
              getSystemService(NotificationManager.class).cancel(SyncNotificationPlugin.NOTIFICATION_ID);
              finish();
            }
          }
        );
      }
    });

    // Android 13+ requires runtime consent to show notifications -- without
    // it the status notification is silently dropped. Asked once up front rather than only at
    // the moment services.js first tries to post it.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(this, new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
    }
  }
}
