// modules/sarcasm/server/index.js
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const app = express();
const upload = multer();
app.use(cors());

// health
app.get('/sarcasm/health', (_req, res) => res.json({ ok: true }));

// STT provider (Deepgram)
const { stt } = require('./providers/stt-deepgram');

// ---------------- Heuristic-only scorer ----------------
function heuristicScore(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t) return 0;

  // Strong cues
  const strong = [
    /(^|\b)yeah right(\b|[!.?,])/,
    /\bas if\b/,
    /\b(?:oh )?(?:great|wonderful)\b/,
    /great\.\s*just great/,
    /love that for me/,
    /what a treat/,
    /amazing\.\s*totally/,
    /couldn'?t be better/,
    /just what i needed/,
    /\blove (?:when|that)\b.*\b(?:not|never|none)\b/
  ];

  // Weak cues
  const weak = [
    /\bso+ great\b/,
    /\bni+ce\b/,
    /\bper+fect\b/,
    /\bawesome\b.*\b(?:not|never)\b/,
    /\byeah\b.*\bno\b/,
    /\bno\b.*\byeah\b/,
    /\bri+ght\b/,
    /\bsure\b.*\bwhatever\b/,
    /\blove\b.*\b(?:traffic|meetings|bugs|deadlines)\b/
  ];

  let s = 0;

  for (const r of strong) if (r.test(t)) s += 0.6;
  for (const r of weak)   if (r.test(t)) s += 0.2;

  // punctuation/emphasis
  if (/[!?]{2,}/.test(t)) s += 0.15;
  if (/\bsoooo+\b|\bveee+ry\b|\bgreee+at\b/.test(t)) s += 0.1;
  if (/"[^"]+"\s*(?:was|is)\s*(?:great|awesome|perfect)/.test(t)) s += 0.15;

  // light length bonus once there’s actual context (prevents 3-word spikes)
  const wordCount = t.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 12) s += 0.05;

  return Math.max(0, Math.min(1, s));
}

// ---------------- Rolling buffer (per-speaker) ----------------
const transcriptBuf = new Map();   // pid -> [{ t, time }]
const BUF_MS = 12000;              // keep last ~12s
const MIN_WORDS = 6;
const MIN_CHARS = 40;
const SCORE_COOLDOWN_MS = 1500;    // throttle classifier calls
const lastScoreAt = new Map();     // pid -> timestamp ms

function normText(s = '') {
  return String(s)
    .replace(/\s+/g, ' ')
    .replace(/^\s+|\s+$/g, '')
    .replace(/(^|[\s])(?:uh|um|erm|like|you know)(?=[\s,.!?]|$)/gi, '$1')
    .trim();
}

function appendToBuf(pid, piece) {
  const now = Date.now();
  const arr = transcriptBuf.get(pid) || [];
  const t = normText(piece);
  if (!t) return;

  if (arr.length && arr[arr.length - 1].t === t) {
    arr[arr.length - 1].time = now;
  } else {
    arr.push({ t, time: now });
  }

  const cutoff = now - BUF_MS;
  while (arr.length && arr[0].time < cutoff) arr.shift();
  transcriptBuf.set(pid, arr);
}

function getBufferedText(pid) {
  const arr = transcriptBuf.get(pid) || [];
  return arr.map(x => x.t).join('. ').replace(/\.\s*\./g, '.');
}

function hasEnoughContext(pid) {
  const joined = getBufferedText(pid);
  const words = joined.split(/\s+/).filter(Boolean);
  return joined.length >= MIN_CHARS && words.length >= MIN_WORDS;
}

// ---------------- Ingest endpoint ----------------
app.post('/sarcasm/chunk', upload.single('audio'), async (req, res) => {
  try {
    const participantId = String(req.body?.participantId || 'unknown');
    const buf = req.file?.buffer;
    const mime = req.file?.mimetype || 'audio/webm';

    console.log('[sarcasm] recv chunk bytes=', buf?.length, 'mime=', mime, 'pid=', participantId);
    if (!buf || !buf.length) return res.json([]);

    // STT for this slice
    const textRaw = await stt(buf, mime);
    const text = normText(textRaw);
    console.log('[sarcasm] transcript=', JSON.stringify(text));
    if (!text) return res.json([]); // no speech

    // Update buffer
    appendToBuf(participantId, text);

    // Require some context before scoring
    if (!hasEnoughContext(participantId)) {
      return res.json([]);
    }

    // Cooldown
    const now = Date.now();
    const last = lastScoreAt.get(participantId) || 0;
    if (now - last < SCORE_COOLDOWN_MS) {
      return res.json([]);
    }
    lastScoreAt.set(participantId, now);

    // Heuristic on buffered text (last ~12s)
    const joined = getBufferedText(participantId);
    const score = heuristicScore(joined);

    console.log('[sarcasm] joined len=', joined.length, '| score=', score.toFixed(3));
    return res.json([{ participantId, score }]);
  } catch (e) {
    console.error('sarcasm/chunk error', e?.response?.data || e);
    return res.json([]);
  }
});

// ---------------- Sanity route (heuristic only) ----------------
app.get('/sarcasm/test', (req, res) => {
  const q = String(req.query.q || 'yeah right, just what I needed.');
  const p = heuristicScore(q);
  res.json({ text: q, prob: p });
});

// ----------------------------------------------------------------
const PORT = process.env.PORT || 8081;
app.listen(PORT, () => console.log('sarcasm server listening on', PORT));
