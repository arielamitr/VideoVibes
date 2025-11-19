// modules/sarcasm/client/overlays.ts
// Show sarcasm emoji per-participant on both large view and tiles.

const sarcasmOverlays = new Map<HTMLVideoElement, HTMLElement>();

function ensureParentPositioned(el: HTMLVideoElement) {
  const parent = el && el.parentElement;
  if (!parent) return null;
  const cs = getComputedStyle(parent);
  if (cs.position === 'static') parent.style.position = 'relative';
  return parent;
}

function getOrCreateOverlay(video: HTMLVideoElement): HTMLElement | null {
  if (sarcasmOverlays.has(video)) return sarcasmOverlays.get(video)!;

  const parent = ensureParentPositioned(video);
  if (!parent) return null;

  const wrapper = document.createElement('div');
  Object.assign(wrapper.style, {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    zIndex: 20000
  });

  const badge = document.createElement('div');
  badge.className = 'sarcasm-badge';
  Object.assign(badge.style, {
    position: 'absolute',
    bottom: '8px',
    right: '8px',
    fontWeight: 'bold',
    textShadow: '0 1px 2px rgba(0,0,0,.6)',
    pointerEvents: 'none'
  });

  const resize = () => {
    const h = parent.offsetHeight || 300;
    badge.style.fontSize = Math.max(18, Math.floor(h * 0.2)) + 'px';
  };
  new ResizeObserver(resize).observe(parent);
  resize();

  wrapper.appendChild(badge);
  parent.appendChild(wrapper);
  sarcasmOverlays.set(video, badge);
  return badge;
}

export function clearAllSarcasmBadges() {
  sarcasmOverlays.forEach(badge => {
    badge.textContent = '';
    badge.removeAttribute('title');
  });
}

function getMyParticipantId(): string | null {
  try {
    const conf = (window as any).APP?.conference?._room;
    return conf?.myUserId?.() || null;
  } catch {
    return null;
  }
}

// === Public API ===
export function setSarcasmBadge(
  participantId: string,
  emoji: string,
  confidence?: number
) {
  const myId = getMyParticipantId();
  const isLocal =
    participantId === myId ||
    participantId === 'local' ||
    (!participantId && !!myId); // super defensive

  const targetVideos: HTMLVideoElement[] = [];

  if (isLocal) {
    // ----- LOCAL USER (old behavior) -----
    document
      .querySelectorAll<HTMLVideoElement>('video[id^="localVideo"]')
      .forEach(v => targetVideos.push(v));

    const hasRemote = document.querySelectorAll<HTMLVideoElement>(
      'video[id^="remoteVideo"]'
    ).length > 0;

    if (!hasRemote) {
      const large = document.querySelector<HTMLVideoElement>('#largeVideo');
      if (large && !targetVideos.includes(large)) {
        targetVideos.push(large);
      }
    }
  } else {
    // ----- REMOTE PARTICIPANT -----
    const pid = (participantId || '').toLowerCase();

    const remoteVideos = document.querySelectorAll<HTMLVideoElement>(
      'video[id^="remoteVideo"]'
    );
    const remoteCount = remoteVideos.length;

    // 1) All small tiles whose id contains this pid
    remoteVideos.forEach(v => {
      const id = (v.id || '').toLowerCase();
      if (pid && id.includes(pid)) {
        targetVideos.push(v);
      }
    });

    // 2) Try to mirror to the large view if it’s showing the same participant
    const large = document.querySelector<HTMLVideoElement>('#largeVideo');
    if (large) {
      const largeContainer = large.closest(
        '.large-video-container'
      ) as HTMLElement | null;

      const dataPid = (largeContainer?.dataset?.participantId || '').toLowerCase();
      const largeMatchesPid =
        (dataPid && pid && dataPid === pid) ||
        (!dataPid && remoteCount === 1); // 2-person call heuristic

      if (largeMatchesPid && !targetVideos.includes(large)) {
        targetVideos.push(large);
      }
    }
  }

  if (!targetVideos.length) {
    console.log('[sarcasm] setSarcasmBadge: no target videos for', {
      participantId,
      isLocal
    });
    return;
  }

  targetVideos.forEach(video => {
    const badge = getOrCreateOverlay(video);
    if (!badge) return;

    badge.textContent = emoji || '';

    if (emoji && typeof confidence === 'number') {
      badge.title = `sarcasm ${(confidence * 100).toFixed(0)}%`;
    } else {
      badge.removeAttribute('title');
    }
  });

  console.log('[sarcasm] badges updated', {
    participantId,
    emoji,
    confidence,
    isLocal,
    count: targetVideos.length
  });
}
