"""Render the asserted MCP transcript as a GIF. Optional dependency: Pillow.

Run the demo first, then: python scripts/render-demo.py
This renders text output; it does not simulate a client or model conversation.
"""

import json
from pathlib import Path
import textwrap

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "docs" / "assets"
transcript = json.loads((ASSETS / "demo-transcript.json").read_text(encoding="utf-8"))


def font(size, bold=False):
    candidates = [
        Path("C:/Windows/Fonts") / ("consolab.ttf" if bold else "consola.ttf"),
        Path("/usr/share/fonts/truetype/dejavu") / ("DejaVuSansMono-Bold.ttf" if bold else "DejaVuSansMono.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default(size=size)


frames = []
for index, step in enumerate(transcript["steps"]):
    canvas = Image.new("RGB", (1280, 720), "#080f1d")
    draw = ImageDraw.Draw(canvas)
    draw.text((64, 42), "CLOONEX", font=font(29, True), fill="#8edcc5")
    draw.text((230, 47), "LOCAL MEMORY FOR AI CODING TOOLS / MCP", font=font(20), fill="#aab6cc")
    draw.text((64, 117), step["title"], font=font(42, True), fill="#f2f5fb")
    draw.text((64, 180), "Real MCP output replay / fictional order-export fixture", font=font(21), fill="#aab6cc")
    draw.rounded_rectangle((64, 243, 1216, 599), radius=20, fill="#111c30", outline="#2b3b55", width=2)
    draw.text((93, 266), "$ npm run demo", font=font(22), fill="#aab6cc")
    y = 317
    for line in step["lines"]:
        for wrapped in textwrap.wrap(line, width=76, break_long_words=False, break_on_hyphens=False):
            draw.text((93, y), wrapped, font=font(24), fill="#8edcc5" if line.startswith(">") else "#e0e7f2")
            y += 38
    if y > 580:
        raise ValueError(f"Frame {index + 1} overflows; shorten transcript labels or increase height.")
    draw.text((64, 641), f"{index + 1:02d} / {len(transcript['steps']):02d}", font=font(23, True), fill="#8edcc5")
    draw.text((246, 645), "No API key. Isolated demo data. Run it from the source checkout.", font=font(18), fill="#aab6cc")
    for marker in range(len(transcript["steps"])):
        left = 64 + marker * 233
        draw.rounded_rectangle((left, 690, left + 219, 695), radius=2,
                               fill="#8edcc5" if marker == index else "#29364c")
    frames.append(canvas)

frames[0].save(ASSETS / "demo.gif", save_all=True, append_images=frames[1:],
               duration=[5000] * len(frames), loop=0, optimize=True, disposal=2)
frames[0].save(ASSETS / "demo.png", optimize=True)

# An ignored review image lets maintainers inspect all frames without playing GIFs.
review = ROOT / "work" / "demo-review.png"
review.parent.mkdir(parents=True, exist_ok=True)
sheet = Image.new("RGB", (1280, 360 * len(frames)), "#080f1d")
for index, frame in enumerate(frames):
    sheet.paste(frame.resize((640, 360)), (0, 360 * index))
    sheet.paste(frame.crop((64, 243, 1216, 599)).resize((640, 198)), (640, 360 * index + 70))
sheet.save(review)
print(f"Rendered {len(frames)} frames / 25 seconds: {ASSETS / 'demo.gif'}")
