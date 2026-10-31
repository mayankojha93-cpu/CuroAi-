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
