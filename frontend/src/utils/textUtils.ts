/**
 * Utility functions for text processing and formatting.
 */

/**
 * Strips Devanagari/Hindi characters and parenthesized Hindi transliterations from text,
 * ensuring clean English-only rendering.
 *
 * Example: "Mayank Ojha (मयंक ओझा)" -> "Mayank Ojha"
 * Example: "Estate Green, JMD Megapolis (एस्टेट ग्रीन)" -> "Estate Green, JMD Megapolis"
 */
export function cleanEnglishOnly(str?: string | null): string {
  if (!str) return '';
  return str
    // Remove parenthesized Devanagari phrases, e.g. (मयंक ओझा) or (एस्टेट ग्रीन)
    .replace(/\s*\([\u0900-\u097F\s\-,./]+\)/g, '')
    // Remove any remaining Devanagari characters
    .replace(/[\u0900-\u097F]+/g, '')
    // Remove empty parentheses if left over
    .replace(/\(\s*\)/g, '')
    // Normalize multi-spaces
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export const VOICE_PIPELINE_DISPLAY_MAP: Record<string, string> = {
  'Sarvam AI (Priya - hi-IN)': 'Curoai 2026-0.2',
  'Sarvam AI (Shubh - en-IN)': 'Curoai 2026-0.3',
  'Sarvam AI (Arvind - hi-IN)': 'Curoai 2026-0.3',
  'Sarvam AI (Aditya - hi-IN)': 'Curoai 2026-0.3',
  'OpenAI Realtime (Alloy)': 'Curoai 2026-0.4',
  'OpenAI Realtime (Echo)': 'Curoai 2026-0.5',
  'ElevenLabs (Rachel - Expressive)': 'Curoai 2026-0.6',
};

/**
 * Maps raw backend voice pipeline provider values (e.g. "Sarvam AI (Shubh - en-IN)")
 * to clean user-facing labels (e.g. "Curoai 2026-0.3").
 */
export function formatVoicePipelineLabel(val?: string | null, isRealEstate?: boolean): string {
  if (!val || !val.trim()) {
    return isRealEstate ? 'Curoai 2026-0.3' : 'Curoai 2026-0.2';
  }
  const trimmed = val.trim();
  if (VOICE_PIPELINE_DISPLAY_MAP[trimmed]) {
    return VOICE_PIPELINE_DISPLAY_MAP[trimmed];
  }
  const low = trimmed.toLowerCase();
  if (low.includes('shubh') || low.includes('arvind') || low.includes('aditya') || low.includes('estate') || low.includes('sagar')) {
    return 'Curoai 2026-0.3';
  }
  if (low.includes('priya') || low.includes('airtel') || low.includes('router')) {
    return 'Curoai 2026-0.2';
  }
  if (low.includes('alloy')) {
    return 'Curoai 2026-0.4';
  }
  if (low.includes('echo')) {
    return 'Curoai 2026-0.5';
  }
  if (low.includes('elevenlabs') || low.includes('rachel')) {
    return 'Curoai 2026-0.6';
  }
  if (low.includes('2026-0.2') || low.includes('2026-.2')) return 'Curoai 2026-0.2';
  if (low.includes('2026-0.3') || low.includes('2026-.3')) return 'Curoai 2026-0.3';
  if (low.includes('2026-0.4') || low.includes('2026-.4')) return 'Curoai 2026-0.4';
  if (low.includes('2026-0.5') || low.includes('2026-.5')) return 'Curoai 2026-0.5';
  if (low.includes('2026-0.6') || low.includes('2026-.6')) return 'Curoai 2026-0.6';

  return isRealEstate ? 'Curoai 2026-0.3' : trimmed;
}
