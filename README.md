# SyncTroller for Android

Android port of [SyncTroller](https://github.com/seanpmackay/SyncTroller), a
standalone controller for the Philips Hue Play HDMI Sync Box. Discovers the
Sync Box (and optionally a Hue Bridge) on your Wi-Fi and controls power, HDMI
input, sync mode, intensity and brightness, with an ongoing notification while
syncing.

Everything talks directly to the Sync Box on your local network; nothing is
sent to any third-party server. See [PRIVACY.md](PRIVACY.md).

Not affiliated with or endorsed by Signify / Philips Hue.

## Build

Capacitor app: the web UI lives in `www/`, native plugins (mDNS discovery,
local HTTP, foreground sync notification) in
`android/app/src/main/java/com/seanmackay/synctroller/`.

```sh
npm install
npx cap sync android
cd android && ./gradlew assembleDebug     # or bundleRelease for the Play Store
```

Requires JDK 21 (`jdk21-openjdk` on Arch; the npm scripts set `JAVA_HOME` for it).

## License

MIT — see [LICENSE](LICENSE).
