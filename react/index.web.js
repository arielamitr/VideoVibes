import React from 'react';
import ReactDOM from 'react-dom';

import { App } from './features/app/components/App.web';
import { getLogger } from './features/base/logging/functions';
import Platform from './features/base/react/Platform.web';
import { getJitsiMeetGlobalNS, getJitsiMeetGlobalNSConnectionTimes } from './features/base/util/helpers';
import DialInSummaryApp from './features/invite/components/dial-in-summary/web/DialInSummaryApp';
import PrejoinApp from './features/prejoin/components/web/PrejoinApp';
import WhiteboardApp from './features/whiteboard/components/web/WhiteboardApp';
import { computeBrightness } from './analyzeframe';
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


// Add global loggers.
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

// Workaround for the issue when returning to a page with the back button and
// the page is loaded from the 'back-forward' cache on iOS which causes nothing
// to be rendered.
if (Platform.OS === 'ios') {
    window.addEventListener('pageshow', event => {
        // Detect pages loaded from the 'back-forward' cache
        // (https://webkit.org/blog/516/webkit-page-cache-ii-the-unload-event/)
        if (event.persisted) {
            // Maybe there is a more graceful approach but in the moment of
            // writing nothing else resolves the issue. I tried to execute our
            // DOMContentLoaded handler but it seems that the 'onpageshow' event
            // is triggered only when 'window.location.reload()' code exists.
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

// Function to resize emoji based on container height
function resizeEmoji() {
    const containerHeight = overlayWrapper.offsetHeight;
    overlay.style.fontSize = `${Math.floor(containerHeight * 0.2)}px`;
}

// Initial resize
resizeEmoji();

// Optional: observe changes to wrapper size (for responsive layouts)
const resizeObserver = new ResizeObserver(resizeEmoji);
resizeObserver.observe(overlayWrapper);


    overlayWrapper.appendChild(overlay);
    video.parentElement.appendChild(overlayWrapper);
    overlays.set(video, overlay);
    return overlay;
}

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');

// Map video element -> { history: [], lastAnalyzed: timestamp }
const videoExpressionHistory = new Map();
const HISTORY_DURATION_MS = 5000; // 5 seconds
const ANALYZE_INTERVAL_MS = 400; // ~2.5 FPS

function updateOverlays() {
    const now = Date.now();
    const videos = document.querySelectorAll('.videocontainer video, .tile-view video, .large-video-container video');

    videos.forEach(video => {
        const overlay = getOrCreateOverlay(video);

        if (!videoExpressionHistory.has(video)) {
            videoExpressionHistory.set(video, { history: [], lastAnalyzed: 0 });
        }

        const data = videoExpressionHistory.get(video);

        if (now - data.lastAnalyzed < ANALYZE_INTERVAL_MS) {
            // Skip this frame, use existing overlay
            const mostFrequent = computeMostFrequent(data.history);
            overlay.innerText = EMOJI_MAP[mostFrequent] || '❓';
            return;
        }

        data.lastAnalyzed = now;

        analyzeVideoFrame(video)
            .then(expression => {
                // Push new value with timestamp
                data.history.push({ expression, timestamp: now });

                // Remove old entries
                data.history = data.history.filter(h => now - h.timestamp <= HISTORY_DURATION_MS);

                // Update overlay
                overlay.innerText = EMOJI_MAP[computeMostFrequent(data.history)] || '❓';
            })
            .catch(e => {
                console.error('Error analyzing video frame:', e);
                overlay.innerText = 'Error';
            });
    });

    requestAnimationFrame(updateOverlays);
}

function computeMostFrequent(history) {
    if (!history.length) return 'N/A';
    const freqMap = {};
    history.forEach(h => {
        freqMap[h.expression] = (freqMap[h.expression] || 0) + 1;
    });
    let mostFrequent = 'N/A';
    let maxCount = 0;
    Object.entries(freqMap).forEach(([expr, count]) => {
        if (count > maxCount) {
            maxCount = count;
            mostFrequent = expr;
        }
    });
    return mostFrequent;
}


loadFaceApiModels().then(() => {
    console.log('Face API models loaded');

    // Everything that depends on the models goes here
    requestAnimationFrame(updateOverlays);    // other initialization code
});

