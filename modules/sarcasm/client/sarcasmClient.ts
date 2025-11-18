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

// Return up to maxStreams audio MediaStreams, one per participant (local + remotes).
function getParticipantAudioStreams(
  conf: any,
  maxStreams: number
): Array<{ participantId: string; stream: MediaStream }> {
  const result: Array<{ participantId: string; stream: MediaStream }> = [];


  console.log('[sarcasm] getParticipantAudioStreams: starting');

  // Log whatever Jitsi exposes so we see what we’re working with
  try {
    console.log('[sarcasm] conf.getParticipants?', typeof conf.getParticipants);
    console.log('[sarcasm] conf._participants keys', conf._participants && Object.keys(conf._participants));
  } catch (e) {
    console.log('[sarcasm] error inspecting conference', e);
  }


  // ----- 1) Local mic -----
  const localStream = getLocalAudioMediaStream(conf);
  const myId =
    conf.myUserId?.() ||
    (window as any).APP?.conference?._room?.myUserId?.() ||
    'local';

  if (localStream) {
    console.log('[sarcasm] found local stream for', myId);
    result.push({ participantId: myId, stream: localStream });
  }

  if (result.length >= maxStreams) {
    return result;
  }

  // ----- 2) Remote participants -----
  // Try to get the list of participants in a way that works across Jitsi versions.
  const rawParticipants =
    conf.getParticipants?.() ||
    Object.values(conf._participants || {}) ||
    [];
    console.log('[sarcasm] rawParticipants length=', rawParticipants.length);

  for (const p of rawParticipants) {
    if (result.length >= maxStreams) break;

    const pid: string =
      p.getId?.() ||
      p._id ||
      p._jid ||
      p.id;

    console.log('[sarcasm] inspect participant', { pid, p });

    if (!pid) {
      continue;
    }

    // Try several ways to get that participant's audio track.
    let audioTrack: any | null = null;

    // 1) JitsiConference helper
    if (typeof conf.getParticipantTracks === 'function') {
      const tracks = conf.getParticipantTracks(pid) || [];
      audioTrack =
        tracks.find((t: any) => t.getType?.() === 'audio') || tracks[0] || null;
    }

    // 2) On the participant object itself
    if (!audioTrack && typeof p.getTracks === 'function') {
      const tracks = p.getTracks() || [];
      audioTrack =
        tracks.find((t: any) => t.getType?.() === 'audio') || tracks[0] || null;
    }

    if (!audioTrack) {
      console.log('[sarcasm] no audio track for', pid);
      continue;
    }

    // Extract the underlying MediaStreamTrack, similar to what you did for local.
    let mt: MediaStreamTrack | null = null;

    if (typeof audioTrack.getOriginalStreamTrack === 'function') {
      mt = audioTrack.getOriginalStreamTrack();
    } else if (typeof audioTrack.getTrack === 'function') {
      mt = audioTrack.getTrack();
    } else if (audioTrack.stream instanceof MediaStream) {
      const ats = audioTrack.stream.getAudioTracks();
      if (ats.length) {
        mt = ats[0];
      }
    }

    if (!mt) {
      console.log('[sarcasm] could not extract MediaStreamTrack for', pid);
      continue;
    }

    const stream = new MediaStream([mt]);
    console.log('[sarcasm] added remote stream for', pid);
    result.push({ participantId: pid, stream });
  }

  console.log('[sarcasm] getParticipantAudioStreams result:', result.map(r => r.participantId));
  return result;
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

export function initSarcasm(
  conference: any,
  onSarcasm: (e: SarcasmEvent) => void,
  opts: Options
) {
  const conf = conference || getJitsiConference();
  if (!conf) {
    console.warn('[sarcasm] no conference instance');
    return;
  }

  const chunkMs = opts.chunkMs ?? 4000;
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  // pid -> { cancel: () => void }
  const loops = new Map<string, { cancel: () => void }>();

  function startLoopFor(participantId: string, stream: MediaStream) {
    if (loops.has(participantId)) {
      // already running
      return;
    }

    let cancelled = false;

    (async function loop() {
      console.log('[sarcasm] loop START for', participantId);

      while (!cancelled) {
        const tracks = stream.getAudioTracks();
        if (
          !stream ||
          tracks.length === 0 ||
          tracks[0].readyState === 'ended'
        ) {
          console.log('[sarcasm] stream ended, stopping loop for', participantId);
          break;
        }

        const blob = await recordOneChunk(stream, mime, chunkMs);
        console.log('[sarcasm] got blob for', participantId, 'size=', blob.size);

        if (!blob || blob.size === 0) {
          continue;
        }

        const fd = new FormData();
        fd.append('participantId', participantId);
        fd.append('audio', blob, 'chunk.webm');

        try {
          const resp = await fetch(opts.apiUrl + '/chunk', {
            method: 'POST',
            body: fd
          });

          const arr: Array<{ participantId: string; score: number }> =
            await resp.json();

          console.log('[sarcasm] server resp for', participantId, arr);

          for (const it of arr) {
            onSarcasm({
              participantId: it.participantId,
              isSarcastic: it.score >= (opts.threshold ?? 0.7),
              confidence: it.score
            });
          }
        } catch (e) {
          console.warn('[sarcasm] send error for', participantId, e);
        }
      }

      console.log('[sarcasm] loop EXIT for', participantId);
      loops.delete(participantId);
    })();

    loops.set(participantId, {
      cancel() {
        cancelled = true;
      }
    });
  }

  function stopLoopFor(participantId: string) {
    const ctl = loops.get(participantId);
    if (ctl) {
      console.log('[sarcasm] cancelling loop for', participantId);
      ctl.cancel();
      loops.delete(participantId);
    }
  }

  // Periodically rescan the conference and keep loops in sync with participants.
  function syncSources() {
    const sources = getParticipantAudioStreams(conf, 5);
    const currentIds = new Set(sources.map(s => s.participantId));

    console.log('[sarcasm] syncSources -> sources:', currentIds);

    // Start loops for any newly discovered sources
    for (const { participantId, stream } of sources) {
      startLoopFor(participantId, stream);
    }

    // Stop loops for participants that no longer have audio streams
    for (const pid of Array.from(loops.keys())) {
      if (!currentIds.has(pid)) {
        stopLoopFor(pid);
      }
    }
  }

  // Initial sync now
  syncSources();

  // And resync every 5 seconds (tweak as you like)
  const syncTimer = window.setInterval(syncSources, 5000);

  console.log('[sarcasm] initSarcasm started with periodic sync');

  // allow external stop: cancels all loops and the timer
  return {
    stop() {
      window.clearInterval(syncTimer);
      for (const pid of Array.from(loops.keys())) {
        stopLoopFor(pid);
      }
    }
  };
}



