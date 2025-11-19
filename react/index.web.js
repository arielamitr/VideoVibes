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

// ========== VIDEO VIBES OVERLAYS & MODES ==========

const overlays = new Map(); // video -> emoji overlay <div>
const videoExpressionHistory = new Map(); // video -> { history, lastAnalyzed }

const HISTORY_DURATION_MS = 5000;
const ANALYZE_INTERVAL_MS = 400;
let LEARNING_REPROMPT_DELAY = 10000;


// ---------- Mode helpers ----------

function getMode() {
    return window.APP.store.getState()['features/video-vibes']?.mode || 'observation';
}

// We track last mode so we can detect transitions
let lastMode = null;

// ---------- Observation overlay helpers ----------

function getOrCreateOverlay(video) {
    if (overlays.has(video)) {
        return overlays.get(video);
    }

    // Force the overlay to attach to the nearest video tile container,
    // not just any parent.
    const parent = video.closest('.videocontainer, .large-video-container');

    if (!parent) {
        console.warn('Video has no valid container:', video);
        return null;
    }

    const cs = getComputedStyle(parent);
    if (cs.position === 'static') {
        parent.style.position = 'relative';
    }

    const wrapper = document.createElement('div');
    Object.assign(wrapper.style, {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none'
    });

    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
        position: 'absolute',
        top: '10px',
        left: '10px',
        fontWeight: 'bold',
        color: 'red',
        zIndex: 9999,
        pointerEvents: 'none'
    });

    const resize = () => {
        const h = parent.offsetHeight || 300;
        overlay.style.fontSize = Math.floor(h * 0.2) + 'px';
    };

    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(parent);

    wrapper.appendChild(overlay);
    parent.appendChild(wrapper);

    overlays.set(video, overlay);
    return overlay;
}

function clearObservationUI() {
    overlays.forEach((overlay, video) => {
        const wrapper = overlay.parentElement;
        if (wrapper && wrapper.parentElement) {
            wrapper.parentElement.removeChild(wrapper);
        }
    });

    overlays.clear();
    videoExpressionHistory.clear();
}

function computeMostFrequent(history) {
    if (!history.length) {
        return 'N/A';
    }

    const freqMap = {};
    history.forEach(h => {
        freqMap[h.expression] = (freqMap[h.expression] || 0) + 1;
    });

    let most = 'N/A';
    let maxCount = 0;

    Object.entries(freqMap).forEach(([expr, count]) => {
        if (count > maxCount) {
            maxCount = count;
            most = expr;
        }
    });

    return most;
}

// ---------- LEARNING MODE STATE & UI ----------

const learningState = {
    active: false,
    targetVideo: null,
    correctExpression: null,
    options: [],
    userSelection: null,
    feedbackShown: false,
    overlayEl: null
};

let learningCooldownUntil = 0;

function clearLearningUI() {
    console.log("clearLearningUI called");

    if (learningState.overlayEl) {
        learningState.overlayEl.remove();
    }

    document.querySelectorAll(".vv-learning-wrapper").forEach(el => {
        console.log("Removing learning wrapper:", el);
        el.remove();         
    });

    learningState.active = false;
    learningState.targetVideo = null;
    learningState.correctExpression = null;
    learningState.options = [];
    learningState.userSelection = null;
    learningState.feedbackShown = false;
    learningState.overlayEl = null;
}

function pickLearningTarget() {
    const large = document.querySelector('.large-video-container video');
    if (large) {
        return large;
    }

    const vids = document.querySelectorAll('.videocontainer video, .tile-view video');
    return vids[0] || null;
}

function generateTwoOptions(correct) {
    const all = Object.keys(EMOJI_MAP);
    const distractors = all.filter(e => e !== correct);
    const wrong = distractors[Math.floor(Math.random() * distractors.length)];

    // randomize order
    return [correct, wrong].sort(() => Math.random() - 0.5);
}

function showLearningChoiceUI(targetVideo, options) {
    const parent = targetVideo.closest('.videocontainer, .large-video-container');
    if (!parent) return;

    const wrapper = document.createElement("div");
    wrapper.classList.add("vv-learning-wrapper");

    Object.assign(wrapper.style, {
        all: 'unset',
        position: "absolute",
        inset: '0 auto auto 0',  // top-left anchor
        margin: '10px',          // spacing from corner
        padding: "12px 16px",
        background: "rgba(0, 0, 0, 0.70)",
        borderRadius: "10px",
        display: "flex",
        gap: "20px",
        zIndex: 9999999,
        pointerEvents: "auto",
        transform: 'translateX(10%)'
    });

    options.forEach(opt => {
        const btn = document.createElement('button');
        btn.innerText = EMOJI_MAP[opt];
        btn.dataset.choice = opt;

        Object.assign(btn.style, {
            all: 'unset',
            fontSize: '56px',
            padding: '10px 18px',
            background: '#fff',
            borderRadius: '8px',
            border: '2px solid #333',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
        });

        btn.onclick = () => {
            console.log("LearningMode: user clicked", opt);
            learningState.userSelection = opt;
        };

        wrapper.appendChild(btn);
    });

    parent.appendChild(wrapper);
    return wrapper;
}

function showLearningFeedback(isCorrect) {
    if (!learningState.overlayEl) {
        return;
    }

    learningState.overlayEl.innerHTML = `
        <div style="
            color: white;
            font-size: 32px;
            text-align: center;
            padding: 12px 24px;
        ">
            ${isCorrect ? '✔️ Correct!' : '❌ Incorrect'}
        </div>
    `;
}

// ---------- LEARNING MODE LOOP ----------

async function updateLearningMode() {
    if (getMode() !== 'learning') {
        return;
    }

    // Start a round
    if (!learningState.active) {
        // If we're in cooldown, don't start a new round yet
        if (learningCooldownUntil && Date.now() < learningCooldownUntil) {
            return;
        }

        clearLearningUI();

        const video = pickLearningTarget();
        if (!video) {
            return;
        }

        const expr = await analyzeVideoFrame(video);

        console.log("LearningMode: analyzed expression =", expr);
        
        if (!expr || !EMOJI_MAP[expr]) {
            return;
        }

        learningState.targetVideo = video;
        learningState.correctExpression = expr;
        learningState.options = generateTwoOptions(expr);
        learningState.overlayEl = showLearningChoiceUI(video, learningState.options);
        learningState.active = true;

        return;
    }

    // Wait for user to click
    if (learningState.userSelection && !learningState.feedbackShown) {
        const isCorrect = learningState.userSelection === learningState.correctExpression;

        showLearningFeedback(isCorrect);
        learningState.feedbackShown = true;

        // After feedback, wait 2s, then clear UI and start cooldown
        setTimeout(() => {
            console.log("Learning timeout fired → clearing UI + starting cooldown");

            clearLearningUI();

            // keep screen blank for LEARNING_REPROMPT_DELAY
            learningCooldownUntil = Date.now() + LEARNING_REPROMPT_DELAY;
        }, 2000);

        return;
    }
}

// ---------- OBSERVATION MODE LOOP ----------

function updateObservationMode() {
    if (getMode() !== 'observation') {
        return;
    }

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
            const freq = computeMostFrequent(data.history);
            const emoji = EMOJI_MAP[freq] || '❓';
            overlay.innerText = emoji;
            return;
        }

        data.lastAnalyzed = now;

        analyzeVideoFrame(video)
            .then(expression => {
                data.history.push({ expression, timestamp: now });
                data.history = data.history.filter(
                    h => now - h.timestamp <= HISTORY_DURATION_MS
                );

                const freq = computeMostFrequent(data.history);
                const emoji = EMOJI_MAP[freq] || '❓';
                overlay.innerText = emoji;
            })
            .catch(err => {
                console.error('Error analyzing video frame:', err);
                overlay.innerText = 'Error';
            });
    });
}

// ---------- MASTER LOOP WITH MODE TRANSITIONS ----------
let modelsLoaded = false;
let conferenceJoined = false;
let loopStarted = false;
let stopLoop = false;

// Wait for store BEFORE subscribing 

function waitForStoreReady() {
    if (window.APP?.store) {
        console.log("Store is ready → subscribing to conference events");
        setupConferenceSubscription(window.APP.store);
    } else {
        console.log("Store not ready yet… retrying");
        setTimeout(waitForStoreReady, 50);
    }
}

waitForStoreReady();

// Actual subscription moved here

function setupConferenceSubscription(store) {
    store.subscribe(() => {
        const state = store.getState();
        const conf = state['features/base/conference']?.conference;

        if (conf && !conferenceJoined) {
            console.log("Conference joined");
            conferenceJoined = true;
            stopLoop = false;
            tryStartMasterLoop();
        }

        if (!conf && conferenceJoined) {
            console.log("Conference left → stopping VideoVibes");
            conferenceJoined = false;
            loopStarted = false;
            stopLoop = true;

            clearLearningUI();
            clearObservationUI();
        }
    });
}

// Start loop only when ready

function tryStartMasterLoop() {
    if (modelsLoaded && conferenceJoined && !loopStarted) {
        console.log("Starting VideoVibes masterLoop()");
        loopStarted = true;
        stopLoop = false;
        requestAnimationFrame(masterLoop);
    }
}

function masterLoop() {
    if (stopLoop) return;

    const mode = getMode();

    if (lastMode === null) {
        lastMode = mode;
    } else if (mode !== lastMode) {
        if (mode === 'learning') {
            clearObservationUI();
            clearLearningUI();
            learningCooldownUntil = 0;
        } else if (mode === 'observation') {
            clearLearningUI();
            clearObservationUI();
        }
        lastMode = mode;
    }

    if (mode === 'learning') {
        updateLearningMode();
    } else {
        updateObservationMode();
    }

    requestAnimationFrame(masterLoop);
}

// ---- Face API load ----

loadFaceApiModels().then(() => {
    modelsLoaded = true;
    console.log("Face API models loaded");
    tryStartMasterLoop();
});
