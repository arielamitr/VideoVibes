import React from 'react';
import ReactDOM from 'react-dom';

import { App } from './features/app/components/App.web';
import { getLogger } from './features/base/logging/functions';
import Platform from './features/base/react/Platform.web';
import {
    getJitsiMeetGlobalNS,
    getJitsiMeetGlobalNSConnectionTimes
} from './features/base/util/helpers';
import DialInSummaryApp from './features/invite/components/dial-in-summary/web/DialInSummaryApp';
import PrejoinApp from './features/prejoin/components/web/PrejoinApp';
import WhiteboardApp from './features/whiteboard/components/web/WhiteboardApp';
import { loadFaceApiModels, analyzeVideoFrame } from './analyzeframe';

const logger = getLogger('app:index.web');

const EMOJI_MAP = {
    neutral: '😐',
    happy: '😄',
    sad: '😢',
    angry: '😡',
    fearful: '😨',
    disgusted: '🤢',
    surprised: '😲'
};

// ===================== Global error handlers =====================
window.addEventListener('error', ev => {
    logger.error(
        `UnhandledError: ${ev.message}`,
        `Script: ${ev.filename}`,
        `Line: ${ev.lineno}`,
        `Column: ${ev.colno}`,
        'StackTrace: ', ev.error?.stack);
});

window.addEventListener('unhandledrejection', ev => {
    logger.error(
        `UnhandledPromiseRejection: ${ev.reason}`,
        'StackTrace: ', ev.reason?.stack);
});

// iOS back-forward cache workaround
if (Platform.OS === 'ios') {
    window.addEventListener('pageshow', event => {
        if (event.persisted) {
            window.location.reload();
        }
    });
}

const globalNS = getJitsiMeetGlobalNS();
const connectionTimes = getJitsiMeetGlobalNSConnectionTimes();

// Used to check if the load event has been fired.
globalNS.hasLoaded = false;

// Used for automated performance tests.
connectionTimes['index.loaded'] = window.indexLoadedTime;

window.addEventListener('load', () => {
    connectionTimes['window.loaded'] = window.loadedEventTime;
    globalNS.hasLoaded = true;
});

document.addEventListener('DOMContentLoaded', () => {
    const now = window.performance.now();
    connectionTimes['document.ready'] = now;
    logger.log('(TIME) document ready:\t', now);
});

globalNS.entryPoints = {
    APP: App,
    PREJOIN: PrejoinApp,
    DIALIN: DialInSummaryApp,
    WHITEBOARD: WhiteboardApp
};

globalNS.renderEntryPoint = ({
    Component,
    props = {},
    elementId = 'react'
}) => {
    /* eslint-disable-next-line react/no-deprecated */
    ReactDOM.render(
        <Component { ...props } />,
        document.getElementById(elementId)
    );
};

// ===================== Mode manager (Observer <-> Learning) =====================
let currentMode = 'observer'; // 'observer' | 'learning'
let rafId = null;

const ANALYZE_INTERVAL_MS = 400;
const HISTORY_DURATION_MS = 5000;
const videoExpressionHistory = new Map();

function cancelLoop() {
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

const modeListeners = new Set(); // <-- listeners for UI updates

function setMode(next) {
  if (next === currentMode) return;
  currentMode = next;
  cancelLoop();
  if (currentMode === 'observer') {
    rafId = requestAnimationFrame(updateOverlaysObserver);
  } else {
    rafId = requestAnimationFrame(updateLearningPipeline);
  }
  // notify toolbar listeners
  modeListeners.forEach((fn) => {
    try { fn(currentMode); } catch {}
  });
}

// expose a tiny API on the global Jitsi namespace
const globalNS = getJitsiMeetGlobalNS();
globalNS.videovibes = {
  getMode: () => currentMode,
  setMode: (m) => setMode(m === 'learning' ? 'learning' : 'observer'),
  toggle: () => setMode(currentMode === 'observer' ? 'learning' : 'observer'),
  subscribe: (cb) => {
    // cb receives ('observer' | 'learning')
    modeListeners.add(cb);
    return () => modeListeners.delete(cb);
  }
};


// ===================== Overlay helpers =====================
const overlays = new Map();

function getOrCreateOverlay(video) {
    if (overlays.has(video)) return overlays.get(video);

    const overlayWrapper = document.createElement('div');
    Object.assign(overlayWrapper.style, {
        position: 'absolute',
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
        pointerEvents: 'none'
    });

    const overlay = document.createElement('div');
    overlay.className = 'brightness-overlay';
    Object.assign(overlay.style, {
        position: 'absolute',
        top: '10',
        left: '10',
        color: 'red',
        fontWeight: 'bold',
        zIndex: 9999,
        pointerEvents: 'none'
    });

    // Resize emoji relative to tile height
    function resizeEmoji() {
        const h = overlayWrapper.offsetHeight || 0;
        overlay.style.fontSize = `${Math.floor(h * 0.2)}px`;
    }
    resizeEmoji();
    const resizeObserver = new ResizeObserver(resizeEmoji);
    resizeObserver.observe(overlayWrapper);

    overlayWrapper.appendChild(overlay);
    video.parentElement.appendChild(overlayWrapper);
    overlays.set(video, overlay);
    return overlay;
}

function computeMostFrequent(history) {
    if (!history.length) return 'N/A';
    const freq = {};
    for (const h of history) {
        freq[h.expression] = (freq[h.expression] || 0) + 1;
    }
    let best = 'N/A';
    let max = 0;
    for (const [expr, count] of Object.entries(freq)) {
        if (count > max) {
            max = count;
            best = expr;
        }
    }
    return best;
}

// ===================== Observer loop (UI overlays) =====================
function updateOverlaysObserver() {
    const now = Date.now();
    const videos = document.querySelectorAll(
        '.videocontainer video, .tile-view video, .large-video-container video'
    );

    videos.forEach(video => {
        const overlay = getOrCreateOverlay(video);

        if (!videoExpressionHistory.has(video)) {
            videoExpressionHistory.set(video, { history: [], lastAnalyzed: 0 });
        }
        const data = videoExpressionHistory.get(video);

        if (now - data.lastAnalyzed < ANALYZE_INTERVAL_MS) {
            const mostFrequent = computeMostFrequent(data.history);
            overlay.innerText = EMOJI_MAP[mostFrequent] || '❓';
            return;
        }

        data.lastAnalyzed = now;

        analyzeVideoFrame(video)
            .then(expression => {
                data.history.push({ expression, timestamp: now });
                data.history = data.history.filter(h => now - h.timestamp <= HISTORY_DURATION_MS);
                overlay.innerText = EMOJI_MAP[computeMostFrequent(data.history)] || '❓';
            })
            .catch(e => {
                console.error('Error analyzing video frame:', e);
                overlay.innerText = 'Error';
            });
    });

    rafId = requestAnimationFrame(updateOverlaysObserver);
}

// ===================== Learning loop (no overlays; collect/send) =====================
let learningQueue = []; // simple batch buffer

function updateLearningPipeline() {
    const now = Date.now();
    const videos = document.querySelectorAll(
        '.videocontainer video, .tile-view video, .large-video-container video'
    );

    videos.forEach(video => {
        analyzeVideoFrame(video)
            .then(expression => {
                // Collect whatever you need here; you can add landmarks or raw scores later
                learningQueue.push({ ts: now, expression });
                // Example throttle: log/send every 10 items
                if (learningQueue.length >= 10) {
                    // TODO: replace with your POST/WS send
                    // fetch('/api/learning-batch', { method: 'POST', body: JSON.stringify(learningQueue), headers: { 'Content-Type': 'application/json' } });
                    console.debug('[Learning] batch', learningQueue.map(e => e.expression));
                    learningQueue = [];
                }
            })
            .catch(e => console.error('Learning analyze error:', e));
    });

    rafId = requestAnimationFrame(updateLearningPipeline);
}

// ===================== Boot: load models, mount button, start mode =====================
loadFaceApiModels().then(() => {
    console.log('Face API models loaded');

    // Start appropriate pipeline
    if (currentMode === 'observer') {
        rafId = requestAnimationFrame(updateOverlaysObserver);
    } else {
        rafId = requestAnimationFrame(updateLearningPipeline);
    }
});
