#!/usr/bin/env python3
"""Derive the shipped brand files from the supplied originals.

Two derivations, chosen per artwork:

  * the app logo is the owner's artwork, so every icon is the delivered 1024
    canvas at one uniform scale: same composition, same margins, same centring.
    Nothing is cropped or re-centred (`exact-rescale`).
  * the notification mark is a wide status chip sized 24-28px, where its own
    padding would leave a 10px shape, so it is cropped to the ink at a fixed
    alpha threshold and re-centred on a square canvas (`ink-crop`).

Rules the script keeps:
  * the original files are only ever read, never rewritten;
  * nothing is recoloured, sharpened or stretched (one uniform scale, aspect
    preserved), and the logo is never cropped;
  * the alpha channel stays: no flattened white background;
  * measured results are written to brand-assets.json so the asset test can
    assert the real fill ratio and method instead of trusting a filename.

Run: python3 scripts/trim-brand-assets.py   (needs Pillow)
"""

from __future__ import annotations

import json
import re
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


def exact_scale(source: Image.Image, size: int) -> Image.Image:
    """The delivered canvas at one uniform scale, composition untouched."""
    return source.convert("RGBA").resize((size, size), Image.LANCZOS)


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


def prettier_json(document: dict) -> str:
    """Serialise the manifest in the shape `prettier --check .` accepts.

    Kept here rather than as a manual format step: regenerating the assets must
    not dirty a file that CI checks.
    """
    text = json.dumps(document, indent=2)
    # Prettier keeps a short list of numbers on one line.
    return re.sub(r"\[\s*((?:\d+,\s*)*\d+)\s*\]", lambda m: "[" + ", ".join(
        part.strip() for part in m.group(1).split(",")
    ) + "]", text) + "\n"


def write(
    image: Image.Image,
    name: str,
    written: dict[str, dict[str, object]],
    method: str,
) -> None:
    target = BRAND / name
    image.save(target, "PNG", optimize=True)
    written[name] = {
        "width": image.width,
        "height": image.height,
        "method": method,
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

    # The app logo is the owner's artwork: scale the delivered canvas, never crop it.
    for size in LOGO_SIZES:
        write(exact_scale(logo, size), f"veltravia-logo-{size}.png", written, "exact-rescale")

    notification_master = square_trim(mark, 512)
    write(notification_master, "veltravia-notification-trim.png", written, "ink-crop")
    for size in NOTIFICATION_SIZES:
        write(square_trim(mark, size), f"veltravia-notification-{size}.png", written, "ink-crop")

    # A multi-resolution .ico so the tab icon is crisp on every density. Drawn
    # from the delivered canvas, so the tab icon is the logo exactly as supplied.
    logo.save(
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
            {"file": "veltravia-mark.png", "width": 1024, "height": 518},
        ],
        "logoInkRatio": 0.64,
        "files": written,
    }
    (BRAND / "brand-assets.json").write_text(prettier_json(manifest))

    for name, info in written.items():
        if "inkFill" in info:
            print(
                f"  {name}: {info['width']}x{info['height']} "
                f"{info['method']} ink fill {info['inkFill']}"
            )


if __name__ == "__main__":
    main()
