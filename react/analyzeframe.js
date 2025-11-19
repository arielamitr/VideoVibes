// analyzeframe.js
window.__EMOJI_PROBE_ANALYZE__ = true;

import * as faceapi from 'face-api.js';


window.__EMOJI_PROBE_ANALYZE__ = true;
// Create a single reusable canvas and context
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');

export async function loadFaceApiModels() {
    try {
        await faceapi.nets.tinyFaceDetector.loadFromUri('/static/models');
        await faceapi.nets.faceLandmark68Net.loadFromUri('/static/models');
        await faceapi.nets.faceExpressionNet.loadFromUri('/static/models');
        console.log('Face API models loaded');
    } catch (e) {
        console.error('Error loading Face API models:', e);
    }
}


export async function analyzeVideoFrame(videoElement) {
    if (!videoElement) return null;

    const detections = await faceapi
        .detectSingleFace(videoElement, new faceapi.TinyFaceDetectorOptions())
        .withFaceLandmarks()
        .withFaceExpressions();

    if (!detections) return 'No face';

    // Example: get the dominant expression
    const expressions = detections.expressions;
    let maxVal = 0;
    let dominantExpression = '';
    for (const [expr, val] of Object.entries(expressions)) {
        if (val > maxVal) {
            maxVal = val;
            dominantExpression = expr;
        }
    }

    return dominantExpression;
}


export function computeBrightness(video) {
    if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
        return null;
    }

    // Resize canvas to match video
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
    }

    try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

        let total = 0;
        for (let i = 0; i < data.length; i += 4) {
            // Average the RGB channels
            total += (data[i] + data[i + 1] + data[i + 2]) / 3;
        }

        return Math.round(total / (data.length / 4));
    } catch (e) {
        // Could fail if video is cross-origin or not ready
        return null;
    }
}
