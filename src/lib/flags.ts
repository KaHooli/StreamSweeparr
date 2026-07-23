/**
 * Convert an ISO 3166-1 alpha-2 country code to its flag emoji by mapping each
 * ASCII letter to the corresponding Regional Indicator Symbol.
 * Watchmode uses "GB" for the UK; browsers render 🇬🇧 correctly.
 */
export function flagEmoji(countryCode: string): string {
  const cc = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return "🏳️";
  const A = 0x1f1e6;
  const codePoints = [...cc].map((c) => A + (c.charCodeAt(0) - 65));
  return String.fromCodePoint(...codePoints);
}
