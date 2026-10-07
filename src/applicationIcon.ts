/** Icons are static, self-contained SVG resources, never executable documents. */
export function validateApplicationIcon(svg: string) {
  const text = svg.trim();
  if (new TextEncoder().encode(text).length > 65536 || !/^<svg\b/i.test(text) || !/<\/svg>$/i.test(text)) throw new Error("assets/icon.svg 必须是小于 64 KB 的 SVG");
  if (/<(?:script|foreignObject|image|style|animate\w*|set|iframe)\b|<!|&#|\b(?:[\w-]+:)?href\s*=|\bon\w+\s*=|@import/i.test(text)) throw new Error("应用图标只能包含静态 SVG，不可嵌入脚本、图片或外部资源");
  for (const value of text.matchAll(/url\s*\(([^)]*)\)/gi)) if (!/^\s*['"]?#[\w.-]+['"]?\s*$/.test(value[1])) throw new Error("应用图标只能引用自身的渐变与裁切路径");
  const viewBox = text.match(/^<svg\b[^>]*\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1]?.trim().split(/[\s,]+/).map(Number);
  if (!viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[2] !== viewBox[3]) throw new Error("应用图标需要正方形 viewBox，例如 0 0 128 128");
}

export function validIconJpeg(bytes: Uint8Array) {
  if (bytes.length > 256 * 1024 || bytes[0] !== 255 || bytes[1] !== 216) return false;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 255) return false;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) return false;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return false;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) return false;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4], width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return width === 512 && height === 512;
    }
    offset += length;
  }
  return false;
}
