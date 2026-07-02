# APK downloads for the website

After building the Android app, the APK is placed here:

```
public/downloads/scorr.apk
```

Build command:

```bash
node scripts/build-android-apk.mjs
```

Then deploy the website so users can download from **Mobile App** on the landing page.

**Note:** Git may exclude large `.apk` files. Upload to your host/CDN or attach during deploy as needed.
