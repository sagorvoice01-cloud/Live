'use strict';

const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const { spawn, execSync } = require('child_process');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3001;

const DATA_DIR   = path.join(__dirname, 'data_local');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOG_FILE   = path.join(DATA_DIR, 'stream.log');
const PUBLIC_DIR = path.join(__dirname, 'public');

[UPLOAD_DIR, PUBLIC_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

let state = loadState();
const activeStreams  = new Map();
const streamLogs     = new Map();
const dlStatus       = new Map(); // videoId → {status,pct}

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/', express.static(PUBLIC_DIR));

// ── Multer ────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_,__,cb) => cb(null, UPLOAD_DIR),
  filename:    (_,file,cb) => cb(null, `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_')}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 ** 3 },
  fileFilter: (_,f,cb) => /\.(mp4|mov|avi|mkv|webm|flv|wmv|m4v|ts)$/i.test(f.originalname) ? cb(null,true) : cb(new Error('Video only'))
});

// ── Health ────────────────────────────────────────────────────
app.get('/api/health', (_,res) => res.json({ ok:true, ts:Date.now(), uptime:Math.floor(process.uptime()) }));
app.get('/api/ffmpeg/check', (_,res) => {
  try { res.json({ ok:true, version: execSync('ffmpeg -version 2>&1').toString().split('\n')[0] }); }
  catch { res.json({ ok:false, error:'FFmpeg not found' }); }
});
app.get('/api/status', (_,res) => {
  const streams = [...activeStreams.entries()].map(([id,s]) => ({
    id, slotId:s.slot.id, slotName:s.slot.name, platform:s.slot.platform,
    startTime:s.startTime, uptime:Math.floor((Date.now()-s.startTime)/1000),
    currentVideo:s.videos[s.idx]?.name||'—', idx:s.idx, total:s.videos.length, restarts:s.restarts
  }));
  res.json({ ok:true, version:'4.0.0', uptime:Math.floor(process.uptime()),
    streams, totalVideos:state.videos.length, totalSlots:state.slots.length });
});

// ── Videos ────────────────────────────────────────────────────
app.get('/api/videos', (_,res) => {
  // Keep URL-source videos even if file missing (can re-download)
  state.videos = state.videos.filter(v => v.sourceUrl || fs.existsSync(v.serverPath));
  saveState();
  const vids = state.videos.map(v => ({
    ...v,
    fileExists: fs.existsSync(v.serverPath),
    dlStatus: dlStatus.get(v.id) || null
  }));
  res.json({ ok:true, videos:vids });
});

app.post('/api/videos/upload', upload.array('videos',20), (req,res) => {
  if (!req.files?.length) return res.status(400).json({ ok:false, error:'No files' });
  const added = req.files.map(f => {
    const v = { id:crypto.randomUUID(), name:f.originalname, filename:f.filename,
      size:f.size, path:`/uploads/${f.filename}`,
      serverPath:path.join(UPLOAD_DIR,f.filename), addedAt:Date.now() };
    state.videos.push(v); return v;
  });
  saveState();
  res.json({ ok:true, added, total:state.videos.length });
});

app.delete('/api/videos/:id', (req,res) => {
  const i = state.videos.findIndex(v=>v.id===req.params.id);
  if (i===-1) return res.status(404).json({ ok:false, error:'Not found' });
  const [v] = state.videos.splice(i,1);
  try { if (!v.sourceUrl) fs.unlinkSync(v.serverPath); } catch {}
  dlStatus.delete(v.id);
  saveState();
  res.json({ ok:true });
});

// Add video by URL (Google Drive or direct MP4)
app.post('/api/videos/add-url', (req,res) => {
  const { url, name } = req.body;
  if (!url) return res.status(400).json({ ok:false, error:'url required' });
  const vname    = name || 'video.mp4';
  const filename = `${Date.now()}_${vname.replace(/[^a-z0-9._-]/gi,'_')}`;
  const dest     = path.join(UPLOAD_DIR, filename);
  const directUrl = toDirectUrl(url);
  const v = { id:crypto.randomUUID(), name:vname, filename, size:0,
    path:`/uploads/${filename}`, serverPath:dest, addedAt:Date.now(), sourceUrl:directUrl };
  state.videos.push(v); saveState();
  dlStatus.set(v.id, { status:'downloading', pct:0 });
  res.json({ ok:true, video:v });
  doDownload(v.id, directUrl, dest);
});

// Update source URL for a video
app.put('/api/videos/:id/url', (req,res) => {
  const v = state.videos.find(x=>x.id===req.params.id);
  if (!v) return res.status(404).json({ ok:false, error:'Not found' });
  const newUrl = toDirectUrl(req.body.url||'');
  if (!newUrl) return res.status(400).json({ ok:false, error:'url required' });
  v.sourceUrl = newUrl;
  try { if (fs.existsSync(v.serverPath)) fs.unlinkSync(v.serverPath); } catch {}
  saveState();
  dlStatus.set(v.id, { status:'downloading', pct:0 });
  doDownload(v.id, newUrl, v.serverPath);
  res.json({ ok:true, message:'Re-downloading with new URL...' });
});

// Manually re-download
app.post('/api/videos/:id/redownload', (req,res) => {
  const v = state.videos.find(x=>x.id===req.params.id);
  if (!v || !v.sourceUrl) return res.status(400).json({ ok:false, error:'No source URL' });
  try { if (fs.existsSync(v.serverPath)) fs.unlinkSync(v.serverPath); } catch {}
  dlStatus.set(v.id, { status:'downloading', pct:0 });
  doDownload(v.id, v.sourceUrl, v.serverPath);
  res.json({ ok:true, message:'Re-downloading...' });
});

app.get('/api/videos/:id/dl-status', (req,res) =>
  res.json({ ok:true, status: dlStatus.get(req.params.id)||null }));

// ── Slots ─────────────────────────────────────────────────────
app.get('/api/slots', (_,res) => res.json({ ok:true, slots:state.slots }));

app.post('/api/slots', (req,res) => {
  const slot = { id:crypto.randomUUID(), name:req.body.name||'New Slot',
    key:req.body.key||'', platform:req.body.platform||'youtube',
    playlist:req.body.playlist||[], loop:req.body.loop!==false,
    quality:req.body.quality||'480p', status:'idle', createdAt:Date.now() };
  state.slots.push(slot); saveState();
  res.json({ ok:true, slot });
});

app.put('/api/slots/:id', (req,res) => {
  const s = state.slots.find(x=>x.id===req.params.id);
  if (!s) return res.status(404).json({ ok:false, error:'Not found' });
  Object.assign(s, req.body, { id:s.id }); saveState();
  res.json({ ok:true, slot:s });
});

app.delete('/api/slots/:id', (req,res) => {
  const i = state.slots.findIndex(x=>x.id===req.params.id);
  if (i===-1) return res.status(404).json({ ok:false, error:'Not found' });
  state.slots.splice(i,1); saveState();
  res.json({ ok:true });
});

// ── Stream ────────────────────────────────────────────────────
app.post('/api/stream/start', async (req,res) => {
  const { slotId } = req.body;
  const slot = state.slots.find(s=>s.id===slotId);
  if (!slot)        return res.status(404).json({ ok:false, error:'Slot not found' });
  if (!slot.key)    return res.status(400).json({ ok:false, error:'Stream key empty' });
  if (!slot.playlist?.length) return res.status(400).json({ ok:false, error:'Playlist empty' });

  for (const [,s] of activeStreams)
    if (s.slot.id===slotId) return res.status(409).json({ ok:false, error:'Already streaming' });

  // Auto re-download any missing URL videos
  const missing = slot.playlist
    .map(id=>state.videos.find(v=>v.id===id))
    .filter(v=>v?.sourceUrl && !fs.existsSync(v.serverPath));

  if (missing.length) {
    console.log(`[AutoDL] Re-downloading ${missing.length} missing video(s)...`);
    await Promise.all(missing.map(v => new Promise(resolve => {
      dlStatus.set(v.id, { status:'downloading', pct:0 });
      doDownload(v.id, v.sourceUrl, v.serverPath, resolve);
    })));
  }

  const videos = slot.playlist
    .map(id=>state.videos.find(v=>v.id===id))
    .filter(v=>v && fs.existsSync(v.serverPath));

  if (!videos.length) return res.status(400).json({ ok:false, error:'No valid video files found' });

  const streamId = crypto.randomUUID();
  const obj = { slot, videos, rtmpUrl:buildRtmp(slot.platform,slot.key),
    startTime:Date.now(), idx:0, proc:null, stopped:false, restarts:0 };
  activeStreams.set(streamId, obj);
  streamLogs.set(streamId, []);
  slot.status='live'; saveState();
  launchFFmpeg(streamId, obj);
  res.json({ ok:true, streamId, message:'Streaming started' });
});

app.post('/api/stream/stop', (req,res) => {
  const { streamId, slotId } = req.body;
  if (streamId) killStream(streamId);
  else if (slotId) { for (const [id,s] of activeStreams) if (s.slot.id===slotId) killStream(id); }
  else for (const id of [...activeStreams.keys()]) killStream(id);
  res.json({ ok:true });
});

app.get('/api/stream/status', (_,res) => {
  const streams = [...activeStreams.entries()].map(([id,s]) => ({
    id, slotId:s.slot.id, slotName:s.slot.name, startTime:s.startTime,
    uptime:Math.floor((Date.now()-s.startTime)/1000),
    currentVideo:s.videos[s.idx]?.name||'—', idx:s.idx, total:s.videos.length,
    platform:s.slot.platform, restarts:s.restarts
  }));
  res.json({ ok:true, active:streams.length, streams });
});

app.get('/api/stream/logs/:id', (req,res) =>
  res.json({ ok:true, logs:(streamLogs.get(req.params.id)||[]).slice(-200) }));

// ── Schedules ─────────────────────────────────────────────────
app.get('/api/schedules', (_,res) => res.json({ ok:true, schedules:state.schedules }));
app.post('/api/schedules', (req,res) => {
  const s = { id:crypto.randomUUID(), slotId:req.body.slotId, startAt:req.body.startAt,
    stopAt:req.body.stopAt||null, repeat:req.body.repeat||'none', status:'scheduled', createdAt:Date.now() };
  state.schedules.push(s); saveState(); armSchedule(s);
  res.json({ ok:true, schedule:s });
});
app.delete('/api/schedules/:id', (req,res) => {
  const i = state.schedules.findIndex(s=>s.id===req.params.id);
  if (i===-1) return res.status(404).json({ ok:false, error:'Not found' });
  state.schedules.splice(i,1); saveState();
  res.json({ ok:true });
});

// ── FFmpeg engine ─────────────────────────────────────────────
function launchFFmpeg(streamId, obj) {
  if (obj.stopped) return;
  const video = obj.videos[obj.idx];
  if (!video) {
    if (obj.slot.loop) { obj.idx=0; return launchFFmpeg(streamId,obj); }
    return killStream(streamId);
  }

  // File missing but has sourceUrl → re-download then retry
  if (!fs.existsSync(video.serverPath) && video.sourceUrl) {
    log(streamId, `⚠ File missing, re-downloading: ${video.name}`);
    dlStatus.set(video.id, { status:'downloading', pct:0 });
    doDownload(video.id, video.sourceUrl, video.serverPath, ok => {
      if (!obj.stopped) setTimeout(() => launchFFmpeg(streamId, obj), ok ? 500 : 10000);
    });
    return;
  }

  const q   = qualityPreset(obj.slot.quality||'480p');
  const url = obj.rtmpUrl;
  const args = [
    '-stream_loop', '-1',  // ← infinite loop — video কখনো শেষ হবে না
    '-re', '-i', video.serverPath,
    '-c:v','libx264','-preset','veryfast','-tune','zerolatency',
    '-maxrate',q.vbr,'-bufsize',q.buf,'-pix_fmt','yuv420p','-r','25','-g','50',
    '-vf',`scale=${q.res}:force_original_aspect_ratio=decrease,pad=${q.res}:(ow-iw)/2:(oh-ih)/2`,
    '-c:a','aac','-b:a','128k','-ar','44100','-ac','2',
    '-f','flv','-flvflags','no_duration_filesize', url
  ];

  log(streamId, `▶ ${video.name} → ${url.replace(/\/[^/]+$/,'/***')}`);
  const proc = spawn('ffmpeg', args, { stdio:['ignore','pipe','pipe'] });
  obj.proc = proc;
  let buf = '';
  const onData = c => {
    buf += c.toString();
    const lines = buf.split(/[\r\n]/); buf = lines.pop();
    lines.forEach(l => { if(l.trim()) log(streamId,l); });
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', (code,sig) => {
    log(streamId, `⏹ exit code=${code} sig=${sig}`);
    if (obj.stopped) return;
    // Always restart — stream never stops unless manually killed
    obj.restarts++;
    const delay = code===0 ? 800 : 5000;
    log(streamId, `🔄 Auto-restart #${obj.restarts} in ${delay/1000}s...`);
    // Next video in playlist on clean exit
    if (code===0) {
      obj.idx++;
      if (obj.idx >= obj.videos.length) obj.idx=0; // always loop back
    }
    setTimeout(() => launchFFmpeg(streamId,obj), delay);
  });
  proc.on('error', err => {
    log(streamId, `✖ ${err.message}`);
    if (!obj.stopped) setTimeout(() => launchFFmpeg(streamId,obj), 5000);
  });
}

function killStream(id) {
  const s = activeStreams.get(id); if (!s) return;
  s.stopped=true;
  try { s.proc?.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { s.proc?.kill('SIGKILL'); } catch {} }, 3000);
  activeStreams.delete(id);
  const slot = state.slots.find(sl=>sl.id===s.slot.id);
  if (slot) { slot.status='idle'; saveState(); }
  log(id,'🛑 Stopped.');
}

function buildRtmp(platform,key) {
  if (platform==='youtube')  return `rtmp://a.rtmp.youtube.com/live2/${key}`;
  if (platform==='facebook') return `rtmps://live-api-s.facebook.com:443/rtmp/${key}`;
  if (platform==='twitch')   return `rtmp://live.twitch.tv/live/${key}`;
  return key;
}

function qualityPreset(q) {
  return ({
    '1080p':{ res:'1920:1080', vbr:'4000k', buf:'8000k' },
    '720p': { res:'1280:720',  vbr:'2500k', buf:'5000k' },
    '480p': { res:'854:480',   vbr:'1000k', buf:'2000k' },
    '360p': { res:'640:360',   vbr:'600k',  buf:'1200k' },
  })[q] || { res:'854:480', vbr:'1000k', buf:'2000k' };
}

function log(streamId,msg) {
  const line=`[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  const arr=streamLogs.get(streamId);
  if (arr) { arr.push(line); if(arr.length>500) arr.shift(); }
  try { fs.appendFileSync(LOG_FILE,line+'\n'); } catch {}
}

// ── Download helper ───────────────────────────────────────────
function doDownload(videoId, url, dest, callback) {
  console.log(`[DL] ${url.slice(0,80)}`);
  const proc = spawn('wget', ['--no-check-certificate', '--content-disposition', '-O', dest, url],
    { stdio:['ignore','pipe','pipe'] });
  let stderr='';
  proc.stderr.on('data', d => { stderr+=d; });
  proc.on('exit', code => {
    const ok = code===0 && fs.existsSync(dest) && fs.statSync(dest).size > 10000;
    if (ok) {
      const v = state.videos.find(x=>x.id===videoId);
      if (v) { v.size=fs.statSync(dest).size; saveState(); }
      dlStatus.set(videoId, { status:'done', pct:100 });
      console.log(`[DL] Done: ${dest}`);
    } else {
      try { fs.unlinkSync(dest); } catch {}
      dlStatus.set(videoId, { status:'failed', pct:0, error:'Download failed' });
      console.error(`[DL] Failed code=${code}`);
    }
    if (callback) callback(ok);
  });
  proc.on('error', err => {
    dlStatus.set(videoId, { status:'failed', error:err.message });
    if (callback) callback(false);
  });
}

function toDirectUrl(url) {
  if (!url) return url;
  // Google Drive share link → direct download
  const m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return `https://drive.google.com/uc?export=download&confirm=t&id=${m[1]}`;
  // Already direct
  return url;
}

// ── Scheduler ─────────────────────────────────────────────────
function armSchedule(sched) {
  const ms = new Date(sched.startAt).getTime()-Date.now();
  if (ms < -60000) return;
  setTimeout(async () => {
    const slot = state.slots.find(s=>s.id===sched.slotId); if (!slot) return;
    const videos = slot.playlist.map(id=>state.videos.find(v=>v.id===id))
      .filter(v=>v&&fs.existsSync(v.serverPath));
    if (!videos.length) return;
    const streamId=crypto.randomUUID();
    const obj={ slot,videos,rtmpUrl:buildRtmp(slot.platform,slot.key),
      startTime:Date.now(),idx:0,proc:null,stopped:false,restarts:0 };
    activeStreams.set(streamId,obj); streamLogs.set(streamId,[]);
    slot.status='live'; sched.status='running'; sched.streamId=streamId; saveState();
    launchFFmpeg(streamId,obj);
    if (sched.stopAt) {
      const stop=new Date(sched.stopAt).getTime()-Date.now();
      if (stop>0) setTimeout(()=>killStream(streamId),stop);
    }
  }, Math.max(0,ms));
}

// ── Persistence ───────────────────────────────────────────────
function loadState() {
  try { if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); } catch {}
  return { videos:[], slots:[], schedules:[], settings:{} };
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE,JSON.stringify(state,null,2)); } catch(e) { console.error('saveState:',e.message); }
}

// ── Heartbeat: cleanup dead streams ──────────────────────────
setInterval(() => {
  for (const [id,s] of activeStreams)
    if (!s.stopped && s.proc?.exitCode!=null) killStream(id);
}, 20000);

// ── On startup: re-download missing URL videos + restart active streams ──────
setTimeout(async () => {
  const missing = state.videos.filter(v=>v.sourceUrl&&!fs.existsSync(v.serverPath));
  if (missing.length) {
    console.log(`[Startup] Re-downloading ${missing.length} missing video(s)...`);
    await Promise.all(missing.map(v => new Promise(resolve => {
      dlStatus.set(v.id, { status:'downloading', pct:0 });
      doDownload(v.id, v.sourceUrl, v.serverPath, resolve);
    })));
  }

  // Auto-restart any slots that were live before restart
  const liveSlots = state.slots.filter(s=>s.status==='live');
  if (liveSlots.length) {
    console.log(`[Startup] Auto-restarting ${liveSlots.length} live slot(s)...`);
    for (const slot of liveSlots) {
      const videos = (slot.playlist||[])
        .map(id=>state.videos.find(v=>v.id===id))
        .filter(v=>v&&fs.existsSync(v.serverPath));
      if (!videos.length) { slot.status='idle'; saveState(); continue; }
      const streamId = crypto.randomUUID();
      const obj = { slot, videos, rtmpUrl:buildRtmp(slot.platform,slot.key),
        startTime:Date.now(), idx:0, proc:null, stopped:false, restarts:0 };
      activeStreams.set(streamId, obj);
      streamLogs.set(streamId, []);
      launchFFmpeg(streamId, obj);
      console.log(`[Startup] Stream restarted for slot: ${slot.name}`);
    }
  }
}, 5000);

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════════╗
║  StreamLoop v4.0 — Ready               ║
║  http://0.0.0.0:${String(PORT).padEnd(25)}║
╚══════════════════════════════════════════╝\n`);
  state.schedules?.filter(s=>s.status==='scheduled').forEach(armSchedule);
});

process.on('SIGTERM', () => { [...activeStreams.keys()].forEach(killStream); process.exit(0); });
process.on('SIGINT',  () => { [...activeStreams.keys()].forEach(killStream); process.exit(0); });
