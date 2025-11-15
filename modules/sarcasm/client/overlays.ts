// modules/sarcasm/client/overlays.ts
// Mirrors the facial-expression overlay logic so 🤞 shows in both
// the large view and all participant tiles.

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

  // Wrapper layer (covers the tile)
  const wrapper = document.createElement('div');
  Object.assign(wrapper.style, {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    zIndex: 20000
  });

  // The actual 🤞 badge
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

  // Responsive sizing (≈20 % of tile height)
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


// helper function for sarcasm badge updates for other participants
export function clearAllSarcasmBadges() {
  sarcasmOverlays.forEach((badge) => {
    badge.textContent = '';
    badge.removeAttribute('title');
  });
}



// === Public API ===
export function setSarcasmBadge(
  participantId: string,  // currently unused, but kept for future multi-user support
  emoji: string,
  confidence?: number
) {
  const targetVideos: HTMLVideoElement[] = [];

  // 1) Local thumbnails on this client (your own camera tiles)
  document
    .querySelectorAll<HTMLVideoElement>('video[id^="localVideo"]')
    .forEach(v => targetVideos.push(v));

  // 2) Check if there are any remote video elements
  const remoteVideos = document.querySelectorAll<HTMLVideoElement>(
    'video[id^="remoteVideo"]'
  );

  // If there are *no* remote participants, you're alone in the room.
  // In that case, also treat the main large video as yours.
  if (remoteVideos.length === 0) {
    const large = document.querySelector<HTMLVideoElement>('#largeVideo');
    if (large && !targetVideos.includes(large)) {
      targetVideos.push(large);
    }
  }

  // --- Update overlays for target videos (your tiles) ---
  targetVideos.forEach(video => {
    const badge = getOrCreateOverlay(video);
    if (!badge) {
      return;
    }

    badge.textContent = emoji || '';

    if (emoji && typeof confidence === 'number') {
      badge.title = `sarcasm ${(confidence * 100).toFixed(0)}%`;
    } else {
      badge.removeAttribute('title');
    }
  });

  // --- Clear overlays for NON-target videos (old/stale ones) ---
  sarcasmOverlays.forEach((badge, video) => {
    if (!targetVideos.includes(video)) {
      badge.textContent = '';
      badge.removeAttribute('title');
    }
  });

  console.log('[sarcasm] badges updated', {
    participantId,
    emoji,
    confidence,
    targetCount: targetVideos.length,
    hasRemoteVideos: remoteVideos.length > 0
  });
}
