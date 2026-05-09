// Regenerate the EdgeClaw "EC" letter-mark assets used as the favicon,
// in-app logo, and PWA icons. Output covers both .svg vectors and .png
// rasters (rendered with sharp). Run from the project root:
//
//   node ui/public/generate-icons.js
//
// or from ui/:
//
//   node public/generate-icons.js
//
// Update the mark in `ecMarkSvg()` below — every output file pulls from
// that one function so the mark stays consistent across all sizes.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PUBLIC = __dirname;

function ecMarkSvg({ size = 512 } = {}) {
  const r = Math.round(size * 0.18);
  const fontSize = Math.round(size * 0.46);
  const baselineY = Math.round(size * 0.62);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" rx="${r}" fill="#0A0A0A"/>
  <text x="${size / 2}" y="${baselineY}" text-anchor="middle"
        font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        font-weight="800" font-size="${fontSize}" letter-spacing="${(-fontSize * 0.05).toFixed(2)}"
        fill="#FAFAFA">EC</text>
</svg>`;
}

const PWA_SIZES = [72, 96, 128, 144, 152, 192, 384, 512];
const LOGO_PNG_SIZES = [32, 64, 128, 256, 512];

async function writePng(outPath, svg, size) {
  const buf = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
  fs.writeFileSync(outPath, buf);
}

(async () => {
  const tasks = [];
  tasks.push(['favicon.svg', ecMarkSvg({ size: 64 }), null]);
  tasks.push(['logo.svg', ecMarkSvg({ size: 512 }), null]);
  tasks.push(['favicon.png', ecMarkSvg({ size: 64 }), 64]);
  for (const s of LOGO_PNG_SIZES) {
    tasks.push([`logo-${s}.png`, ecMarkSvg({ size: s }), s]);
  }
  for (const s of PWA_SIZES) {
    tasks.push([`icons/icon-${s}x${s}.svg`, ecMarkSvg({ size: s }), null]);
    tasks.push([`icons/icon-${s}x${s}.png`, ecMarkSvg({ size: s }), s]);
  }

  for (const [rel, svg, pngSize] of tasks) {
    const out = path.join(PUBLIC, rel);
    if (pngSize === null) {
      fs.writeFileSync(out, svg, 'utf8');
    } else {
      await writePng(out, svg, pngSize);
    }
    console.log('wrote', rel);
  }
  console.log(`Done — ${tasks.length} files written.`);
})();
