# APK downloads for the website

The Android app file **must be committed to git** so Vercel/GitHub deploys serve it:

```
public/downloads/scorr.apk
```

Rebuild after app changes:

```bash
node scripts/build-android-apk.mjs
git add public/downloads/scorr.apk
git commit -m "Update Android APK"
git push
```
