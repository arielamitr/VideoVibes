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

// === Public API ===
export function setSarcasmBadge(
  participantId: string,
  emoji: string,
  confidence?: number
) {
  const videos = document.querySelectorAll<HTMLVideoElement>(
    [
      '#largeVideo',
      '.large-video-container video',
      '.tile-view video',
      '.videocontainer video',
      'video[id^="localVideo_"]',
      'video[id^="remoteVideo_"]'
    ].join(', ')
  );

  videos.forEach(video => {
    const badge = getOrCreateOverlay(video);
    if (!badge) return;

    badge.textContent = emoji || '';
    if (emoji && typeof confidence === 'number') {
      badge.title = `sarcasm ${(confidence * 100).toFixed(0)}%`;
    } else {
      badge.removeAttribute('title');
    }
  });

  console.log('[sarcasm] badges updated', { participantId, emoji, confidence });
}
