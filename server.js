'use strict';

const express   = require('express');
const multer    = require('multer');
const cors      = require('cors');
const fs        = require('fs');
const path      = require('path');
const { spawn, execSync } = require('child_process');
const crypto    = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3001;

const PERSIST_DIR = path.join(__dirname, 'data_local');
const UPLOAD_DIR  = path.join(PERSIST_DIR, 'uploads');
const DATA_FILE   = path.join(PERSIST_DIR, 'state.json');
const LOG_FILE    = path.join(PERSIST_DIR, 'stream.log');
const PUBLIC_DIR  = path.join(__dirname, 'public');

[UPLOAD_DIR, PUBLIC_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

let state = loadState();
const activeStreams = new Map();
const streamLogs   = new Map();
const downloadQueue = new Map(); // videoId → {status, progress}

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/', express.static(PUBLIC_DIR));

// ── Storage ──────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(mp4|mov|avi|mkv|webm|flv|wmv|m4v|ts)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only video files allowed'));
  }
});

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/api/ffmpeg/check', (req, res) => {
  try {
    const v = execSync('ffmpeg -version 2>&1').toString().split('\n')[0];
    res.json({ ok: true, version: v });
  } catch {
    res.json({ ok: false, error: 'FFmpeg not found' });
  }
});

app.get('/api/status', (req, res) => {
  const streams = [];
  for (const [id, s] of activeStreams) {
    streams.push({
      id, slotId: s.slot.id, slotName: s.slot.name,
      platform: s.slot.platform, startTime: s.startTime,
      uptime: Math.floor((Date.now() - s.startTime) / 1000),
      currentVideo: s.videos[s.currentVideoIdx]?.name || '—',
      videoIndex: s.currentVideoIdx, totalVideos: s.videos.length,
    });
  }
  res.json({ ok: true, version: '3.0.0', uptime: Math.floor(process.uptime()), streams,
    totalVideos: state.videos.length, totalSlots: state.slots.length });
});

// ── Videos ───────────────────────────────────────────────────────────────────
app.get('/api/videos', (req, res) => {
  // Check which files exist, but keep URL-sourced videos (they can re-download)
  state.videos = state.videos.filter(v => {
    if (v.sourceUrl) return true; // URL videos: keep always
    return fs.existsSync(v.serverPath);
  });
  saveState();
  // Add download status
  const videos = state.videos.map(v => ({
    ...v,
    downloadStatus: downloadQueue.get(v.id) || null,
    fileExists: fs.existsSync(v.serverPath)
  }));
  res.json({ ok: true, videos });
});

app.post('/api/videos/upload', upload.array('videos', 20), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ ok: false, error: 'No files received' });
  const added = req.files.map(f => {
    const video = {
      id: crypto.randomUUID(), name: f.originalname, filename: f.filename,
      size: f.size, path: `/uploads/${f.filename}`,
      serverPath: path.join(UPLOAD_DIR, f.filename), addedAt: Date.now()
    };
    state.videos.push(video);
    return video;
  });
  saveState();
  res.json({ ok: true, added, total: state.videos.length });
});

app.delete('/api/videos/:id', (req, res) => {
  const idx = state.videos.findIndex(v => v.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Not found' });
  const [v] = state.videos.splice(idx, 1);
  try { if (!v.sourceUrl) fs.unlinkSync(v.serverPath); } catch {}
  downloadQueue.delete(v.id);
  saveState();
  res.json({ ok: true });
});

// ── Add video by URL (Google Drive / direct MP4) ──────────────────────────────
app.post('/api/videos/add-url', async (req, res) => {
  const { url, name } = req.body;
  if (!url) return res.status(400).json({ ok: false, error: 'url required' });

  const videoName = name || 'video.mp4';
  const filename  = `${Date.now()}_${videoName.replace(/[^a-z0-9._-]/gi,'_')}`;
  const dest      = path.join(UPLOAD_DIR, filename);

  // Convert Google Drive share link to direct download
  const directUrl = convertGDriveUrl(url);

  const video = {
    id: crypto.randomUUID(), name: videoName, filename,
    size: 0, path: `/uploads/${filename}`,
    serverPath: dest, addedAt: Date.now(),
    sourceUrl: directUrl  // ← save URL for auto re-download
  };

  state.videos.push(video);
  saveState();

  downloadQueue.set(video.id, { status: 'downloading', progress: 0 });
  res.json({ ok: true, message: 'Download started', video });

  // Start download
  startDownload(video.id, directUrl, dest);
});

// ── Update video URL (change source link) ────────────────────────────────────
app.put('/api/videos/:id/url', (req, res) => {
  const { url } = req.body;
  const video = state.videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ ok: false, error: 'Not found' });
  if (!url) return res.status(400).json({ ok: false, error: 'url required' });

  video.sourceUrl = convertGDriveUrl(url);
  // Delete old file if exists
  try { if (fs.existsSync(video.serverPath)) fs.unlinkSync(video.serverPath); } catch {}
  saveState();

  downloadQueue.set(video.id, { status: 'downloading', progress: 0 });
  startDownload(video.id, video.sourceUrl, video.serverPath);

  res.json({ ok: true, message: 'URL updated, re-downloading...' });
});

// ── Download status ───────────────────────────────────────────────────────────
app.get('/api/videos/:id/download-status', (req, res) => {
  const status = downloadQueue.get(req.params.id);
  res.json({ ok: true, status: status || null });
});

// ── Re-download a video ───────────────────────────────────────────────────────
app.post('/api/videos/:id/redownload', (req, res) => {
  const video = state.videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ ok: false, error: 'Not found' });
  if (!video.sourceUrl) return res.status(400).json({ ok: false, error: 'No source URL' });

  try { if (fs.existsSync(video.serverPath)) fs.unlinkSync(video.serverPath); } catch {}
  downloadQueue.set(video.id, { status: 'downloading', progress: 0 });
  startDownload(video.id, video.sourceUrl, video.serverPath);
  res.json({ ok: true, message: 'Re-downloading...' });
});

// ── Slots ─────────────────────────────────────────────────────────────────────
app.get('/api/slots', (req, res) => res.json({ ok: true, slots: state.slots }));

app.post('/api/slots', (req, res) => {
  const slot = {
    id: crypto.randomUUID(), name: req.body.name || 'New Slot',
    key: req.body.key || '', platform: req.body.platform || 'youtube',
    playlist: req.body.playlist || [], loop: req.body.loop !== false,
    quality: req.body.quality || '480p', status: 'idle', createdAt: Date.now()
  };
  state.slots.push(slot);
  saveState();
  res.json({ ok: true, slot });
});

app.put('/api/slots/:id', (req, res) => {
  const slot = state.slots.find(s => s.id === req.params.id);
  if (!slot) return res.status(404).json({ ok: false, error: 'Not found' });
  Object.assign(slot, req.body, { id: slot.id });
  saveState();
  res.json({ ok: true, slot });
});

app.delete('/api/slots/:id', (req, res) => {
  const i = state.slots.findIndex(s => s.id === req.params.id);
  if (i === -1) return res.status(404).json({ ok: false, error: 'Not found' });
  state.slots.splice(i, 1);
  saveState();
  res.json({ ok: true });
});

// ── Stream Control ────────────────────────────────────────────────────────────
app.post('/api/stream/start', async (req, res) => {
  const { slotId } = req.body;
  const slot = state.slots.find(s => s.id === slotId);
  if (!slot) return res.status(404).json({ ok: false, error: 'Slot not found' });
  if (!slot.key) return res.status(400).json({ ok: false, error: 'Stream key is empty' });
  if (!slot.playlist?.length) return res.status(400).json({ ok: false, error: 'Playlist is empty' });

  for (const [sid, s] of activeStreams) {
    if (s.slot.id === slotId)
      return res.status(409).json({ ok: false, error: 'Already streaming', streamId: sid });
  }

  // Auto re-download missing URL videos
  const missingUrlVideos = slot.playlist
    .map(id => state.videos.find(v => v.id === id))
    .filter(v => v && v.sourceUrl && !fs.existsSync(v.serverPath));

  if (missingUrlVideos.length > 0) {
    console.log(`[AutoDownload] Re-downloading ${missingUrlVideos.length} missing video(s)...`);
    for (const v of missingUrlVideos) {
      await new Promise(resolve => {
        downloadQueue.set(v.id, { status: 'downloading', progress: 0 });
        startDownload(v.id, v.sourceUrl, v.serverPath, resolve);
      });
    }
  }

  const videos = slot.playlist
    .map(id => state.videos.find(v => v.id === id))
    .filter(v => v && fs.existsSync(v.serverPath));

  if (!videos.length) return res.status(400).json({ ok: false, error: 'No valid video files. Download may have failed.' });

  const streamId = crypto.randomUUID();
  const obj = {
    slot, videos, rtmpUrl: buildRtmpUrl(slot.platform, slot.key),
    startTime: Date.now(), currentVideoIdx: 0, proc: null, stopped: false, restarts: 0
  };

  activeStreams.set(streamId, obj);
  streamLogs.set(streamId, []);
  slot.status = 'live';
  saveState();
  launchFFmpeg(streamId, obj);

  res.json({ ok: true, streamId, message: 'Streaming started' });
});

app.post('/api/stream/stop', (req, res) => {
  const { streamId, slotId } = req.body;
  if (streamId) { killStream(streamId); return res.json({ ok: true }); }
  if (slotId) {
    for (const [id, s] of activeStreams) if (s.slot.id === slotId) killStream(id);
    return res.json({ ok: true });
  }
  for (const id of [...activeStreams.keys()]) killStream(id);
  res.json({ ok: true });
});

app.get('/api/stream/status', (req, res) => {
  const streams = [];
  for (const [id, s] of activeStreams) {
    streams.push({
      id, slotId: s.slot.id, slotName: s.slot.name,
      startTime: s.startTime, uptime: Math.floor((Date.now() - s.startTime) / 1000),
      currentVideo: s.videos[s.currentVideoIdx]?.name || '—',
      videoIndex: s.currentVideoIdx, totalVideos: s.videos.length,
      platform: s.slot.platform, restarts: s.restarts
    });
  }
  res.json({ ok: true, active: streams.length, streams });
});

app.get('/api/stream/logs/:streamId', (req, res) => {
  const logs = streamLogs.get(req.params.streamId) || [];
  res.json({ ok: true, logs: logs.slice(-200) });
});

// ── Schedules ─────────────────────────────────────────────────────────────────
app.get('/api/schedules', (req, res) => res.json({ ok: true, schedules: state.schedules }));
app.post('/api/schedules', (req, res) => {
  const s = {
    id: crypto.randomUUID(), slotId: req.body.slotId, startAt: req.body.startAt,
    stopAt: req.body.stopAt || null, repeat: req.body.repeat || 'none',
    status: 'scheduled', createdAt: Date.now()
  };
  state.schedules.push(s); saveState(); armSchedule(s);
  res.json({ ok: true, schedule: s });
});
app.delete('/api/schedules/:id', (req, res) => {
  const i = state.schedules.findIndex(s => s.id === req.params.id);
  if (i === -1) return res.status(404).json({ ok: false, error: 'Not found' });
  state.schedules.splice(i, 1); saveState();
  res.json({ ok: true });
});

// ── FFmpeg ────────────────────────────────────────────────────────────────────
function launchFFmpeg(streamId, obj) {
  if (obj.stopped) return;
  const video = obj.videos[obj.currentVideoIdx];
  if (!video) {
    if (obj.slot.loop) { obj.currentVideoIdx = 0; return launchFFmpeg(streamId, obj); }
    return killStream(streamId);
  }

  // If file missing but has sourceUrl → re-download then retry
  if (!fs.existsSync(video.serverPath) && video.sourceUrl) {
    log(streamId, `⚠ File missing, re-downloading: ${video.name}`);
    downloadQueue.set(video.id, { status: 'downloading', progress: 0 });
    startDownload(video.id, video.sourceUrl, video.serverPath, () => {
      if (!obj.stopped) setTimeout(() => launchFFmpeg(streamId, obj), 1000);
    });
    return;
  }

  const q   = qualityPreset(obj.slot.quality || '480p');
  const url = obj.rtmpUrl;
  const args = [
    '-re', '-i', video.serverPath,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-maxrate', q.vbr, '-bufsize', q.buf, '-pix_fmt', 'yuv420p',
    '-r', '25', '-g', '50',
    '-vf', `scale=${q.res}:force_original_aspect_ratio=decrease,pad=${q.res}:(ow-iw)/2:(oh-ih)/2`,
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-f', 'flv', '-flvflags', 'no_duration_filesize', url
  ];

  log(streamId, `▶ Starting: ${video.name}`);
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  obj.proc = proc;
  let buf = '';
  const onData = chunk => {
    buf += chunk.toString();
    const lines = buf.split(/[\r\n]/); buf = lines.pop();
    lines.forEach(l => { if (l.trim()) log(streamId, l); });
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', (code, sig) => {
    log(streamId, `⏹ FFmpeg exited — code=${code}`);
    if (obj.stopped) return;
    if (code === 0) {
      obj.currentVideoIdx++;
      if (obj.currentVideoIdx >= obj.videos.length) {
        if (obj.slot.loop) obj.currentVideoIdx = 0;
        else return killStream(streamId);
      }
    } else {
      obj.restarts++;
      log(streamId, `⚠ Restart #${obj.restarts} in 5s...`);
    }
    setTimeout(() => launchFFmpeg(streamId, obj), code === 0 ? 1000 : 5000);
  });
  proc.on('error', err => {
    log(streamId, `✖ ${err.message}`);
    if (!obj.stopped) setTimeout(() => launchFFmpeg(streamId, obj), 5000);
  });
}

function killStream(streamId) {
  const s = activeStreams.get(streamId);
  if (!s) return;
  s.stopped = true;
  try { s.proc?.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { s.proc?.kill('SIGKILL'); } catch {} }, 3000);
  activeStreams.delete(streamId);
  const slot = state.slots.find(sl => sl.id === s.slot.id);
  if (slot) { slot.status = 'idle'; saveState(); }
}

function buildRtmpUrl(platform, key) {
  if (platform === 'youtube')  return `rtmp://a.rtmp.youtube.com/live2/${key}`;
  if (platform === 'facebook') return `rtmps://live-api-s.facebook.com:443/rtmp/${key}`;
  if (platform === 'twitch')   return `rtmp://live.twitch.tv/live/${key}`;
  return key;
}

function qualityPreset(q) {
  return {
    '1080p': { res: '1920:1080', vbr: '4000k', buf: '8000k' },
    '720p':  { res: '1280:720',  vbr: '2500k', buf: '5000k' },
    '480p':  { res: '854:480',   vbr: '1000k', buf: '2000k' },
    '360p':  { res: '640:360',   vbr:  '600k', buf: '1200k' },
  }[q] || { res: '854:480', vbr: '1000k', buf: '2000k' };
}

// ── Download helper ───────────────────────────────────────────────────────────
function startDownload(videoId, url, dest, callback) {
  console.log(`[Download] Starting: ${url}`);
  const proc = spawn('wget', ['--no-check-certificate', '-O', dest, url], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.on('exit', code => {
    if (code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
      const video = state.videos.find(v => v.id === videoId);
      if (video) { video.size = fs.statSync(dest).size; saveState(); }
      downloadQueue.set(videoId, { status: 'done', progress: 100 });
      console.log(`[Download] Done: ${dest}`);
      if (callback) callback(true);
    } else {
      try { fs.unlinkSync(dest); } catch {}
      downloadQueue.set(videoId, { status: 'failed', progress: 0 });
      console.error(`[Download] Failed: ${url}`);
      if (callback) callback(false);
    }
  });
  proc.on('error', err => {
    downloadQueue.set(videoId, { status: 'failed', error: err.message });
    if (callback) callback(false);
  });
}

function convertGDriveUrl(url) {
  // Convert Google Drive share URL to direct download URL
  const match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (match) {
    return `https://drive.google.com/uc?export=download&confirm=t&id=${match[1]}`;
  }
  // Already direct or other URL
  return url;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
function armSchedule(sched) {
  const ms = new Date(sched.startAt).getTime() - Date.now();
  if (ms < -60_000) return;
  setTimeout(() => {
    const slot = state.slots.find(s => s.id === sched.slotId);
    if (!slot) return;
    const videos = slot.playlist.map(id => state.videos.find(v => v.id === id)).filter(v => v && fs.existsSync(v.serverPath));
    if (!videos.length) return;
    const streamId = crypto.randomUUID();
    const obj = { slot, videos, rtmpUrl: buildRtmpUrl(slot.platform, slot.key),
      startTime: Date.now(), currentVideoIdx: 0, proc: null, stopped: false, restarts: 0 };
    activeStreams.set(streamId, obj); streamLogs.set(streamId, []);
    slot.status = 'live'; sched.status = 'running'; sched.streamId = streamId; saveState();
    launchFFmpeg(streamId, obj);
    if (sched.stopAt) {
      const stopMs = new Date(sched.stopAt).getTime() - Date.now();
      if (stopMs > 0) setTimeout(() => killStream(streamId), stopMs);
    }
  }, Math.max(0, ms));
}

// ── Persistence ───────────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {}
  return { videos: [], slots: [], schedules: [], settings: {} };
}

function saveState() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); } catch (e) {
    console.error('saveState error:', e.message);
  }
}

function log(streamId, msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  const arr = streamLogs.get(streamId);
  if (arr) { arr.push(line); if (arr.length > 500) arr.shift(); }
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// Heartbeat
setInterval(() => {
  for (const [id, s] of activeStreams) {
    if (!s.stopped && s.proc?.exitCode != null) killStream(id);
  }
}, 20_000);

// Auto re-download missing URL videos on startup
setTimeout(async () => {
  const urlVideos = state.videos.filter(v => v.sourceUrl && !fs.existsSync(v.serverPath));
  for (const v of urlVideos) {
    console.log(`[Startup] Re-downloading missing video: ${v.name}`);
    downloadQueue.set(v.id, { status: 'downloading', progress: 0 });
    startDownload(v.id, v.sourceUrl, v.serverPath);
  }
}, 3000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔════════════════════════════════════════════╗
║  StreamLoop v3.0 — Ready                  ║
║  http://0.0.0.0:${String(PORT).padEnd(27)}║
╚════════════════════════════════════════════╝\n`);
  (state.schedules || []).filter(s => s.status === 'scheduled').forEach(armSchedule);
});

process.on('SIGTERM', () => { [...activeStreams.keys()].forEach(killStream); process.exit(0); });
process.on('SIGINT',  () => { [...activeStreams.keys()].forEach(killStream); process.exit(0); });
