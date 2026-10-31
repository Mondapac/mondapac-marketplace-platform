# MondaPac Android app (Trusted Web Activity)

A thin Android shell that opens the buyer site (`apps/web`) full screen through Chrome as a
Trusted Web Activity (TWA). There is no app code: pages, login, cart and checkout are the web
app. It uses `com.google.androidbrowserhelper` (`LauncherActivity`).

- Package name: `au.com.mondapac.store`
- Host: `twaHost` in `gradle.properties` (placeholder `mondapac.com.au`; override with `-PtwaHost=...`)
- Start URL and theme colours follow `apps/web/app/manifest.ts` and `src/pwa/pwa-config.ts`
- Icons are the web placeholder icons; the real brand icon waits for the brand name

## Digital Asset Links (the site side)

The site serves `/.well-known/assetlinks.json` (`apps/web/app/.well-known/assetlinks.json/route.ts`).
Set `TWA_CERT_SHA256` on the web server to the comma-separated SHA-256 fingerprints of the signing
keys. With it empty, no app is trusted and Chrome shows the browser address bar (fallback mode).

Two fingerprints are needed: the debug key (to test a debug APK) and the Play App Signing key
(shown in Play Console, "App signing"). The upload key is not the one users get.

## Debug build

Needs JDK 17+ and the Android SDK (platform 35). Then:

```
cd apps/twa
./gradlew :app:assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android | grep SHA256
```

Put that debug fingerprint into `TWA_CERT_SHA256` on a test deployment served over HTTPS at the
same host, then install the APK. Chrome 72+ is required on the phone.

## Not in this folder, on purpose

- Release signing keys and any Play Console upload (john only; never commit keys).
- Play listing, screenshots, data-safety form, content rating.
- Service-worker kill switch and the Track button are open items from the mobile plan.
