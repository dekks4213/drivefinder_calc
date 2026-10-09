const { GoogleGenAI } = require('@google/genai');
// lamejs собран под браузер и ждёт свои классы в глобальной области.
globalThis.MPEGMode = globalThis.MPEGMode || require('lamejs/src/js/MPEGMode');
globalThis.Lame = globalThis.Lame || require('lamejs/src/js/Lame');
globalThis.BitStream = globalThis.BitStream || require('lamejs/src/js/BitStream');
const lamejs = require('lamejs');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const MODEL = process.env.TTS_MODEL || 'gemini-2.5-flash-preview-tts';
// Charon — низкий и ровный: под разбор прогула это звучит как приговор,
// а не как бодрый подкаст.
const VOICE = process.env.TTS_VOICE || 'Charon';
const RATE = 24000;
const MAX_CHARS = Number(process.env.TTS_MAX_CHARS) || 600;
const TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS) || 45000;

/**
 * Модель отдаёт сырой PCM, а Telegram голосовым принимает ogg/opus, mp3
 * или m4a. Кодируем в mp3 на чистом JS: ffmpeg в контейнере может не быть,
 * и тащить бинарник ради пинка не стоит.
 */
function pcmToMp3(pcm, rate = RATE) {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const encoder = new lamejs.Mp3Encoder(1, rate, Number(process.env.TTS_BITRATE) || 64);
  const chunks = [];

  const block = 1152;
  for (let i = 0; i < samples.length; i += block) {
    const part = encoder.encodeBuffer(samples.subarray(i, i + block));
    if (part.length) chunks.push(Buffer.from(part));
  }
  const tail = encoder.flush();
  if (tail.length) chunks.push(Buffer.from(tail));

  return Buffer.concat(chunks);
}

/** Текст голосом. Возвращает null, если озвучка не вышла: пинок важнее её. */
async function speak(text, instruction = 'Прочитай это жёстко, с нажимом, как тренер, который недоволен') {
  const clean = String(text || '').trim();
  if (!clean) return null;
  const prompt = `${instruction}:\n\n${clean.slice(0, MAX_CHARS)}`;

  try {
    const res = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      },
    });

    const part = (res.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData);
    if (!part) return null;

    const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType || '')?.[1]) || RATE;
    const mp3 = pcmToMp3(Buffer.from(part.inlineData.data, 'base64'), rate);
    return mp3.length ? mp3 : null;
  } catch (err) {
    console.error('озвучка не вышла:', err.message);
    return null;
  }
}

module.exports = { speak, pcmToMp3 };
