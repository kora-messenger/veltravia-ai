#!/usr/bin/env node
/**
 * Generates the Android launcher icons and splash screens from the official
 * Veltravia brand asset.
 *
 * The icon is built from `apps/web/public/brand/veltravia-logo-512.png` - the
 * same file the web application serves - so the phone and the browser never show
 * two different logos. No new artwork is invented here.
 *
 * Run: node scripts/generate-android-assets.mjs  (needs Python 3 + Pillow, which
 * the sandbox has; the generated PNGs are committed so CI does not need it.)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'apps/web/public/brand/veltravia-logo-512.png');
const res = join(root, 'apps/mobile/android/app/src/main/res');

if (!existsSync(source)) {
  console.error(`Missing brand asset: ${source}`);
  process.exit(1);
}

/** Launcher icon sizes, in px, per density. */
const ICON_SIZES = {
  mdpi: 48,
  hdpi: 72,
  xhdpi: 96,
  xxhdpi: 144,
  xxxhdpi: 192,
};

/** Adaptive-icon foreground grid (108dp) per density. */
const FOREGROUND_SIZES = {
  mdpi: 108,
  hdpi: 162,
  xhdpi: 216,
  xxhdpi: 324,
  xxxhdpi: 432,
};

/** Splash images, portrait and landscape, scaled per density. */
const SPLASH = {
  'drawable-port-mdpi': [320, 480],
  'drawable-port-hdpi': [480, 800],
  'drawable-port-xhdpi': [720, 1280],
  'drawable-port-xxhdpi': [960, 1600],
  'drawable-port-xxxhdpi': [1280, 1920],
  'drawable-land-mdpi': [480, 320],
  'drawable-land-hdpi': [800, 480],
  'drawable-land-xhdpi': [1280, 720],
  'drawable-land-xxhdpi': [1600, 960],
  'drawable-land-xxxhdpi': [1920, 1280],
};

const BACKGROUND = '#05060a';
const LOGO_FRACTION = 0.72;

const script = `
import json, sys
from PIL import Image, ImageDraw

source, res, background, fraction = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
icons = json.loads(sys.argv[5])
foregrounds = json.loads(sys.argv[6])
splashes = json.loads(sys.argv[7])

logo = Image.open(source).convert('RGBA')
trimmed = logo.crop(logo.getbbox())

def canvas(size, logo_px, rounded=False):
    image = Image.new('RGBA', (size, size), background)
    mark = trimmed.copy()
    mark.thumbnail((logo_px, logo_px), Image.LANCZOS)
    image.alpha_composite(mark, ((size - mark.width) // 2, (size - mark.height) // 2))
    if rounded:
        mask = Image.new('L', (size, size), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
        image.putalpha(mask)
    return image

for density, size in icons.items():
    target = f"{res}/mipmap-{density}"
    import os
    os.makedirs(target, exist_ok=True)
    canvas(size, int(size * 0.72)).save(f"{target}/ic_launcher.png")
    canvas(size, int(size * 0.66), rounded=True).save(f"{target}/ic_launcher_round.png")

for density, size in foregrounds.items():
    target = f"{res}/mipmap-{density}"
    import os
    os.makedirs(target, exist_ok=True)
    # The adaptive foreground is transparent: the system supplies the background
    # colour and the mask, and the safe zone keeps the mark whole.
    image = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    mark = trimmed.copy()
    mark.thumbnail((int(size * 0.55), int(size * 0.55)), Image.LANCZOS)
    image.alpha_composite(mark, ((size - mark.width) // 2, (size - mark.height) // 2))
    image.save(f"{target}/ic_launcher_foreground.png")

for folder, (width, height) in splashes.items():
    target = f"{res}/{folder}"
    import os
    os.makedirs(target, exist_ok=True)
    image = Image.new('RGBA', (width, height), background)
    mark = trimmed.copy()
    mark.thumbnail((int(min(width, height) * 0.42),) * 2, Image.LANCZOS)
    image.alpha_composite(mark, ((width - mark.width) // 2, (height - mark.height) // 2))
    image.save(f"{target}/splash.png", optimize=True)

print('generated')
`;

mkdirSync(res, { recursive: true });
execFileSync(
  'python3',
  [
    '-c',
    script,
    source,
    res,
    BACKGROUND,
    String(LOGO_FRACTION),
    JSON.stringify(ICON_SIZES),
    JSON.stringify(FOREGROUND_SIZES),
    JSON.stringify(SPLASH),
  ],
  { stdio: 'inherit' },
);
console.log('Android icons and splash screens generated from the brand asset.');
