export function krakenChecksumPayload(bids: Array<[string, string]>, asks: Array<[string, string]>): string {
  return [...asks.slice(0, 10), ...bids.slice(0, 10)]
    .map(([price, size]) => `${checksumNumber(price)}${checksumNumber(size)}`)
    .join("");
}

export function crc32(value: string): number {
  let crc = 0xffffffff;
  for (let index = 0; index < value.length; index += 1) {
    crc ^= value.charCodeAt(index);
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function preserveKrakenBookDecimals(text: string): string {
  // Kraken CRC32 requires exact wire precision. Native JSON.parse can drop
  // trailing zeroes when price and qty literals are decoded as numbers.
  return text.replace(/("(?:price|qty)"\s*:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, '$1"$2"');
}

function checksumNumber(value: string): string {
  return value.replace(".", "").replace(/^0+/, "");
}
