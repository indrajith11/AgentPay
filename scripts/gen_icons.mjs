// Generate AgentPay PWA icons (emerald "A" tile) from SVG via sharp.
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const outDir = "/home/z/my-project/public/icons";
fs.mkdirSync(outDir, { recursive: true });

function svg(size) {
  const pad = Math.round(size * 0.1);
  const r = Math.round(size * 0.22);
  const a = Math.round(size * 0.52);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" rx="${r}" fill="#065f46"/>
  <rect x="${pad / 2}" y="${pad / 2}" width="${size - pad}" height="${size - pad}" rx="${r - pad / 4}" fill="none" stroke="#34d399" stroke-opacity="0.35" stroke-width="${Math.max(2, size * 0.012)}"/>
  <text x="50%" y="50%" dominant-baseline="central" text-anchor="middle"
    font-family="DejaVu Sans, Arial, sans-serif" font-weight="800" font-size="${a}" fill="#ffffff">A</text>
  <circle cx="${size * 0.78}" cy="${size * 0.24}" r="${size * 0.055}" fill="#34d399"/>
</svg>`;
}

for (const size of [192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  await sharp(Buffer.from(svg(size))).png().toFile(file);
  console.log("wrote", file);
}
