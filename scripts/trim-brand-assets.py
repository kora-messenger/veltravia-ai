#!/usr/bin/env python3
"""Derive the shipped brand files from the supplied originals.

The artwork arrives with a lot of transparent padding: the supplied logo keeps
its mark inside 64% x 51% of a 1024 square, so a 28px mark drawn from the raw
file renders as a 17 x 14px shape floating in the corner of its box. This
script crops to the ink at a fixed alpha threshold, re-centres the result on a
square transparent canvas with 7% breathing room, and writes every derived size
from that trim.

Rules the script keeps:
  * the original files are only ever read, never rewritten;
  * nothing is recoloured, sharpened, cropped for composition or stretched
    (one uniform scale per derivative, aspect preserved);
  * the alpha channel stays: no flattened white background;
  * measured results are written to brand-assets.json so the asset test can
    assert a real fill ratio instead of trusting a filename.

Run: python3 scripts/trim-brand-assets.py   (needs Pillow)
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image

BRAND = Path(__file__).resolve().parent.parent / "apps" / "web" / "public" / "brand"

INK_ALPHA = 128  # below this the pixel is padding or antialiasing feather
PADDING = 0.07  # share of the final canvas kept clear around the ink
MASTER = 1024

LOGO_SIZES = [32, 48, 96, 180, 192, 512]
NOTIFICATION_SIZES = [48, 96, 256]
ICON_SIZES = [16, 24, 32, 48, 64, 128, 256]


def ink_box(image: Image.Image) -> tuple[int, int, int, int]:
    """Bounding box of pixels at or above the ink threshold."""
    alpha = image.convert("RGBA").split()[3].point(lambda value: 255 if value >= INK_ALPHA else 0)
    box = alpha.getbbox()
    if box is None:
        raise SystemExit("asset has no ink above the alpha threshold")
    return box


def fill_ratio(image: Image.Image) -> float:
    """Share of the canvas width and height the ink covers, after the crop."""
    left, top, right, bottom = ink_box(image)
    width, height = image.size
    return round(max((right - left) / width, (bottom - top) / height), 3)


def square_trim(source: Image.Image, size: int) -> Image.Image:
    """Crop to the ink, then centre it on a square transparent canvas."""
    image = source.convert("RGBA")
    cropped = image.crop(ink_box(image))

    inset = int(round(max(cropped.size) * PADDING))
    side = max(cropped.size) + inset * 2
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    # Pasted at its own pixels, centred: no axis is scaled differently.
    canvas.paste(cropped, ((side - cropped.width) // 2, (side - cropped.height) // 2), cropped)
    return canvas.resize((size, size), Image.LANCZOS)


def write(image: Image.Image, name: str, written: dict[str, dict[str, object]]) -> None:
    target = BRAND / name
    image.save(target, "PNG", optimize=True)
    written[name] = {
        "width": image.width,
        "height": image.height,
        "inkFill": fill_ratio(image),
        "bytes": target.stat().st_size,
    }


def main() -> None:
    logo = Image.open(BRAND / "veltravia-logo.png")
    mark = Image.open(BRAND / "veltravia-mark.png")

    for name, image in (("veltravia-logo.png", logo), ("veltravia-mark.png", mark)):
        left, top, right, bottom = ink_box(image)
        print(
            f"source {name}: {image.width}x{image.height}, ink "
            f"{right - left}x{bottom - top} "
            f"({100 * (right - left) / image.width:.0f}% x "
            f"{100 * (bottom - top) / image.height:.0f}% of canvas)"
        )

    written: dict[str, dict[str, object]] = {}

    logo_master = square_trim(logo, MASTER)
    write(logo_master, "veltravia-logo-trim.png", written)
    for size in LOGO_SIZES:
        write(square_trim(logo, size), f"veltravia-logo-{size}.png", written)

    notification_master = square_trim(mark, 512)
    write(notification_master, "veltravia-notification-trim.png", written)
    for size in NOTIFICATION_SIZES:
        write(square_trim(mark, size), f"veltravia-notification-{size}.png", written)

    # A multi-resolution .ico so the tab icon is crisp on every density.
    logo_master.save(
        BRAND / "favicon.ico",
        format="ICO",
        sizes=[(size, size) for size in ICON_SIZES],
    )
    written["favicon.ico"] = {
        "sizes": ICON_SIZES,
        "bytes": (BRAND / "favicon.ico").stat().st_size,
    }

    manifest = {
        "generatedBy": "scripts/trim-brand-assets.py",
        "inkAlpha": INK_ALPHA,
        "padding": PADDING,
        "originals": [
            {"file": "veltravia-logo.png", "width": 1024, "height": 1024},
            {"file": "veltravia-mark.png", "width": 1024, "height": 341},
        ],
        "files": written,
    }
    (BRAND / "brand-assets.json").write_text(json.dumps(manifest, indent=2) + "\n")

    for name, info in written.items():
        if "inkFill" in info:
            print(f"  {name}: {info['width']}x{info['height']} ink fill {info['inkFill']}")


if __name__ == "__main__":
    main()
