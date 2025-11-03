// modules/sarcasm/client/sarcasmClient.ts

type Options = {
  apiUrl: string;   // e.g. "http://localhost:8081/sarcasm"
  chunkMs: number;  // e.g. 4000
  threshold: number; // e.g. 0.7
};

type SarcasmEvent = {
  participantId: string;
  isSarcastic: boolean;
  confidence: number;
};

function getJitsiConference(): any {
  return (window as any).APP?.conference?._room;
}

function getLocalAudioMediaStream(conf: any): MediaStream | null {
  try {
    const tracks = conf?.getLocalTracks?.() || [];
    const audio = tracks.find((t: any) => t?.getType?.() === 'audio');
    if (!audio) return null;

    // Try several accessors; different Jitsi builds expose different shapes
    if (typeof audio.getOriginalStream === 'function') {
      const s: MediaStream | null = audio.getOriginalStream();
      if (s?.getAudioTracks?.().length) return s;
    }
    if (typeof audio.getTrack === 'function') {
      const mt: MediaStreamTrack | null = audio.getTrack();
      if (mt) return new MediaStream([ mt ]);
    }
    if (typeof audio.getOriginalStreamTrack === 'function') {
      const mt: MediaStreamTrack | null = audio.getOriginalStreamTrack();
      if (mt) return new MediaStream([ mt ]);
    }
    if (audio.stream instanceof MediaStream) {
      return audio.stream;
    }
  } catch (e) {
    console.warn('[sarcasm] getLocalAudioMediaStream error', e);
  }
  return null;
}

function recordOneChunk(stream: MediaStream, mime: string, ms: number): Promise<Blob> {
  return new Promise((resolve) => {
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { mimeType: mime /* , audioBitsPerSecond: 128000 */ });
    } catch (e) {
      console.warn('[sarcasm] MediaRecorder init failed', e);
      return resolve(new Blob());
    }

    const parts: BlobPart[] = [];
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) parts.push(ev.data);
    };
    rec.onstop = () => resolve(new Blob(parts, { type: mime }));

    rec.start(); // IMPORTANT: no timeslice -> one full file per chunk
    setTimeout(() => {
      try { rec.stop(); } catch { resolve(new Blob([], { type: mime })); }
    }, ms);
  });
}

export function initSarcasm(conference: any, onSarcasm: (e: SarcasmEvent) => void, opts: Options) {
  const conf = conference || getJitsiConference();
  if (!conf) {
    console.warn('[sarcasm] no conference instance');
    return;
  }

  const stream = getLocalAudioMediaStream(conf);
  if (!stream) {
    console.warn('[sarcasm] no local mic stream');
    return;
  }

  const participantId =
    conf.myUserId?.() ||
    (window as any).APP?.conference?._room?.myUserId?.() ||
    'local';

  const chunkMs = opts.chunkMs ?? 4000;

  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  console.log('[sarcasm] init recorder loop', { participantId, mime, chunkMs });

  let cancelled = false;

  (async function loop() {
    while (!cancelled) {
      const blob = await recordOneChunk(stream, mime, chunkMs);
      if (!blob || blob.size === 0) continue;

      const fd = new FormData();
      fd.append('participantId', participantId);
      fd.append('audio', blob, 'chunk.webm');

      try {
        const resp = await fetch(opts.apiUrl + '/chunk', { method: 'POST', body: fd });
        const arr: Array<{ participantId: string; score: number }> = await resp.json();

        console.log('[sarcasm] server resp', arr);
        for (const it of arr) {
          onSarcasm({
            participantId: it.participantId,
            isSarcastic: it.score >= (opts.threshold ?? 0.7),
            confidence: it.score
          });
        }
      } catch (e) {
        console.warn('[sarcasm] send error', e);
      }
    }
  })();

  return { stop() { cancelled = true; } };
}
