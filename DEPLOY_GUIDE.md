# StreamLoop — Google Cloud Run Deploy Guide
## Card ছাড়া, সম্পূর্ণ Free — ধাপে ধাপে সম্পূর্ণ গাইড

---

## আগে জানো: কেন Google Cloud Run?

- ✅ **Card লাগে না** — শুধু Google account
- ✅ **FFmpeg চলে** — Docker container-এ pre-installed
- ✅ **Free tier বিশাল** — মাসে ১৮০,০০০ vCPU-seconds (24/7-এর জন্য যথেষ্ট)
- ✅ **Auto-scale** — traffic নেই? cost নেই
- ✅ **HTTPS URL** পাবে — `https://streamloop-xxxxx-xx.a.run.app`

---

## ধাপ ১ — GitHub Repository তৈরি

### ১.১ GitHub-এ যাও
1. https://github.com খোলো
2. Sign in করো (account না থাকলে sign up করো — সম্পূর্ণ free)

### ১.২ New Repository
1. উপরে ডানে **"+"** → **"New repository"**
2. এভাবে fill করো:
   ```
   Repository name:  streamloop
   Description:      YouTube 24/7 Live Streaming
   Visibility:       ● Private   ← stream key সুরক্ষিত থাকবে
   ☑ Add a README file
   ```
3. **"Create repository"** চাপো

### ১.৩ ফাইল Upload করো
1. Repository-তে যাও
2. **"Add file"** → **"Upload files"**
3. ZIP থেকে extract করা এই ফাইলগুলো drag করো:
   - `server.js`
   - `package.json`
   - `Dockerfile`
   - `.dockerignore`
   - `.gitignore`
4. **"public"** folder-এর জন্য:
   - **"Add file"** → **"Create new file"**
   - নাম দাও: `public/index.html`
   - `index.html`-এর পুরো content paste করো
5. **"Commit changes"** চাপো

### GitHub-এ এই structure হওয়া দরকার:
```
streamloop/
├── Dockerfile
├── .dockerignore
├── .gitignore
├── server.js
├── package.json
└── public/
    └── index.html
```

---

## ধাপ ২ — Google Cloud Console Setup

### ২.১ Google Cloud Console খোলো
1. https://console.cloud.google.com এ যাও
2. তোমার Google account দিয়ে sign in করো
3. **"Try for free"** বা সরাসরি Console-এ যাও

### ২.২ নতুন Project তৈরি
1. উপরে project dropdown → **"New Project"**
2. নাম দাও: `streamloop-project`
3. **"Create"** চাপো
4. কিছুক্ষণ অপেক্ষা করো, তারপর নতুন project select করো

### ২.৩ Cloud Run API চালু করো
1. বাম মেনু → **"APIs & Services"** → **"Enable APIs"**
2. Search করো: `Cloud Run Admin API`
3. **"Enable"** চাপো
4. আবার Search করো: `Cloud Build API`
5. **"Enable"** চাপো

---

## ধাপ ৩ — Cloud Shell থেকে Deploy (সবচেয়ে সহজ)

### ৩.১ Cloud Shell খোলো
1. Google Cloud Console-এর উপরে ডানে **terminal icon** (>_) চাপো
2. **"Continue"** চাপো — একটা free Linux terminal খুলবে

### ৩.২ GitHub থেকে code নামাও
Cloud Shell-এ এই commands টাইপ করো:

```bash
# GitHub থেকে code নামাও
git clone https://github.com/তোমার-username/streamloop.git
cd streamloop
```

(তোমার GitHub username দিয়ে replace করো)

### ৩.৩ Deploy করো — একটাই command!
```bash
gcloud run deploy streamloop \
  --source . \
  --platform managed \
  --region asia-southeast1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --timeout 3600 \
  --min-instances 1 \
  --max-instances 3
```

**প্রতিটি option মানে:**
- `--source .` → এই folder থেকে Docker build করো
- `--region asia-southeast1` → Singapore (Bangladesh-এর কাছে)
- `--allow-unauthenticated` → dashboard publicly accessible
- `--memory 2Gi` → FFmpeg-এর জন্য RAM
- `--cpu 2` → video encoding-এর জন্য CPU
- `--timeout 3600` → ১ ঘণ্টা পর্যন্ত connection রাখো
- `--min-instances 1` → সবসময় একটা instance চলে (24/7)

### ৩.৪ Deploy শেষ হলে
কিছুক্ষণ পর দেখাবে:
```
Service URL: https://streamloop-xxxxxxx-as.a.run.app
```

**এই URL-টা copy করো** — এটাই তোমার dashboard!

---

## ধাপ ৪ — প্রথমবার ব্যবহার

### ৪.১ Dashboard খোলো
```
https://streamloop-xxxxxxx-as.a.run.app
```
**"🟢 Server Connected"** দেখলে সফল!

### ৪.২ YouTube Stream Key নাও
1. https://studio.youtube.com যাও
2. বাম মেনু → **"Go Live"** (বা Create → Go Live)
3. উপরে **"Stream"** tab
4. **Stream key** copy করো
5. **Stream type: "Persistent stream"** রাখো ← গুরুত্বপূর্ণ!

### ৪.৩ Slot তৈরি করো
1. Dashboard → **Live Slots** → **+ New Slot**
2. Fill করো:
   - Slot Name: `My YouTube 24/7`
   - Platform: `YouTube`
   - Stream Key: paste করো
   - Loop: `On`
3. **"💾 Save Slot"** — এখন playlist এ video add দরকার

### ৪.৪ Video Upload
1. **Videos** page
2. **Select File** চাপো → MP4 file choose করো
3. Upload শেষ পর্যন্ত অপেক্ষা করো

### ৪.৫ Playlist-এ Video যোগ করো
1. **Live Slots** → slot-এ click করো
2. Library-তে video-এর checkbox-এ click করো
3. **"💾 Save Slot"**

### ৪.৬ LIVE শুরু করো!
1. **"▶ Save & Go Live"** চাপো
2. Dashboard-এ **🔴 LIVE** দেখাবে
3. YouTube Studio-তে stream data আসছে কিনা দেখো
4. YouTube-এ **"Go Live"** চাপো — দর্শকরা দেখতে পাবে! 🎉

---

## ধাপ ৫ — Code update হলে redeploy

GitHub-এ নতুন file push করলে:
```bash
cd streamloop
git pull
gcloud run deploy streamloop --source . --region asia-southeast1
```

---

## ❓ সমস্যা হলে

**"Server offline" দেখাচ্ছে?**
- `--min-instances 1` দিয়েছিলে কিনা দেখো
- Cloud Run console → Service → এর state check করো

**Build fail হচ্ছে?**
- Cloud Console → Cloud Build → History → failed build-এ click করে logs দেখো
- সবচেয়ে সাধারণ error: `package.json` missing

**FFmpeg কাজ করছে না?**
- Dashboard → `https://your-url.a.run.app/api/ffmpeg/check` → দেখো
- Dockerfile ঠিকঠাক আছে কিনা verify করো

**YouTube stream যাচ্ছে না?**
- Stream key সঠিক কিনা দেখো
- YouTube Studio → Go Live → Stream tab-এ "Stream Status: Good" আছে কিনা দেখো
- Cloud Run Logs-এ FFmpeg output দেখো

---

## Free Tier কতটুকু পাবে?

Google Cloud Run free tier (প্রতি মাসে):
| Resource | Free limit | 24/7 streaming-এ কতটুকু লাগে |
|----------|-----------|-------------------------------|
| vCPU-seconds | 180,000 | ~1,800 ঘণ্টা (1 CPU) |
| Memory (GB-seconds) | 360,000 | যথেষ্ট |
| Requests | 2 million | যথেষ্ট |
| Network egress | 1 GB | ⚠️ বাড়তে পারে (video streaming) |

**সতর্কতা:** Network egress (data বাইরে যাওয়া) বেশি হলে charge হতে পারে।
720p streaming-এ প্রতি ঘণ্টায় ~1-2 GB data যায় YouTube-এ।
Free tier: 1 GB/month → তারপর $0.08/GB। মাসে $5-10 হতে পারে।

**সমাধান:** আপাতত কম bitrate (480p) দিয়ে test করো।

---

## Quick Reference

| কাজ | কোথায় |
|-----|-------|
| Dashboard | `https://your-url.a.run.app` |
| API status | `https://your-url.a.run.app/api/status` |
| FFmpeg check | `https://your-url.a.run.app/api/ffmpeg/check` |
| Cloud Logs | console.cloud.google.com → Cloud Run → streamloop → Logs |
| YouTube Stream Key | studio.youtube.com → Go Live → Stream |
