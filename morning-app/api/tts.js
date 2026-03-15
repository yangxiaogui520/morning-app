// api/tts.js  ── Vercel Serverless Function
// Uses edge-tts-node to call Microsoft Edge TTS (free, no API key needed)

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, voice = 'zh-CN-XiaoxiaoNeural', rate = '+0%', pitch = '+0Hz' } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text is required' });
  if (text.length > 3000) return res.status(400).json({ error: 'text too long' });

  try {
    // Dynamically import edge-tts
    const EdgeTTS = (await import('edge-tts')).default || (await import('edge-tts'));
    const tts = new EdgeTTS();
    const audioBuffer = await tts.synthesize(text, voice, { rate, pitch });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(Buffer.from(audioBuffer));
  } catch (e) {
    // Fallback: call Edge TTS WebSocket API directly
    try {
      const audio = await callEdgeTTSDirect(text, voice, rate, pitch);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(audio);
    } catch (e2) {
      console.error('TTS error:', e2);
      return res.status(500).json({ error: 'TTS failed', detail: e2.message });
    }
  }
}

// Direct Edge TTS WebSocket implementation (no npm package needed)
async function callEdgeTTSDirect(text, voice, rate, pitch) {
  const { createHash, randomUUID } = await import('crypto');
  const WebSocket = (await import('ws')).default;

  const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  const endpoint = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint, {
      headers: {
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const requestId = randomUUID().replace(/-/g, '');
    const chunks = [];
    let started = false;

    ws.on('open', () => {
      // Send config
      ws.send(
        `X-Timestamp:${new Date().toISOString()}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } })
      );

      // Send SSML
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>`+
        `<voice name='${voice}'>`+
        `<prosody rate='${rate}' pitch='${pitch}'>${escapeXml(text)}</prosody>`+
        `</voice></speak>`;

      ws.send(
        `X-RequestId:${requestId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${new Date().toISOString()}\r\n` +
        `Path:ssml\r\n\r\n` +
        ssml
      );
    });

    ws.on('message', (data) => {
      if (typeof data === 'string') {
        if (data.includes('Path:turn.end')) {
          ws.close();
          if (chunks.length > 0) {
            resolve(Buffer.concat(chunks));
          } else {
            reject(new Error('No audio data received'));
          }
        }
      } else {
        // Binary audio data — skip the header (find \r\n\r\n separator)
        const idx = data.indexOf('\r\n\r\n', 0, 'binary');
        if (idx !== -1) {
          chunks.push(data.slice(idx + 4));
          started = true;
        } else if (started) {
          chunks.push(data);
        }
      }
    });

    ws.on('error', reject);
    const timer = setTimeout(() => { ws.close(); reject(new Error('TTS timeout')); }, 25000);
    ws.on('close', () => clearTimeout(timer));
  });
}

function escapeXml(text) {
  return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
