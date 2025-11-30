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
import { EmojiButton } from '@joeattardi/emoji-button';



const logger = getLogger('app:index.web');

const DEFAULT_EMOJI_MAP = {
    neutral: '😐',
    happy: '😄',
    sad: '😢',
    angry: '😡',
    fearful: '😨',
    disgusted: '🤢',
    surprised: '😲'
};

const EMOJI_MAP = { ...DEFAULT_EMOJI_MAP };



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
    initEmojiConfigUI();
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

// === VideoVibes interval slider (bottom-right) ===
let vvIntervalSliderRoot = null;

function ensureIntervalSlider() {
    if (vvIntervalSliderRoot) {
        return;
    }

    const wrapper = document.createElement('div');
    wrapper.id = 'vv-interval-slider';
    Object.assign(wrapper.style, {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: 9999999,
        background: 'rgba(0, 0, 0, 0.85)',
        color: '#fff',
        padding: '10px 14px',
        borderRadius: '10px',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
        fontSize: '13px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        pointerEvents: 'auto',
        boxShadow: '0 4px 10px rgba(0,0,0,0.4)'
    });

    const title = document.createElement('div');
    title.textContent = 'VideoVibes quiz interval';
    title.style.fontWeight = '600';

    const valueLabel = document.createElement('div');
    valueLabel.style.opacity = '0.9';

    const setLabel = (ms) => {
        const seconds = Math.round(ms / 1000);
        valueLabel.textContent = `${seconds}s between questions`;
    };
    setLabel(LEARNING_REPROMPT_DELAY);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '5';
    slider.max = '60';
    slider.step = '1';
    slider.value = String(Math.round(LEARNING_REPROMPT_DELAY / 1000));
    slider.style.width = '200px';

    slider.addEventListener('input', () => {
        const seconds = Number(slider.value) || 10;
        LEARNING_REPROMPT_DELAY = seconds * 1000;
        setLabel(LEARNING_REPROMPT_DELAY);
    });

    wrapper.appendChild(title);
    wrapper.appendChild(valueLabel);
    wrapper.appendChild(slider);

    document.body.appendChild(wrapper);
    vvIntervalSliderRoot = wrapper;
}

function destroyIntervalSlider() {
    if (vvIntervalSliderRoot && vvIntervalSliderRoot.parentNode) {
        vvIntervalSliderRoot.parentNode.removeChild(vvIntervalSliderRoot);
    }
    vvIntervalSliderRoot = null;
}

// ========== EMOJI CONFIG UI ==========

let vvEmojiPanel = null;
let vvEmojiToggleButton = null;

function initEmojiConfigUI() {
    // Only create once
    if (vvEmojiPanel || !document.body) return;

    // ---- Panel container ----
    const panel = document.createElement('div');
    panel.className = 'vv-emoji-panel';
    Object.assign(panel.style, {
        position: 'fixed',
        right: '20px',
        bottom: '140px',
        padding: '12px 14px',
        background: 'rgba(0, 0, 0, 0.85)',
        borderRadius: '10px',
        color: '#fff',
        fontSize: '14px',
        display: 'none',
        flexDirection: 'column',
        gap: '8px',
        zIndex: 9999999,
        maxWidth: '260px'
    });

    // Title row
    const titleRow = document.createElement('div');
    Object.assign(titleRow.style, {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '4px',
        fontWeight: '600'
    });

    const title = document.createElement('span');
    title.textContent = 'Customize emojis';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    Object.assign(closeBtn.style, {
        all: 'unset',
        cursor: 'pointer',
        padding: '2px 6px',
        borderRadius: '6px',
        background: 'rgba(255,255,255,0.1)'
    });
    closeBtn.onclick = () => { panel.style.display = 'none'; };

    titleRow.appendChild(title);
    titleRow.appendChild(closeBtn);
    panel.appendChild(titleRow);

    // ---- Add emoji row ----
    function addEmojiRow(key) {
        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '6px'
        });

        const label = document.createElement('span');
        label.textContent = key;
        label.style.textTransform = 'capitalize';

        const input = document.createElement('input');
        input.type = 'text';
        input.value = EMOJI_MAP[key];
        input.maxLength = 4;
        Object.assign(input.style, {
            width: '60px',
            textAlign: 'center',
            borderRadius: '6px',
            border: '1px solid #444',
            padding: '2px 4px',
            background: '#222',
            color: '#fff',
            cursor: 'pointer'
        });

        // ---- Emoji Picker Integration ----
        const picker = new EmojiButton({ position: 'top-start', autoHide: true });

        picker.on('emoji', selection => {
            const emojiChar = typeof selection === 'string' ? selection : selection.emoji || '';
            input.value = emojiChar;
            EMOJI_MAP[key] = emojiChar;
            picker.hidePicker();
        });

        // Only open on click, not focus
        input.addEventListener('click', () => picker.showPicker(input));

        row.appendChild(label);
        row.appendChild(input);
        panel.appendChild(row);
    }

    Object.keys(DEFAULT_EMOJI_MAP).forEach(addEmojiRow);

    document.body.appendChild(panel);
    vvEmojiPanel = panel;

    // ---- Toggle button ----
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'vv-emoji-toggle';
    toggleBtn.textContent = '🙂 Emojis';
    Object.assign(toggleBtn.style, {
        position: 'fixed',
        right: '20px',
        bottom: '100px',
        padding: '6px 10px',
        background: 'rgba(0,0,0,0.8)',
        color: '#fff',
        borderRadius: '999px',
        border: '1px solid #555',
        cursor: 'pointer',
        fontSize: '13px',
        zIndex: 9999999
    });

    toggleBtn.onclick = () => {
        if (!vvEmojiPanel) return;
        vvEmojiPanel.style.display = vvEmojiPanel.style.display === 'none' ? 'flex' : 'none';
    };

    document.body.appendChild(toggleBtn);
    vvEmojiToggleButton = toggleBtn;
}



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
        inset: '0 auto auto 0',
        margin: '10px',
        padding: "16px 20px",
        background: "rgba(0, 0, 0, 0.75)",
        borderRadius: "12px",
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        zIndex: 9999999,
        pointerEvents: "auto",
        transform: 'translateX(10%)'
    });

    // --- Instruction prompt ---
    const prompt = document.createElement("div");
    prompt.innerText = "Which emoji best describes this person's emotion over the last 5 seconds?";
    Object.assign(prompt.style, {
        color: "white",
        fontSize: "18px",
        fontWeight: "600",
        lineHeight: "1.3",
        maxWidth: "280px"
    });
    wrapper.appendChild(prompt);

    // --- Emoji button row ---
    const row = document.createElement("div");
    Object.assign(row.style, {
        display: "flex",
        gap: "20px"
    });

    options.forEach(opt => {
        const btn = document.createElement('button');
        btn.innerText = EMOJI_MAP[opt];
        btn.dataset.choice = opt;

        Object.assign(btn.style, {
            all: 'unset',
            fontSize: '52px',
            padding: '8px 14px',
            background: '#fff',
            borderRadius: '8px',
            border: '2px solid #333',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: "transform 0.15s ease"
        });

        btn.onmouseenter = () => (btn.style.transform = "scale(1.2)");
        btn.onmouseleave = () => (btn.style.transform = "scale(1.0)");

        btn.onclick = () => {
            console.log("LearningMode: user clicked", opt);
            learningState.userSelection = opt;
        };

        row.appendChild(btn);
    });

    wrapper.appendChild(row);
    parent.appendChild(wrapper);
    return wrapper;
}

function showLearningFeedback(isCorrect, correctExpression) {
    if (!learningState.overlayEl) return;

    const wrapper = learningState.overlayEl;

    const emoji = isCorrect ? "✔️" : "❌";
    const title = isCorrect ? "Correct!" : "Incorrect";
    const message = isCorrect
        ? "Nice job! Your selection matches the detected emotion."
        : `The detected emotion was: ${EMOJI_MAP[correctExpression]} (${correctExpression})`;

    wrapper.innerHTML = `
        <div style="
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 10px;
            color: white;
            font-size: 26px;
            padding: 8px 14px;
            background: rgba(0,0,0,1.0);
            border-radius: 12px;
            animation: vvFadeOut 2s forwards ease-out;
        ">
            <div style="font-size: 46px;">${emoji}</div>
            <div style="font-weight: 700;">${title}</div>
            <div style="font-size: 20px; opacity: 0.85;">${message}</div>
        </div>
    `;

    setTimeout(() => {
        if (wrapper.parentNode) wrapper.remove();
    }, 3500);
}

// Add fade-out animation once globally
const style = document.createElement("style");
style.textContent = `
@keyframes vvFadeOut {
    0%   { opacity: 1; }
    75%  { opacity: 1; }
    100% { opacity: 0; }
}`;
document.head.appendChild(style);


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

        showLearningFeedback(isCorrect, learningState.correctExpression);
        learningState.feedbackShown = true;

        // After feedback, wait 2s, then clear UI and start cooldown
        setTimeout(() => {
            console.log("Learning timeout fired → clearing UI + starting cooldown");

            clearLearningUI();

            // keep screen blank for LEARNING_REPROMPT_DELAY
            learningCooldownUntil = Date.now() + LEARNING_REPROMPT_DELAY;
        }, 1600);

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
            destroyIntervalSlider();
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
            ensureIntervalSlider();
        } else if (mode === 'observation') {
            clearLearningUI();
            clearObservationUI();
            destroyIntervalSlider();
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
