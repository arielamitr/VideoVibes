/* Jitsi Meet app main entrypoint. */

// Re-export jQuery
// FIXME: Remove this requirement from torture tests.
import $ from 'jquery';

window.$ = window.jQuery = $;

import '@matrix-org/olm';

import 'focus-visible';


/*
* Safari polyfill for createImageBitmap
* https://developer.mozilla.org/en-US/docs/Web/API/WindowOrWorkerGlobalScope/createImageBitmap
*
* Support source image types: Canvas.
*/
if (!('createImageBitmap' in window)) {
    window.createImageBitmap = function(data) {
        return new Promise((resolve, reject) => {
            let dataURL;

            if (data instanceof HTMLCanvasElement) {
                dataURL = data.toDataURL();
            } else {
                reject(new Error('createImageBitmap does not handle the provided image source type'));
            }
            const img = document.createElement('img');

            img.addEventListener('load', () => {
                resolve(img);
            });
            img.src = dataURL;
        });
    };
}

// We need to setup the jitsi-local-storage as early as possible so that we can start using it.
// NOTE: If jitsi-local-storage is used before the initial setup is performed this will break the use case when we use
// the  local storage from the parent page when the localStorage is disabled. Also the setup is relying that
// window.location is not changed and still has all URL parameters.
import './react/features/base/jitsi-local-storage/setup';
import conference from './conference';
import API from './modules/API';
import UI from './modules/UI/UI';
import translation from './modules/translation/translation';


// DEV fallback: if remote /config.js didn't include our block, define it here.
if (typeof __DEV__ !== 'undefined' && __DEV__) {
  window.config = window.config || {};
  if (!window.config.sarcasm) {
    window.config.sarcasm = {
      enabled: true,
      apiUrl: 'http://localhost:8081/sarcasm',
      chunkMs: 5000,
      threshold: 0.6
    };
    console.log('[sarcasm] using local DEV fallback config');
  }
}

// Initialize Olm as early as possible.
if (window.Olm) {
    window.Olm.init().catch(e => {
        console.error('Failed to initialize Olm, E2EE will be disabled', e);
        delete window.Olm;
    });
}

window.APP = {
    API,
    conference,
    translation,
    UI
};

// TODO The execution of the mobile app starts from react/index.native.js.
// Similarly, the execution of the Web app should start from react/index.web.js
// for the sake of consistency and ease of understanding. Temporarily though
// because we are at the beginning of introducing React into the Web app, allow
// the execution of the Web app to start from app.js in order to reduce the
// complexity of the beginning step.
import './react';

// === VideoVibes sarcasm bootstrap ===
(async function bootstrapSarcasm() {
  // guard & feature flag
  console.log('[sarcasm] bootstrap starting');                 // <— add
  if (!window.config?.sarcasm?.enabled) return;

  // wait until the JitsiConference object exists (robust on all flows)
  const waitForConference = () => new Promise(resolve => {
    const i = setInterval(() => {
      const conf = window.APP?.conference?._room; // JitsiConference instance
      if (conf) { clearInterval(i); resolve(conf); }
    }, 200);
  });

  const conf = await waitForConference();
  console.log('[sarcasm] got conference, wiring up');          // <— add

  // lazy import so we don’t bloat initial bundle
  const { initSarcasm } = await import('./modules/sarcasm/client/sarcasmClient.ts');
  const { setSarcasmBadge } = await import('./modules/sarcasm/client/overlays.ts');

  initSarcasm(conf, (evt) => {
    // evt: { participantId, isSarcastic, confidence }
    setSarcasmBadge(evt.participantId, evt.isSarcastic ? '🤞' : '', evt.confidence);
  }, window.config.sarcasm);
})();