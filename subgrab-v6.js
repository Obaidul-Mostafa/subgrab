// ============================================================
// SubGrab v6 — Single-file YouTube Subtitle Downloader
// ZERO dependencies — Node.js 18+ required.
// Run:   node subgrab-v6.js
// Open:  http://localhost:3000
//
// v6 new: the downloaded file is named after the video's real
// title (like downsub does), e.g.
//   dar-e-nijaat-ep-33-21-november-2026-eng-sub-...-ary-d.srt
// Falls back to the video ID when the title has no usable
// latin characters (e.g. pure Bangla titles).
//
// v5 fixes kept: strips the baked-in fmt param and retries with
// a cascade (json3 -> srv3 -> srv1 -> vtt -> raw), retries the
// other InnerTube client (IOS) if a track fails. Lists ALL
// subtitle tracks (auto-generated + manual, every language).
// ============================================================
import http from 'node:http';

const PORT = process.env.PORT || 3000;

const CLIENTS = [
  {
    name: 'ANDROID',
    clientName: 'ANDROID',
    clientVersion: '20.10.38',
    headerName: '3',
    ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    key: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w'
  },
  {
    name: 'IOS',
    clientName: 'IOS',
    clientVersion: '20.10.4',
    headerName: '5',
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)',
    key: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc'
  }
];

/* ---------- helpers ---------- */

function extractVideoId(input) {
  const patterns = [
    /youtube\.com\/watch\?[^#]*?v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const p of patterns) {
    const m = String(input).trim().match(p);
    if (m) return m[1];
  }
  return null;
}

/* turn a video title into a clean file name, downsub-style */
function slugify(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')      // strip accents
    .replace(/[''\u2019"]/g, '')           // drop apostrophes/quotes
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')          // non-alphanumeric -> hyphen
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/g, '');
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)));
}

function trackLabel(t) {
  const nm = (t.name && (t.name.simpleText || (t.name.runs && t.name.runs.map((r) => r.text).join('')))) || '';
  const auto = t.kind === 'asr';
  return (nm || t.languageCode || 'unknown') + (auto ? ' (auto-generated)' : '');
}

async function innertubePlayer(id, client) {
  const clientCtx = client.name === 'ANDROID'
    ? { clientName: client.clientName, clientVersion: client.clientVersion, hl: 'en', gl: 'US', androidSdkVersion: 30, osName: 'Android', osVersion: '11' }
    : { clientName: client.clientName, clientVersion: client.clientVersion, hl: 'en', gl: 'US', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' };

  const body = {
    videoId: id,
    contentCheckOk: true,
    racyCheckOk: true,
    context: { client: clientCtx }
  };

  const res = await fetch('https://www.youtube.com/youtubei/v1/player?key=' + client.key + '&prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': client.ua,
      'X-YouTube-Client-Name': client.headerName,
      'X-YouTube-Client-Version': client.clientVersion
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('player API HTTP ' + res.status);
  return res.json();
}

/* list caption tracks (+ video title) from every client that answers */
async function getTracksFromAllClients(id) {
  const results = [];
  const errors = [];
  for (const client of CLIENTS) {
    let player;
    try {
      player = await innertubePlayer(id, client);
    } catch (e) {
      errors.push(client.name + ': ' + e.message);
      continue;
    }
    const status = player.playabilityStatus && player.playabilityStatus.status;
    if (status && status !== 'OK') {
      const reason = (player.playabilityStatus && player.playabilityStatus.reason) || status;
      if (status === 'ERROR' || /age|member|private|removed|unavailable/i.test(reason)) {
        throw new Error('Video not available: ' + reason);
      }
      errors.push(client.name + ': ' + reason);
      continue;
    }
    const tracks = player.captions && player.captions.playerCaptionsTracklistRenderer
      && player.captions.playerCaptionsTracklistRenderer.captionTracks;
    if (tracks && tracks.length) {
      results.push({
        client,
        tracks,
        title: (player.videoDetails && player.videoDetails.title) || ''
      });
    } else {
      errors.push(client.name + ': no caption track listed');
    }
  }
  if (!results.length) throw new Error('No captions available. Details: ' + errors.join(' | '));
  return results;
}

/* ---------- caption body parsers (format detected from the body) ---------- */

function vttTimeToMs(s) {
  const parts = s.trim().replace(',', '.').split(':').map(Number);
  if (parts.length === 3) return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
  if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
  return 0;
}

/* generic XML tag attribute reader (order-independent) */
function tagAttr(tag, name) {
  const m = tag.match(new RegExp('\\b' + name + '="([\\d.]+)"'));
  return m ? parseFloat(m[1]) : null;
}

function parseCaptionBody(text, lang) {
  const trimmed = text.trim();
  const out = [];
  if (!trimmed) return out;

  if (trimmed.startsWith('{')) {
    let data;
    try { data = JSON.parse(trimmed); } catch { return out; }
    for (const ev of (data.events || [])) {
      if (!ev.segs) continue;
      const raw = decodeEntities(ev.segs.map((s) => s.utf8 || '').join(''))
        .replace(/<[^>]+>/g, '').replace(/\s*\n\s*/g, ' ').trim();
      if (!raw) continue;
      out.push({ text: raw, offset: ev.tStartMs || 0, duration: ev.dDurationMs || 2000, lang });
    }
    return out;
  }

  if (trimmed.includes('<transcript') && trimmed.includes('<p')) {
    const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = re.exec(trimmed)) !== null) {
      const t = tagAttr(m[1], 't');
      if (t === null) continue;
      const d = tagAttr(m[1], 'd');
      const body = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      if (!body) continue;
      out.push({ text: body, offset: Math.round(t), duration: d !== null ? Math.round(d) : 2000, lang });
    }
    return out;
  }

  if (trimmed.includes('<text')) {
    const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    let m;
    while ((m = re.exec(trimmed)) !== null) {
      const start = tagAttr(m[1], 'start');
      if (start === null) continue;
      const dur = tagAttr(m[1], 'dur');
      const body = decodeEntities(m[2].replace(/<br[^>]*>/gi, ' ').replace(/<[^>]+>/g, ''))
        .replace(/\s+/g, ' ').trim();
      if (!body) continue;
      out.push({
        text: body,
        offset: Math.round(start * 1000),
        duration: dur !== null ? Math.round(dur * 1000) : 2000,
        lang
      });
    }
    return out;
  }

  if (trimmed.startsWith('WEBVTT')) {
    const blocks = trimmed.split(/\n\s*\n/);
    for (const b of blocks) {
      const lines = b.split('\n');
      const tl = lines.find((l) => l.includes('-->'));
      if (!tl) continue;
      const parts = tl.split('-->');
      const start = vttTimeToMs(parts[0]);
      const end = vttTimeToMs(parts[1] || parts[0]);
      const body = lines.filter((l) => !l.includes('-->') && !/^\d+$/.test(l.trim())).join(' ').trim();
      if (!body) continue;
      out.push({ text: body, offset: start, duration: Math.max(200, end - start), lang });
    }
    return out;
  }

  return out;
}

/* ---------- download one selected track (format cascade + client retry) ---------- */

function stripFmt(url) {
  return url.replace(/([?&])fmt=[^&]*/g, function (m, lead) { return lead === '?' ? '?' : ''; });
}

async function tryFetchCaption(url, ua) {
  const res = await fetch(url, {
    headers: { 'User-Agent': ua, 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://www.youtube.com/' }
  });
  if (!res.ok) throw new Error('caption download HTTP ' + res.status);
  const text = await res.text();
  if (!text.trim()) throw new Error('empty body');
  return text;
}

async function downloadTrack(videoId, langWanted, index) {
  const clientSets = await getTracksFromAllClients(videoId);
  const errors = [];

  for (const { client, tracks } of clientSets) {
    let track = null;
    if (index !== null && index !== undefined && index !== '') {
      track = tracks[Number(index)];
    } else if (langWanted) {
      track = tracks.find((t) => t.languageCode === langWanted)
        || tracks.find((t) => (t.languageCode || '').startsWith(langWanted))
        || tracks[0];
    } else {
      track = tracks.find((t) => (t.languageCode || '').startsWith('en')) || tracks[0];
    }
    if (!track) { errors.push(client.name + ': track not found'); continue; }

    const clean = stripFmt(track.baseUrl);
    const sep = clean.includes('?') ? '&' : '?';
    const attempts = [
      clean + sep + 'fmt=json3',
      clean + sep + 'fmt=srv3',
      clean + sep + 'fmt=srv1',
      clean + sep + 'fmt=vtt',
      clean
    ];

    for (const url of attempts) {
      try {
        const text = await tryFetchCaption(url, client.ua);
        const segments = parseCaptionBody(text, track.languageCode || '');
        if (segments.length) {
          return {
            segments,
            language: track.languageCode || '',
            kind: track.kind === 'asr' ? 'auto' : 'manual',
            title: (clientSets[0] && clientSets[0].title) || '',
            client: client.name
          };
        }
        errors.push(client.name + ' (' + (track.languageCode || '?') + '): parsed 0 lines');
      } catch (e) {
        errors.push(client.name + ' (' + (track.languageCode || '?') + '): ' + e.message);
      }
    }
  }

  throw new Error('Could not download captions. Tried: ' + errors.slice(0, 6).join(' | '));
}

/* ---------- format converters ---------- */

function msToTimestamp(ms, sep) {
  const sepCh = sep || ',';
  const pad = (n, l) => String(n).padStart(l || 2, '0');
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const f = ms % 1000;
  return pad(h) + ':' + pad(m) + ':' + pad(s) + sepCh + pad(f, 3);
}

function toSRT(segments) {
  return segments.map((seg, i) => {
    const start = msToTimestamp(seg.offset);
    const end = msToTimestamp(seg.offset + seg.duration);
    return (i + 1) + '\n' + start + ' --> ' + end + '\n' + seg.text + '\n';
  }).join('\n');
}

function toVTT(segments) {
  const body = segments.map((seg) => {
    const start = msToTimestamp(seg.offset, '.');
    const end = msToTimestamp(seg.offset + seg.duration, '.');
    return start + ' --> ' + end + '\n' + seg.text + '\n';
  }).join('\n');
  return 'WEBVTT\n\n' + body;
}

function toTXT(segments) {
  return segments.map((s) => s.text).join(' ');
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/* per-IP rate limit: 10 requests per minute */
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (list.length >= 10) return true;
  list.push(now);
  hits.set(ip, list);
  return false;
}

/* ---------- server ---------- */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getPage());
    return;
  }

  /* list every available subtitle track */
  if (u.pathname === '/api/tracks') {
    if (limited(req.socket.remoteAddress || 'x')) {
      return send(res, 429, { error: 'Too many requests. Please wait a minute.' });
    }
    const url = u.searchParams.get('url') || '';
    const id = extractVideoId(url);
    if (!id) return send(res, 400, { error: 'Please paste a valid YouTube video link (watch, youtu.be, shorts, or embed).' });

    try {
      const clientSets = await getTracksFromAllClients(id);
      const first = clientSets[0];
      const seen = new Set();
      const tracks = [];
      for (const t of first.tracks) {
        if (seen.has(t.languageCode + '|' + (t.kind || ''))) continue;
        seen.add(t.languageCode + '|' + (t.kind || ''));
        tracks.push({
          index: tracks.length,
          label: trackLabel(t),
          languageCode: t.languageCode || '',
          kind: t.kind === 'asr' ? 'auto' : 'manual',
          translatable: !!t.isTranslatable
        });
      }
      send(res, 200, { videoId: id, title: first.title, tracks });
    } catch (err) {
      send(res, 500, { error: err.message || 'Could not list subtitles for this link.' });
    }
    return;
  }

  if (u.pathname === '/api/subtitles') {
    if (limited(req.socket.remoteAddress || 'x')) {
      return send(res, 429, { error: 'Too many requests. Please wait a minute.' });
    }
    const url = u.searchParams.get('url') || '';
    const format = u.searchParams.get('format') || 'srt';
    const lang = (u.searchParams.get('lang') || '').trim();
    const trackIndex = u.searchParams.get('track');

    const id = extractVideoId(url);
    if (!id) return send(res, 400, { error: 'Please paste a valid YouTube video link (watch, youtu.be, shorts, or embed).' });
    if (!['srt', 'vtt', 'txt'].includes(format)) return send(res, 400, { error: 'Format must be srt, vtt, or txt.' });

    try {
      const out = await downloadTrack(id, lang, trackIndex);
      const content = format === 'vtt' ? toVTT(out.segments) : format === 'txt' ? toTXT(out.segments) : toSRT(out.segments);

      /* downsub-style file name from the real video title */
      const slug = slugify(out.title);
      const filename = (slug ? slug : id) + '.' + format;

      send(res, 200, {
        videoId: id,
        format,
        language: out.language,
        kind: out.kind,
        count: out.segments.length,
        title: out.title,
        filename,
        content
      });
    } catch (err) {
      send(res, 500, { error: err.message || 'Could not fetch YouTube captions for this link.' });
    }
    return;
  }

  send(res, 404, { error: 'Not found.' });
});

server.listen(PORT, () => console.log('✅ SubGrab v6 running → http://localhost:' + PORT));

/* ---------- the built-in webpage (served at /) ---------- */

function getPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>SubGrab — Free Online Subtitle Downloader</title>
<meta name="description" content="Download subtitles from YouTube videos as SRT, VTT, or TXT. Free, no sign-up, no watermark." />
<style>
  :root { --bg:#0b0f1a; --card:#121829; --accent:#6c5ce7; --accent2:#00cec9; --text:#e9edf5; --muted:#9aa3b5; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--text); line-height:1.6; }
  header { display:flex; justify-content:space-between; align-items:center; padding:18px 6vw; border-bottom:1px solid rgba(255,255,255,.06); }
  .logo { font-weight:800; font-size:1.25rem; }
  .logo span { color:var(--accent2); }
  nav a { color:var(--muted); text-decoration:none; margin-left:22px; font-size:.95rem; }
  nav a:hover { color:var(--text); }
  .hero { text-align:center; padding:60px 6vw 30px; }
  .hero h1 { font-size:clamp(1.8rem,4vw,3rem); font-weight:800; background:linear-gradient(90deg,var(--accent),var(--accent2)); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
  .hero p { color:var(--muted); max-width:560px; margin:14px auto 0; }
  .tool { background:var(--card); max-width:720px; margin:36px auto; padding:28px; border-radius:14px; box-shadow:0 12px 40px rgba(0,0,0,.4); }
  .tool label { display:block; font-size:.85rem; color:var(--muted); margin-bottom:8px; }
  .tool input[type="url"] { padding:14px 16px; border-radius:10px; border:1px solid rgba(255,255,255,.12); background:#0d1322; color:var(--text); font-size:1rem; width:100%; }
  input:focus { outline:2px solid var(--accent); }
  .fetchrow { display:flex; gap:10px; }
  .fetchrow input { flex:1; }
  .fetchbtn { padding:14px 22px; border:none; border-radius:10px; background:linear-gradient(90deg,var(--accent),var(--accent2)); color:#fff; font-weight:700; cursor:pointer; white-space:nowrap; }
  .fetchbtn:hover { filter:brightness(1.1); }
  .fetchbtn:disabled { opacity:.6; cursor:wait; }
  .tracklist { display:none; margin-top:20px; }
  .tracklist h3 { font-size:1rem; margin-bottom:12px; }
  .tracks { display:flex; flex-direction:column; gap:8px; max-height:340px; overflow:auto; padding-right:4px; }
  .track { display:flex; justify-content:space-between; align-items:center; padding:12px 16px; border:1px solid rgba(255,255,255,.1); border-radius:10px; background:#0d1322; cursor:pointer; }
  .track:hover { border-color:var(--accent2); }
  .track .name { font-weight:600; font-size:.95rem; }
  .track .meta { color:var(--muted); font-size:.8rem; }
  .badge { font-size:.7rem; padding:3px 8px; border-radius:999px; background:rgba(108,92,231,.2); color:#a29bfe; margin-left:8px; }
  .badge.auto { background:rgba(0,206,201,.15); color:var(--accent2); }
  .fmtrow { display:flex; gap:10px; margin-top:18px; flex-wrap:wrap; align-items:center; }
  .fmtrow .flabel { color:var(--muted); font-size:.85rem; }
  .formats { display:flex; gap:10px; flex-wrap:wrap; }
  .formats label { cursor:pointer; padding:9px 16px; border-radius:10px; border:1px solid rgba(255,255,255,.12); color:var(--muted); font-size:.9rem; }
  .formats input { display:none; }
  .formats label:has(input:checked) { border-color:var(--accent2); background:rgba(0,206,201,.08); }
  .formats label:has(input:checked) span { color:var(--accent2); font-weight:700; }
  .btn { margin-top:18px; width:100%; padding:15px; border:none; border-radius:10px; background:linear-gradient(90deg,var(--accent),var(--accent2)); color:#fff; font-size:1.05rem; font-weight:700; cursor:pointer; }
  .btn:hover { filter:brightness(1.1); }
  .btn:disabled { opacity:.6; cursor:wait; }
  .status { margin-top:14px; font-size:.9rem; color:var(--muted); min-height:1.4em; }
  .status.error { color:#ff7675; }
  .status.ok { color:#55efc4; }
  .result { display:none; margin-top:18px; }
  .result-actions { display:flex; gap:10px; flex-wrap:wrap; }
  .result-actions button, .result-actions a { flex:1 1 160px; text-align:center; text-decoration:none; padding:12px; border-radius:10px; border:1px solid rgba(255,255,255,.12); background:#0d1322; color:var(--accent2); font-weight:700; cursor:pointer; font-size:.95rem; }
  .preview { margin-top:16px; max-height:240px; overflow:auto; background:#0d1322; border:1px solid rgba(255,255,255,.1); border-radius:10px; padding:14px; font-family:monospace; font-size:.8rem; white-space:pre-wrap; }
  .section { max-width:1000px; margin:0 auto; padding:60px 6vw; }
  .section h2 { text-align:center; font-size:1.6rem; margin-bottom:34px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:20px; }
  .card { background:var(--card); padding:24px; border-radius:14px; border:1px solid rgba(255,255,255,.06); }
  .card h3 { font-size:1.05rem; margin-bottom:8px; }
  .card p { color:var(--muted); font-size:.92rem; }
  details { max-width:760px; margin:0 auto 12px; background:var(--card); border-radius:10px; padding:16px 20px; border:1px solid rgba(255,255,255,.06); }
  summary { cursor:pointer; font-weight:600; }
  details p { color:var(--muted); margin-top:10px; font-size:.95rem; }
  footer { text-align:center; padding:40px 6vw; color:var(--muted); font-size:.85rem; border-top:1px solid rgba(255,255,255,.06); }
</style>
</head>
<body>
<header>
  <div class="logo">Sub<span>Grab</span></div>
  <nav>
    <a href="#tool">Downloader</a>
    <a href="#how">How it works</a>
    <a href="#faq">FAQ</a>
  </nav>
</header>
<section class="hero">
  <h1>Download YouTube Subtitles Instantly</h1>
  <p>Paste a video link, see every available subtitle, and export real captions as SRT, VTT, or TXT. Free, no sign-up, no watermark.</p>
</section>
<div class="tool" id="tool">
  <label for="videoUrl">Paste your YouTube video link</label>
  <div class="fetchrow">
    <input id="videoUrl" type="url" placeholder="https://www.youtube.com/watch?v=..." required />
    <button class="fetchbtn" id="fetchBtn">Find subtitles</button>
  </div>
  <div class="status" id="status"></div>
  <div class="tracklist" id="tracklist">
    <h3 id="trackTitle">Available subtitles</h3>
    <div class="tracks" id="tracks"></div>
    <div class="fmtrow">
      <span class="flabel">Format:</span>
      <div class="formats">
        <label><input type="radio" name="fmt" value="srt" checked /><span>SRT</span></label>
        <label><input type="radio" name="fmt" value="vtt" /><span>VTT</span></label>
        <label><input type="radio" name="fmt" value="txt" /><span>TXT</span></label>
      </div>
    </div>
    <button class="btn" id="downloadBtn">Download Selected Subtitle</button>
  </div>
  <div class="result" id="result">
    <div class="result-actions">
      <a id="downloadLink" download>⬇ Save file</a>
      <button id="copyBtn">📋 Copy text</button>
    </div>
    <div class="preview" id="preview"></div>
  </div>
</div>
<section class="section" id="how">
  <h2>How it works</h2>
  <div class="grid">
    <div class="card"><h3>1. Paste the link</h3><p>Any YouTube URL works: watch, youtu.be, shorts, or embed links.</p></div>
    <div class="card"><h3>2. Pick a subtitle</h3><p>Every available track is listed — all languages, plus auto-generated captions, each clearly labelled.</p></div>
    <div class="card"><h3>3. Download</h3><p>We fetch the video's public caption track and convert it instantly — real timings included.</p></div>
  </div>
</section>
<section class="section" id="faq">
  <h2>FAQ</h2>
  <details><summary>Is it really free?</summary><p>Yes — paste a link, pick a format, download. No account, no watermark, no hidden paywall.</p></details>
  <details><summary>Does it work on every video?</summary><p>Only when the video has a fetchable caption track. Private, deleted, live streams, or caption-free videos won't return a list.</p></details>
  <details><summary>Auto-generated vs manual?</summary><p>Auto-generated captions are made by YouTube's speech recognition (labelled "auto-generated"). Manual ones are uploaded by the creator and are usually more accurate.</p></details>
  <details><summary>Do I need to install anything?</summary><p>No — it runs entirely in your browser. The site owner just hosts the small server once.</p></details>
</section>
<footer>© 2026 SubGrab — Subtitle Downloader. Keep it fair — only download subtitles from videos you own or have rights to use.</footer>
<script>
  const urlInput=document.getElementById('videoUrl'), fetchBtn=document.getElementById('fetchBtn'),
        status=document.getElementById('status'), tracklist=document.getElementById('tracklist'),
        tracksBox=document.getElementById('tracks'), trackTitle=document.getElementById('trackTitle'),
        button=document.getElementById('downloadBtn'), resultBox=document.getElementById('result'),
        dlLink=document.getElementById('downloadLink'), copyBtn=document.getElementById('copyBtn'),
        preview=document.getElementById('preview');
  let lastContent='', selectedTrack=null, videoUrl='';
  function setStatus(msg,cls){status.textContent=msg;status.className='status '+(cls||'');}
  async function fetchTracks(){
    const url=urlInput.value.trim();
    resultBox.style.display='none';
    if(!/^https?:\\/\\//i.test(url)&&!/^[a-zA-Z0-9_-]{11}$/.test(url)){
      setStatus('Please enter a valid YouTube link (or an 11-character video ID).','error');return;
    }
    videoUrl=url; selectedTrack=null;
    fetchBtn.disabled=true;tracklist.style.display='none';
    setStatus('Finding available subtitles…');
    try{
      const res=await fetch('/api/tracks?url='+encodeURIComponent(url));
      let data;
      try { data=await res.json(); }
      catch(e){ setStatus('Server returned an unreadable response. Please wait a minute and try again.','error'); return; }
      if(!res.ok){ setStatus(data.error||'Something went wrong. Please try again.','error'); return; }
      if(!data.tracks||!data.tracks.length){ setStatus('No subtitles found for this video.','error'); return; }
      trackTitle.textContent='Available subtitles ('+data.tracks.length+')'+(data.title?' — '+data.title:'');
      tracksBox.innerHTML='';
      data.tracks.forEach(function(t){
        const div=document.createElement('div');
        div.className='track';
        div.innerHTML='<div><span class="name"></span>'+(t.kind==='auto'?'<span class="badge auto">auto-generated</span>':'<span class="badge">manual</span>')+'</div><div class="meta"></div>';
        div.querySelector('.name').textContent=t.label;
        div.querySelector('.meta').textContent=t.languageCode+(t.kind==='auto'?' · YouTube auto-captions':' · creator upload');
        div.addEventListener('click',function(){
          tracksBox.querySelectorAll('.track').forEach(function(el){el.style.borderColor='';});
          div.style.borderColor='#00cec9';
          selectedTrack=t.index;
          setStatus('Selected: '+t.label+' — now pick a format and click Download.','ok');
        });
        tracksBox.appendChild(div);
      });
      tracklist.style.display='block';
      setStatus(data.tracks.length+' subtitle tracks found. Pick one to continue.','ok');
    }catch(err){
      setStatus('Network error: '+(err.message||'')+' — is the server still running?','error');
    }finally{fetchBtn.disabled=false;}
  }
  async function download(){
    if(selectedTrack===null){ setStatus('Please select a subtitle track first.','error'); return; }
    const fmt=document.querySelector('input[name="fmt"]:checked').value;
    button.disabled=true;setStatus('Downloading subtitle…');
    try{
      const res=await fetch('/api/subtitles?url='+encodeURIComponent(videoUrl)+'&format='+fmt+'&track='+selectedTrack);
      let data;
      try { data=await res.json(); }
      catch(e){ setStatus('Server returned an unreadable response. Please wait a minute and try again.','error'); return; }
      if(!res.ok){ setStatus(data.error||'Something went wrong. Please try again.','error'); return; }
      lastContent=data.content;
      const blob=new Blob([data.content],{type:'text/plain;charset=utf-8'});
      dlLink.href=URL.createObjectURL(blob);
      dlLink.download=data.filename;
      const lines=data.content.split('\\n');
      preview.textContent=lines.slice(0,40).join('\\n')+(lines.length>40?'\\n…':'');
      resultBox.style.display='block';
      setStatus(data.count+' lines downloaded as "'+data.filename+'" ('+(data.language||'?')+', '+(data.kind||'')+').','ok');
    }catch(err){
      setStatus('Network error: '+(err.message||'')+' — is the server still running?','error');
    }finally{button.disabled=false;}
  }
  copyBtn.addEventListener('click',async()=>{
    await navigator.clipboard.writeText(lastContent);
    copyBtn.textContent='Copied!';
    setTimeout(()=>copyBtn.textContent='📋 Copy text',1500);
  });
  fetchBtn.addEventListener('click',fetchTracks);
  button.addEventListener('click',download);
  urlInput.addEventListener('keydown',e=>{if(e.key==='Enter')fetchTracks();});
</script>
</body>
</html>`;
}
