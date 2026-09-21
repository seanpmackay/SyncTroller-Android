package com.seanmackay.synctroller;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Android's equivalent of the desktop app's avahi-browse-based mDNS
 * discovery (discovery.js / huebridge.js's discover()) -- there's no
 * avahi binary to shell out to here, but NsdManager is the native Android
 * API for the exact same underlying mDNS/DNS-SD protocol, so this finds
 * the same devices the same way, just through a different API.
 *
 * mDNS is multicast traffic, which many Android devices drop by default
 * to save power -- a WifiManager.MulticastLock is required for NSD
 * discovery to actually see anything, same reason apps like this need the
 * CHANGE_WIFI_MULTICAST_STATE permission (declared in AndroidManifest.xml).
 */
@CapacitorPlugin(name = "Discovery")
public class DiscoveryPlugin extends Plugin {

  @PluginMethod
  public void discover(PluginCall call) {
    String serviceType = call.getString("serviceType");
    int timeoutMs = call.getInt("timeoutMs", 4000);
    if (serviceType == null) {
      call.reject("Missing serviceType");
      return;
    }

    Context context = getContext().getApplicationContext();
    WifiManager wifi = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
    WifiManager.MulticastLock lock = wifi.createMulticastLock("synctroller-mdns");
    lock.setReferenceCounted(true);
    lock.acquire();

    NsdManager nsdManager = (NsdManager) context.getSystemService(Context.NSD_SERVICE);
    JSArray results = new JSArray();
    AtomicInteger pendingResolves = new AtomicInteger(0);
    Handler mainHandler = new Handler(Looper.getMainLooper());
    AtomicBoolean finished = new AtomicBoolean(false);

    // NsdManager only supports one resolveService() in flight at a time --
    // calling it again before the previous call's listener has fired fails
    // (silently drops or errors depending on OEM/Android version). Finding
    // two services close together (e.g. two Hue Bridges) used to fire two
    // concurrent resolves here and reliably lose one of them. A queue,
    // drained one resolve at a time from each listener callback, is the
    // standard workaround for this platform limitation.
    ArrayDeque<NsdServiceInfo> resolveQueue = new ArrayDeque<>();
    AtomicBoolean resolving = new AtomicBoolean(false);

    NsdManager.ResolveListener[] resolveListenerHolder = new NsdManager.ResolveListener[1];
    Runnable[] resolveNextHolder = new Runnable[1];

    resolveListenerHolder[0] = new NsdManager.ResolveListener() {
      @Override
      public void onResolveFailed(NsdServiceInfo info, int errorCode) {
        pendingResolves.decrementAndGet();
        resolveNextHolder[0].run();
      }

      @Override
      public void onServiceResolved(NsdServiceInfo info) {
        pendingResolves.decrementAndGet();
        JSObject entry = new JSObject();
        entry.put("host", info.getHost().getHostAddress());
        entry.put("port", info.getPort());
        JSObject txt = new JSObject();
        Map<String, byte[]> attrs = info.getAttributes();
        if (attrs != null) {
          for (Map.Entry<String, byte[]> e : attrs.entrySet()) {
            txt.put(e.getKey(), e.getValue() != null ? new String(e.getValue(), StandardCharsets.UTF_8) : "");
          }
        }
        entry.put("txt", txt);
        results.put(entry);
        resolveNextHolder[0].run();
      }
    };

    resolveNextHolder[0] = () -> {
      NsdServiceInfo next = resolveQueue.poll();
      if (next == null) {
        resolving.set(false);
        return;
      }
      try {
        nsdManager.resolveService(next, resolveListenerHolder[0]);
      } catch (Exception e) {
        pendingResolves.decrementAndGet();
        resolveNextHolder[0].run();
      }
    };

    NsdManager.DiscoveryListener discoveryListener = new NsdManager.DiscoveryListener() {
      @Override
      public void onDiscoveryStarted(String regType) {}

      @Override
      public void onServiceFound(NsdServiceInfo info) {
        pendingResolves.incrementAndGet();
        resolveQueue.add(info);
        if (resolving.compareAndSet(false, true)) {
          resolveNextHolder[0].run();
        }
      }

      @Override
      public void onServiceLost(NsdServiceInfo info) {}

      @Override
      public void onDiscoveryStopped(String regType) {}

      @Override
      public void onStartDiscoveryFailed(String regType, int errorCode) {
        finishOnce(call, results, lock, finished);
      }

      @Override
      public void onStopDiscoveryFailed(String regType, int errorCode) {}
    };

    try {
      nsdManager.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
    } catch (Exception e) {
      lock.release();
      call.reject(e.getMessage());
      return;
    }

    mainHandler.postDelayed(() -> {
      try {
        nsdManager.stopServiceDiscovery(discoveryListener);
      } catch (Exception e) {
        // already stopped/never started
      }
      // Give in-flight resolveService() callbacks a brief moment to land
      // rather than dropping devices found right at the deadline.
      mainHandler.postDelayed(() -> finishOnce(call, results, lock, finished), 400);
    }, timeoutMs);
  }

  private void finishOnce(PluginCall call, JSArray results, WifiManager.MulticastLock lock, AtomicBoolean finished) {
    if (!finished.compareAndSet(false, true)) return;
    try {
      if (lock.isHeld()) lock.release();
    } catch (Exception e) {
      // ignore
    }
    JSObject result = new JSObject();
    result.put("services", results);
    call.resolve(result);
  }
}
