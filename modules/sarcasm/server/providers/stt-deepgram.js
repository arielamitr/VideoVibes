// modules/sarcasm/server/providers/stt-deepgram.js
const axios = require('axios');
const DG_URL = 'https://api.deepgram.com/v1/listen';

exports.stt = async function stt_deepgram(webmBuffer, mime = 'audio/webm;codecs=opus') {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return '';

  try {
    const res = await axios.post(
      `${DG_URL}?model=nova-2-general&smart_format=true&punctuate=true&filler_words=false&encoding=opus&language=en-US`,
      webmBuffer,
      {
        responseType: 'json',
        headers: {
          'Authorization': `Token ${apiKey}`,
          'Content-Type': mime // mirror client’s blob type
        },
        timeout: 15000
      }
    );
    const alt = res.data?.results?.channels?.[0]?.alternatives?.[0];
    return alt?.transcript?.trim() || '';
  } catch (e) {
    console.warn('[stt-deepgram] error', e?.response?.data || e.message);
    return '';
  }
};

