# App Store Submission Guide

Chaptr is shipped as a **PWA** (installable from any modern browser) and is one Capacitor wrap away from the **Apple App Store** and **Google Play Store**. This doc walks you through both paths.

---

## Path A — Ship as a PWA (free, no review process)

This is already done. Anyone can install Chaptr as an app right now:

### iOS Safari
1. Open `https://chaptr-app.github.io/chaptr/` in Safari
2. Tap the share icon → **Add to Home Screen**
3. Chaptr appears as an app icon, launches full-screen, syncs via the Worker

### Android Chrome / Edge
1. Open the same URL
2. Tap the menu → **Install app** (or get an "Install Chaptr" prompt automatically)
3. Same experience

This works because we ship `manifest.json` + a service worker + proper apple-touch-icon meta tags. No app stores, no review process, no $99/year. Updates land instantly when you push.

**Limitations vs. native:**
- iOS: no push notifications until iOS 16.4+ (already supported in modern iOS), no haptics from web
- No store discovery — users have to find the URL

If that's enough, you're done. If you want store presence, continue to Path B.

---

## Path B — Wrap with Capacitor for the App Stores

Capacitor turns the existing PWA into native iOS + Android apps without rewriting. Estimated time: half a day end-to-end.

### Prerequisites

- **Mac** (for iOS — required by Apple)
- **Xcode** (free, App Store)
- **Android Studio** (free)
- **Apple Developer Program** account ($99/year)
- **Google Play Console** account ($25 one-time)
- Node.js 18+

### One-time setup

```bash
# From a NEW directory (sibling to chaptr, not inside it)
mkdir chaptr-native && cd chaptr-native
npm init -y
npm install --save @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android

# Initialize Capacitor with your bundle id
npx cap init Chaptr com.chaptr.app --web-dir=www
```

When prompted:
- App name: `Chaptr`
- Package ID: `com.chaptr.app` (use your own reverse-DNS)

### Capacitor config

Edit `capacitor.config.json`:

```json
{
  "appId": "com.chaptr.app",
  "appName": "Chaptr",
  "webDir": "www",
  "server": {
    "url": "https://chaptr-app.github.io/chaptr",
    "cleartext": false
  },
  "plugins": {
    "SplashScreen": {
      "launchShowDuration": 1000,
      "backgroundColor": "#FAF7F2"
    }
  }
}
```

The `server.url` trick means the app loads the live website. **You don't need to bundle the HTML/CSS/JS into the binary.** Updates ship instantly via GitHub Pages — no app store re-review for code changes.

(If Apple rejects this for being "too web-like", switch to bundling: copy the `chaptr/` folder contents into `www/` and remove `server.url`.)

### Add the platforms

```bash
mkdir www
echo "<!doctype html><meta http-equiv=refresh content='0;url=https://chaptr-app.github.io/chaptr/today.html'>" > www/index.html
npx cap add ios
npx cap add android
npx cap sync
```

### Generate icons + splash screens

```bash
npm install --save-dev @capacitor/assets

# Drop a 1024x1024 PNG named icon.png and a splash.png in resources/
mkdir resources
# (Use your icon.svg — convert to PNG at 1024px via any tool, e.g. https://cloudconvert.com)

npx capacitor-assets generate
```

This produces every iOS + Android icon/splash size automatically.

### Open in Xcode (iOS)

```bash
npx cap open ios
```

In Xcode:
1. Select the project → **Signing & Capabilities** → check "Automatically manage signing"
2. Pick your Apple Developer team
3. Hit ▶ to run on a simulator or your phone (you need to plug it in once, trust the developer cert in Settings → General → VPN & Device Management)

### Open in Android Studio

```bash
npx cap open android
```

In Android Studio:
1. Wait for Gradle sync
2. Hit ▶ to run on an emulator

### Submit to App Store

1. **App Store Connect** (https://appstoreconnect.apple.com) → My Apps → "+" → New App
   - Bundle ID: `com.chaptr.app`
   - Name: Chaptr
   - SKU: `chaptr-001`
2. Fill out the **App Information** tab:
   - Privacy Policy URL: `https://chaptr-app.github.io/chaptr/privacy.html`
   - Category: Books
3. **Pricing & Availability** — set to Free
4. **App Privacy** — declare what data you collect (read `privacy.html`):
   - Identifiers: Device ID + (Optional) User ID — for cloud sync
   - User Content: Reviews + book metadata
   - Diagnostics: None
5. **Version** tab:
   - Description: pull from `about.html`
   - Keywords: `reading, books, habit, claude, ai, library, goodreads, bookly`
   - Support URL: `https://github.com/chaptr-app/chaptr`
   - Marketing URL: `https://chaptr-app.github.io/chaptr/`
   - Screenshots: required at 6.5" iPhone size (1242 × 2688). Take these in the iOS Simulator.
6. **Review Information**:
   - If you used `server.url`, add a note: *"This app loads its web app from chaptr-app.github.io/chaptr — see Privacy Policy for details. To test, sign in with email Y, the magic link will arrive instantly."*
7. Build in Xcode: **Product → Archive** → Distribute App → App Store Connect → Upload
8. In App Store Connect, attach the build to the version and submit for review.

Apple usually reviews in 24–48 hours.

### Submit to Google Play

1. **Play Console** (https://play.google.com/console) → All apps → Create app
   - Name: Chaptr
   - Default language: English
   - Free, with in-app purchases: No
2. Fill out the **Store listing** (description, screenshots, icon, feature graphic 1024x500)
3. **Content rating** questionnaire — straightforward for a books app
4. **Data safety** — same disclosures as Apple
5. **Build → Production**: upload the AAB Android Studio produces (Build → Generate Signed App Bundle)
6. Submit for review. Google is faster — usually a few hours to a couple days.

---

## Things to fix BEFORE submitting

The PWA is shipped, but here's a pre-flight checklist for app stores:

### Required
- [ ] Replace `icon.svg` with a polished icon designed at 1024×1024 (current is just "C" in a square)
- [ ] Take real screenshots in iOS Simulator + Android Studio at the required sizes (6.5" iPhone + Android phone + tablet)
- [ ] Convert `icon.svg` to PNG at 192×192 and 512×512 for the manifest icon-192.png and icon-512.png references (currently they 404)
- [ ] Set `start_url` in `manifest.json` to your final domain (currently `/chaptr/today.html`)
- [ ] Replace the placeholder `support@chaptr.app` and GitHub URLs with your real contact info

### Strongly recommended
- [ ] Add an "About" section with developer info (legal name, contact)
- [ ] Set up a status page or feedback form (the GitHub issue tracker counts)
- [ ] Test sync on three devices to verify Clerk + D1 hold up
- [ ] Verify all Worker URLs respond from outside your network

### Nice-to-have for polish
- [ ] Add Apple's required APN entitlement if you want push notifications
- [ ] Add `@capacitor/haptics` to wire native haptic feedback into the timer start/stop
- [ ] Add `@capacitor/share` so reviews can be shared natively
- [ ] Add `@capacitor/preferences` if you want native key-value storage instead of localStorage (only worth it if you migrate off the server-snapshot model)

---

## Cost summary

| Item | Cost |
|---|---|
| Apple Developer Program | $99/year |
| Google Play Developer Account | $25 one-time |
| Cloudflare (Worker + D1) | Free tier covers tens of thousands of MAU |
| Anthropic Claude (Haiku 4.5) | ~$0.003 per Ask Claude / persona / book-fit / chapter recap call |
| Clerk auth | Free up to 10,000 MAU |
| GitHub Pages hosting | Free |
| Domain (optional, e.g. `chaptr.app`) | ~$15/year |

A typical user costs you maybe 5¢ a year in Anthropic fees. The break-even point is far away.

---

## Ongoing operations

- **Code updates**: push to main → GitHub Pages rebuilds → live in 30s. If you used `server.url` in capacitor.config, native users get the update too without re-submitting.
- **Worker updates**: `cd worker && npx wrangler deploy`
- **D1 schema changes**: `npx wrangler d1 execute chaptr-db --remote --file=schema.sql` (idempotent — `IF NOT EXISTS` everywhere)
- **Monitoring**: Cloudflare Workers dashboard shows request counts + errors. Anthropic console shows API usage.
- **Backups**: D1 has automatic Cloudflare-managed backups; you can also export your snapshots periodically via the `/load` endpoint.

That's everything. Good luck.
