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

// ===================== LEGACY HEURISTIC (kept as feature) =====================

function legacyHeuristicScore(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t) return 0;

  const strong = STRONG_CUES;
  const weak = WEAK_CUES;

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

// ===================== FEATURE-BASED SCORER (NEW) =====================

// --- Cues reused from legacy heuristic ---
const STRONG_CUES = [
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

const WEAK_CUES = [
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

// --- Tiny sentiment-ish lexicons ---

const POS_WORDS = [
  'great', 'wonderful', 'awesome', 'amazing',
  'perfect', 'love', 'fantastic', 'incredible', 'nice', 'cool'
];

const NEG_WORDS = [
  'hate', 'terrible', 'awful', 'sucks', 'stupid',
  'annoying', 'horrible', 'miserable', 'disaster', 'worst', 'awful'
];

const BAD_SITUATIONS = [
  'traffic', 'meeting', 'meetings', 'deadlines', 'bug', 'bugs',
  'lag', 'exam', 'exams', 'monday', 'mornings', 'homework'
];

// Helpers
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function tokenizeWords(t) {
  return t
    .split(/\s+/)
    .map(w => w.replace(/[.,!?;:()"']/g, ''))
    .filter(Boolean);
}

function countLexicon(words, lexiconSet) {
  let c = 0;
  for (const w of words) {
    if (lexiconSet.has(w)) c++;
  }
  return c;
}

const POS_SET = new Set(POS_WORDS);
const NEG_SET = new Set(NEG_WORDS);
const BAD_SET = new Set(BAD_SITUATIONS);

// Check positive word in same sentence as bad-topic word
function hasPosNearBadTopic(textLower) {
  const sentences = textLower.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
  for (const s of sentences) {
    const words = tokenizeWords(s);
    let hasPos = false;
    let hasBad = false;

    for (const w of words) {
      if (POS_SET.has(w)) hasPos = true;
      if (BAD_SET.has(w)) hasBad = true;
      if (hasPos && hasBad) return true;
    }
  }
  return false;
}

// Check "short positive then negative" pattern in adjacent sentences
function hasShortPositiveThenNegative(textLower) {
  const sentences = textLower.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
  if (sentences.length < 2) return false;

  for (let i = 0; i < sentences.length - 1; i++) {
    const s1 = sentences[i];
    const s2 = sentences[i + 1];

    const w1 = tokenizeWords(s1);
    const w2 = tokenizeWords(s2);

    if (w1.length <= 6) {
      const pos1 = w1.some(w => POS_SET.has(w));
      if (pos1) {
        const neg2 = w2.some(w => NEG_SET.has(w) || BAD_SET.has(w));
        if (neg2) {
          return true;
        }
      }
    }
  }
  return false;
}

// Count ALLCAPS-ish words
function countAllCaps(words) {
  let c = 0;
  for (const w of words) {
    if (w.length >= 3 && /^[A-Z]+$/.test(w)) c++;
  }
  return c;
}

// Main new scorer
function sarcasmScore(text) {
  const tRaw = String(text || '');
  const t = tRaw.toLowerCase().trim();
  if (!t) return 0;

  const words = tokenizeWords(t);
  const wordCount = words.length;

  // f0: legacy heuristic
  const f0 = legacyHeuristicScore(t);

  // strong/weak cue counts
  let strongMatches = 0;
  for (const r of STRONG_CUES) {
    if (r.test(t)) strongMatches++;
  }
  let weakMatches = 0;
  for (const r of WEAK_CUES) {
    if (r.test(t)) weakMatches++;
  }
  const f1 = Math.min(strongMatches / 2, 1); // strong cues (cap)
  const f2 = Math.min(weakMatches / 3, 1);   // weak cues (cap)

  // polarity-ish features
  const posCount = countLexicon(words, POS_SET);
  const negCount = countLexicon(words, NEG_SET);
  const f3 = Math.min(posCount / 4, 1); // pos density
  const f4 = Math.min(negCount / 4, 1); // neg density
  const f5 = posCount > 0 && negCount > 0 ? 1 : 0; // polarity mix

  const f6 = hasPosNearBadTopic(t) ? 1 : 0; // positive near bad topic

  // emphasis / prosody proxies
  const f7 = /[!?]{2,}/.test(t) ? 1 : 0; // multi punctuation
  const f8 = /\b\w*(\w)\1{2,}\w*\b/.test(t) ? 1 : 0; // stretchy words like sooo
  const allCapsCount = countAllCaps(tRaw.split(/\s+/));
  const f9 = Math.min(allCapsCount / 2, 1);

  // discourse patterns
  const f10 = hasShortPositiveThenNegative(t) ? 1 : 0;

  const f11 = /"[^"]*(great|awesome|perfect|amazing|wonderful)[^"]*"/i.test(tRaw)
    ? 1
    : 0;

  // length/context
  const f12 = Math.min(wordCount / 25, 1); // 0–1 as 0–25 words

  // Linear comb (hand-tuned weights)
  let scoreRaw = 0;

  scoreRaw += 2.0 * f0;
  scoreRaw += 1.2 * f1;
  scoreRaw += 0.8 * f2;
  scoreRaw += 0.4 * f3;
  scoreRaw += 0.4 * f4;
  scoreRaw += 0.8 * f5;
  scoreRaw += 1.0 * f6;
  scoreRaw += 0.5 * f7;
  scoreRaw += 0.4 * f8;
  scoreRaw += 0.3 * f9;
  scoreRaw += 0.8 * f10;
  scoreRaw += 0.7 * f11;
  scoreRaw += 0.3 * f12;

  // bias term (so default is "not sarcastic")
  scoreRaw -= 1.2;

  const score = sigmoid(scoreRaw);
  return Math.max(0, Math.min(1, score));
}

// ===================== Rolling buffer (per-speaker) =====================
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

// ===================== Ingest endpoint =====================

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

    // New feature-based sarcasm score on buffered text (last ~12s)
    const joined = getBufferedText(participantId);
    const score = sarcasmScore(joined);

    console.log('[sarcasm] joined len=', joined.length, '| score=', score.toFixed(3));
    return res.json([{ participantId, score }]);
  } catch (e) {
    console.error('sarcasm/chunk error', e?.response?.data || e);
    return res.json([]);
  }
});

// ===================== Sanity route =====================

app.get('/sarcasm/test', (req, res) => {
  const q = String(req.query.q || 'yeah right, just what I needed.');
  const legacy = legacyHeuristicScore(q);
  const prob = sarcasmScore(q);
  res.json({ text: q, prob, legacy });
});

// ----------------------------------------------------------------
const PORT = process.env.PORT || 8081;
app.listen(PORT, () => console.log('sarcasm server listening on', PORT));
