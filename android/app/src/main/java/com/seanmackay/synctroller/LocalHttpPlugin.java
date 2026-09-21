package com.seanmackay.synctroller;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSession;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Makes the actual HTTP(S) requests to the Sync Box / Hue Bridge natively
 * instead of through the WebView's fetch(). Two things a plain WebView
 * fetch() can't do, both needed here:
 *
 *  1. Both devices use self-signed local-network certificates -- same
 *     reason the desktop (Electron) app disables Node's TLS verification
 *     for these two hosts. A native HttpsURLConnection with a permissive
 *     TrustManager mirrors that, same trust model (LAN IP address the
 *     user entered themselves, never a CA-validated hostname).
 *  2. Neither device's embedded REST API sends CORS headers (they were
 *     never built to be called from browser JS), so a page-context
 *     fetch() to a different origin would have its response blocked by
 *     the WebView's own CORS enforcement even if the network request
 *     itself succeeded. Native code has no concept of CORS at all.
 */
@CapacitorPlugin(name = "LocalHttp")
public class LocalHttpPlugin extends Plugin {

  // HttpURLConnection pools/reuses persistent connections per host by
  // default. That's fine for a normal server, but the Sync Box/Bridge are
  // one-request-at-a-time local devices and every request here builds a
  // brand new SSLContext/TrustManager on a brand new HttpsURLConnection --
  // reusing a pooled socket underneath a *different* connection object,
  // combined with never explicitly disconnect()-ing (see below), is what
  // was making sync-toggle/etc. randomly hang until the 10s timeout
  // instead of firing: a previous request's connection could be left in
  // the pool half-consumed, and the next request would silently block
  // waiting on it. Disabling keep-alive forces a fresh connection (cheap
  // on a local LAN) every time instead.
  static {
    System.setProperty("http.keepAlive", "false");
  }

  // Every previous request here ran on its own brand new Thread, so a
  // user's tap and the 4s state-poll (see refreshState() in renderer.js)
  // could land on the Sync Box at the same moment as two genuinely
  // concurrent connections -- confirmed live: its embedded HTTP server
  // can't service two requests at once and just resets one of them
  // ("unexpected end of stream"), which read to the user as the command
  // being dropped/unresponsive.
  //
  // One executor *per host* (not one global executor) fixes that without
  // over-serializing: requests to the Sync Box now queue strictly one at a
  // time, matching what it can actually handle, but requests to a Hue
  // Bridge -- a completely different, unrelated device -- no longer wait
  // behind them, and multiple independent Bridge calls (e.g. opening an
  // entertainment area fires several at once, see openEntareaEdit() in
  // renderer.js) can still run in parallel the way they did before this
  // existed, instead of queueing behind each other one at a time (which
  // is what made opening an entertainment area feel slow after a global
  // executor was tried first here).
  private static final Map<String, ExecutorService> EXECUTORS = new ConcurrentHashMap<>();

  private static ExecutorService executorFor(String urlString) {
    String host;
    try {
      host = new URL(urlString).getHost();
    } catch (Exception e) {
      host = urlString; // fall back to something stable rather than failing the request over this
    }
    return EXECUTORS.computeIfAbsent(host, (h) -> Executors.newSingleThreadExecutor());
  }

  @PluginMethod
  public void request(PluginCall call) {
    String urlString = call.getString("url");
    String method = call.getString("method", "GET");
    String body = call.getString("body");
    JSObject headers = call.getObject("headers", new JSObject());

    if (urlString == null) {
      call.reject("Missing url");
      return;
    }

    // One retry after a beat -- even serialized per-host, a device can
    // still drop a request under back-to-back traffic (e.g. a poll landing
    // right as the user acts); a single retry smooths over that without
    // masking a genuinely offline device (which will just fail again).
    executorFor(urlString).execute(() -> executeRequest(call, urlString, method, body, headers, 1));
  }

  private void executeRequest(PluginCall call, String urlString, String method, String body, JSObject headers, int retriesLeft) {
    HttpURLConnection conn = null;
    try {
      URL url = new URL(urlString);
      conn = (HttpURLConnection) url.openConnection();

      if (conn instanceof HttpsURLConnection) {
        HttpsURLConnection httpsConn = (HttpsURLConnection) conn;
        SSLContext sslContext = SSLContext.getInstance("TLS");
        sslContext.init(
          null,
          new TrustManager[] {
            new X509TrustManager() {
              public void checkClientTrusted(X509Certificate[] chain, String authType) {}
              public void checkServerTrusted(X509Certificate[] chain, String authType) {}
              public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
              }
            }
          },
          new SecureRandom()
        );
        httpsConn.setSSLSocketFactory(sslContext.getSocketFactory());
        httpsConn.setHostnameVerifier((String hostname, SSLSession session) -> true);
      }

      conn.setRequestMethod(method);
      conn.setConnectTimeout(10000);
      conn.setReadTimeout(10000);

      java.util.Iterator<String> keys = headers.keys();
      while (keys.hasNext()) {
        String key = keys.next();
        conn.setRequestProperty(key, headers.getString(key));
      }

      if (body != null && !body.isEmpty()) {
        conn.setDoOutput(true);
        try (OutputStream os = conn.getOutputStream()) {
          os.write(body.getBytes(StandardCharsets.UTF_8));
        }
      }

      int status = conn.getResponseCode();
      InputStream stream = status >= 200 && status < 300 ? conn.getInputStream() : conn.getErrorStream();
      StringBuilder responseBody = new StringBuilder();
      if (stream != null) {
        BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8));
        String line;
        while ((line = reader.readLine()) != null) {
          responseBody.append(line);
        }
        reader.close();
      }

      JSObject result = new JSObject();
      result.put("status", status);
      result.put("body", responseBody.toString());
      call.resolve(result);
    } catch (Exception e) {
      if (conn != null) conn.disconnect();
      conn = null;
      if (retriesLeft > 0) {
        try {
          Thread.sleep(300);
        } catch (InterruptedException ignored) {
          // proceed with the retry anyway
        }
        executeRequest(call, urlString, method, body, headers, retriesLeft - 1);
        return;
      }
      call.reject(e.getMessage(), e);
    } finally {
      if (conn != null) conn.disconnect();
    }
  }
}
