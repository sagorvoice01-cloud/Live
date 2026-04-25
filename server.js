/**
 * ╔══════════════════════════════════════════════╗
 * ║  StreamLoop Server v3.0 — Render.com Edition ║
 * ║  Node.js + FFmpeg → YouTube / Facebook RTMP  ║
 * ╚══════════════════════════════════════════════╝
 *
 * Render.com features used:
 *  - Persistent Disk mounted at /var/data  (keeps videos across restarts)
 *  - Environment variables for config
 *  - PORT auto-assigned by Render
 *
 * FFmpeg is pre-installed on Render's Docker image via render.yaml buildCommand
 */

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

// ─── Persistent storage path ─────────────────────────────────────────────────
// On Render: persistent disk is mounted at /var/data
// Locally: falls back to ./data_local
const IS_RENDER   = !!process.env.RENDER;
const PERSIST_DIR = IS_RENDER ? '/var/data' : path.join(__dirname, 'data_local');
const UPLOAD_DIR  = path.join(PERSIST_DIR, 'uploads');
const DATA_FILE   = path.join(PERSIST_DIR, 'state.json');
const LOG_FILE    = path.join(PERSIST_DIR, 'stream.log');
const PUBLIC_DIR  = path.join(__dirname, 'public');

// Ensure directories exist
[UPLOAD_DIR, PUBLIC_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── State ───────────────────────────────────────────────────────────────────
let state = loadState();
const activeStreams = new Map();   // streamId → streamObj
const streamLogs   = new Map();   // streamId → string[]

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/', express.static(PUBLIC_DIR));

// Security: basic API key check (optional — set API_KEY env var to enable)
app.use('/api', (req, res, next) => {
  const key = process.env.API_KEY;
  if (!key) return next();
  const provided = req.headers['x-api-key'] || req.query.apikey;
  if (provided !== key) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
});

// ─── Upload config ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4GB max
  fileFilter: (req, file, cb) => {
    if (/\.(mp4|mov|avi|mkv|webm|flv|wmv|m4v|ts)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only video files allowed'));
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  ROUTES — HEALTH & INFO
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/api/status', (req, res) => {
  const streams = [];
  for (const [id, s] of activeStreams) {
    streams.push({
      id,
      slotId:       s.slot.id,
      slotName:     s.slot.name,
      platform:     s.slot.platform,
      startTime:    s.startTime,
      uptime:       Math.floor((Date.now() - s.startTime) / 1000),
      currentVideo: s.videos[s.currentVideoIdx]?.name || '—',
      videoIndex:   s.currentVideoIdx,
      totalVideos:  s.videos.length,
    });
  }
  res.json({
    ok:         true,
    version:    '3.0.0',
    platform:   IS_RENDER ? 'Render.com' : 'local',
    uptime:     Math.floor(process.uptime()),
    uploadDir:  UPLOAD_DIR,
    diskFree:   getDiskFree(),
    streams,
    totalVideos: state.videos.length,
    totalSlots:  state.slots.length
  });
});

app.get('/api/ffmpeg/check', (req, res) => {
  try {
    const v = execSync('ffmpeg -version 2>&1').toString().split('\n')[0];
    res.json({ ok: true, version: v });
  } catch {
    res.json({ ok: false, error: 'FFmpeg not found' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  ROUTES — VIDEOS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/videos', (req, res) => {
  // Verify files still exist (disk might have been cleared)
  state.videos = state.videos.filter(v => fs.existsSync(v.serverPath));
  saveState();
  res.json({ ok: true, videos: state.videos });
});

app.post('/api/videos/upload', upload.array('videos', 20), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ ok: false, error: 'No files received' });
  const added = req.files.map(f => {
    const video = {
      id:         crypto.randomUUID(),
      name:       f.originalname,
      filename:   f.filename,
      size:       f.size,
      path:       `/uploads/${f.filename}`,
      serverPath: path.join(UPLOAD_DIR, f.filename),
      addedAt:    Date.now()
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
  try { fs.unlinkSync(v.serverPath); } catch {}
  saveState();
  res.json({ ok: true });
});

// Add video by URL (Render can download it)
app.post('/api/videos/add-url', async (req, res) => {
  const { url, name } = req.body;
  if (!url) return res.status(400).json({ ok: false, error: 'url required' });
  const filename = `${Date.now()}_${(name || 'video').replace(/[^a-z0-9._-]/gi,'_')}.mp4`;
  const dest     = path.join(UPLOAD_DIR, filename);
  res.json({ ok: true, message: 'Download started in background', filename });
  // Download in background
  const proc = spawn('wget', ['-O', dest, url], { stdio: 'ignore' });
  proc.on('exit', code => {
    if (code === 0 && fs.existsSync(dest)) {
      const video = {
        id: crypto.randomUUID(), name: name || filename, filename,
        size: fs.statSync(dest).size, path: `/uploads/${filename}`,
        serverPath: dest, addedAt: Date.now()
      };
      state.videos.push(video);
      saveState();
      console.log(`[URL Download] Done: ${name}`);
    } else {
      try { fs.unlinkSync(dest); } catch {}
      console.error(`[URL Download] Failed for ${url}`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  ROUTES — SLOTS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/slots', (req, res) => res.json({ ok: true, slots: state.slots }));

app.post('/api/slots', (req, res) => {
  const slot = {
    id:        crypto.randomUUID(),
    name:      req.body.name     || 'New Slot',
    key:       req.body.key      || '',
    platform:  req.body.platform || 'youtube',
    playlist:  req.body.playlist || [],
    loop:      req.body.loop !== false,
    quality:   req.body.quality  || '720p',
    status:    'idle',
    createdAt: Date.now()
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

// ══════════════════════════════════════════════════════════════════════════════
//  ROUTES — STREAM CONTROL
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/stream/start', (req, res) => {
  const { slotId } = req.body;
  const slot = state.slots.find(s => s.id === slotId);
  if (!slot)             return res.status(404).json({ ok: false, error: 'Slot not found' });
  if (!slot.key)         return res.status(400).json({ ok: false, error: 'Stream key is empty. Set it in the slot settings.' });
  if (!slot.playlist?.length)
                         return res.status(400).json({ ok: false, error: 'Playlist is empty. Add videos first.' });

  // Already streaming?
  for (const [sid, s] of activeStreams) {
    if (s.slot.id === slotId)
      return res.status(409).json({ ok: false, error: 'Already streaming', streamId: sid });
  }

  // Resolve + validate video files
  const videos = slot.playlist
    .map(id => state.videos.find(v => v.id === id))
    .filter(v => v && fs.existsSync(v.serverPath));

  if (!videos.length)
    return res.status(400).json({ ok: false, error: 'No valid video files found. Videos may have been deleted.' });

  const streamId = crypto.randomUUID();
  const obj = {
    slot,
    videos,
    rtmpUrl:         buildRtmpUrl(slot.platform, slot.key),
    startTime:       Date.now(),
    currentVideoIdx: 0,
    proc:            null,
    stopped:         false,
    restarts:        0
  };

  activeStreams.set(streamId, obj);
  streamLogs.set(streamId, []);
  slot.status = 'live';
  saveState();

  launchFFmpeg(streamId, obj);

  res.json({
    ok: true,
    streamId,
    message: `Streaming started → ${obj.rtmpUrl.replace(/\/[^/]+$/, '/***')}`,
  });
});

app.post('/api/stream/stop', (req, res) => {
  const { streamId, slotId } = req.body;
  if (streamId) {
    killStream(streamId);
    return res.json({ ok: true });
  }
  if (slotId) {
    for (const [id, s] of activeStreams) if (s.slot.id === slotId) killStream(id);
    return res.json({ ok: true });
  }
  for (const id of [...activeStreams.keys()]) killStream(id);
  res.json({ ok: true, message: 'All streams stopped' });
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

// ══════════════════════════════════════════════════════════════════════════════
//  ROUTES — SCHEDULES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/schedules',    (req, res) => res.json({ ok: true, schedules: state.schedules }));

app.post('/api/schedules', (req, res) => {
  const s = {
    id: crypto.randomUUID(),
    slotId:  req.body.slotId,
    startAt: req.body.startAt,
    stopAt:  req.body.stopAt || null,
    repeat:  req.body.repeat || 'none',  // none | daily | weekly
    status:  'scheduled',
    createdAt: Date.now()
  };
  state.schedules.push(s);
  saveState();
  armSchedule(s);
  res.json({ ok: true, schedule: s });
});

app.delete('/api/schedules/:id', (req, res) => {
  const i = state.schedules.findIndex(s => s.id === req.params.id);
  if (i === -1) return res.status(404).json({ ok: false, error: 'Not found' });
  state.schedules.splice(i, 1);
  saveState();
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
//  FFMPEG ENGINE
// ══════════════════════════════════════════════════════════════════════════════

function launchFFmpeg(streamId, obj) {
  if (obj.stopped) return;

  const video = obj.videos[obj.currentVideoIdx];
  if (!video) {
    if (obj.slot.loop) {
      obj.currentVideoIdx = 0;
      return launchFFmpeg(streamId, obj);
    }
    return killStream(streamId);
  }

  const q   = qualityPreset(obj.slot.quality || '720p');
  const url = obj.rtmpUrl;

  // Build FFmpeg args
  const args = [
    // Input
    '-re',
    '-i', video.serverPath,
    // Video
    '-c:v',    'libx264',
    '-preset', 'veryfast',
    '-tune',   'zerolatency',
    '-maxrate', q.vbr,
    '-bufsize', q.buf,
    '-pix_fmt', 'yuv420p',
    '-r',       '25',
    '-g',       '50',
    '-vf',      `scale=${q.res}:force_original_aspect_ratio=decrease,pad=${q.res}:(ow-iw)/2:(oh-ih)/2`,
    // Audio
    '-c:a',  'aac',
    '-b:a',  '128k',
    '-ar',   '44100',
    '-ac',   '2',
    // Output
    '-f',         'flv',
    '-flvflags',  'no_duration_filesize',
    url
  ];

  log(streamId, `▶ Starting: ${video.name} → ${url.replace(/\/[^/]+$/, '/***')}`);

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  obj.proc = proc;

  let buf = '';
  const onData = chunk => {
    buf += chunk.toString();
    const lines = buf.split(/[\r\n]/);
    buf = lines.pop();
    lines.forEach(l => { if (l.trim()) log(streamId, l); });
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('exit', (code, sig) => {
    log(streamId, `⏹ FFmpeg exited — code=${code} signal=${sig}`);
    if (obj.stopped) return;

    if (code === 0) {
      // Video finished normally → next
      obj.currentVideoIdx++;
      if (obj.currentVideoIdx >= obj.videos.length) {
        if (obj.slot.loop) obj.currentVideoIdx = 0;
        else return killStream(streamId);
      }
    } else {
      obj.restarts++;
      log(streamId, `⚠ Error. Restart #${obj.restarts} in 5s...`);
    }
    setTimeout(() => launchFFmpeg(streamId, obj), code === 0 ? 1000 : 5000);
  });

  proc.on('error', err => {
    log(streamId, `✖ Spawn error: ${err.message}`);
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
  log(streamId, '🛑 Stream stopped.');
}

function buildRtmpUrl(platform, key) {
  if (platform === 'youtube')  return `rtmp://a.rtmp.youtube.com/live2/${key}`;
  if (platform === 'facebook') return `rtmps://live-api-s.facebook.com:443/rtmp/${key}`;
  if (platform === 'twitch')   return `rtmp://live.twitch.tv/live/${key}`;
  return key; // custom: key IS the full URL
}

function qualityPreset(q) {
  return {
    '1080p': { res: '1920:1080', vbr: '4000k', buf: '8000k' },
    '720p':  { res: '1280:720',  vbr: '2500k', buf: '5000k' },
    '480p':  { res: '854:480',   vbr: '1000k', buf: '2000k' },
    '360p':  { res: '640:360',   vbr:  '600k', buf: '1200k' },
  }[q] || { res: '1280:720', vbr: '2500k', buf: '5000k' };
}

function log(streamId, msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  const arr = streamLogs.get(streamId);
  if (arr) { arr.push(line); if (arr.length > 500) arr.shift(); }
  // Also append to file log
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
//  SCHEDULER
// ══════════════════════════════════════════════════════════════════════════════
function armSchedule(sched) {
  const ms = new Date(sched.startAt).getTime() - Date.now();
  if (ms < -60_000) return; // More than 1 min in the past
  setTimeout(() => {
    const slot = state.slots.find(s => s.id === sched.slotId);
    if (!slot) return;
    const videos = sched.playlist
      ? sched.playlist.map(id => state.videos.find(v => v.id === id)).filter(Boolean)
      : slot.playlist.map(id => state.videos.find(v => v.id === id)).filter(v => v && fs.existsSync(v.serverPath));
    if (!videos.length) return;
    const streamId = crypto.randomUUID();
    const obj = {
      slot, videos, rtmpUrl: buildRtmpUrl(slot.platform, slot.key),
      startTime: Date.now(), currentVideoIdx: 0, proc: null, stopped: false, restarts: 0
    };
    activeStreams.set(streamId, obj);
    streamLogs.set(streamId, []);
    slot.status = 'live';
    sched.status = 'running';
    sched.streamId = streamId;
    saveState();
    launchFFmpeg(streamId, obj);
    if (sched.stopAt) {
      const stopMs = new Date(sched.stopAt).getTime() - Date.now();
      if (stopMs > 0) setTimeout(() => killStream(streamId), stopMs);
    }
  }, Math.max(0, ms));
}

function restoreSchedules() {
  (state.schedules || []).filter(s => s.status === 'scheduled').forEach(armSchedule);
}

// ══════════════════════════════════════════════════════════════════════════════
//  PERSISTENCE
// ══════════════════════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function getDiskFree() {
  try {
    const out = execSync(`df -BM ${PERSIST_DIR} 2>/dev/null | tail -1`).toString();
    const parts = out.trim().split(/\s+/);
    return { total: parts[1], used: parts[2], free: parts[3] };
  } catch { return null; }
}

// Heartbeat: clean up dead ffmpeg processes
setInterval(() => {
  for (const [id, s] of activeStreams) {
    if (!s.stopped && s.proc?.exitCode != null) {
      log(id, '[Heartbeat] Dead process found, cleaning up');
      killStream(id);
    }
  }
}, 20_000);

// ══════════════════════════════════════════════════════════════════════════════
//  START SERVER
// ══════════════════════════════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════╗
║  StreamLoop v3.0 — Ready                  ║
║  http://0.0.0.0:${String(PORT).padEnd(27)}║
║  Platform: ${IS_RENDER ? 'Render.com                 ' : 'Local                      '}║
║  Videos dir: ${UPLOAD_DIR.slice(0,30).padEnd(28)}║
╚════════════════════════════════════════════╝
  `);
  restoreSchedules();
});

process.on('SIGTERM', () => { [...activeStreams.keys()].forEach(killStream); process.exit(0); });
process.on('SIGINT',  () => { [...activeStreams.keys()].forEach(killStream); process.exit(0); });
