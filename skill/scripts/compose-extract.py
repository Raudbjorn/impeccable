# /// script
# requires-python = ">=3.11"
# dependencies = ["pymupdf==1.28.2", "pillow==12.3.0"]
# ///
"""Optional source extraction. JSON in/out; original sources are never rewritten."""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

VERSION = "compose-extract/1"
PIXEL_CAP = 4_000_000


def palette(images):
    from PIL import Image

    colors = Counter()
    sums = {}
    sampled = 0
    for page, image in images:
        sample = image.convert("RGB")
        sample.thumbnail((160, 160), Image.Resampling.LANCZOS)
        for rgb in sample.get_flattened_data():
            sampled += 1
            chroma = max(rgb) - min(rgb)
            mean = sum(rgb) / 3
            if chroma < 12 and (mean < 24 or mean > 232):
                continue
            key = (page, tuple(v // 16 for v in rgb))
            colors[key] += 1
            total = sums.setdefault(key, [0, 0, 0, 0])
            for i, value in enumerate(rgb):
                total[i] += value
            total[3] += chroma >= 12
    # ponytail: bounded RGB histogram, not perceptual clustering; replace only after a paired palette evaluation.
    seeds = []
    for (page, bucket), count in colors.most_common(32):
        total = sums[(page, bucket)]
        rgb = tuple(round(value / count) for value in total[:3])
        chroma = max(rgb) - min(rgb)
        seeds.append({"hex": "#%02x%02x%02x" % rgb, "page": page,
                      "pixels": count, "chroma": chroma, "mean": sum(rgb) / 3,
                      "chromaSupport": total[3] / count})
    seeds.sort(key=lambda s: (-s["chroma"] / max(1, s["mean"]), -s["pixels"], s["hex"]))
    eligible = [s for s in seeds if s["chroma"] >= 12 and s["chromaSupport"] >= .02
                and 24 <= s["mean"] <= 232]
    accent = ({"abstained": False, **eligible[0]} if eligible else
              {"abstained": True, "reason": "No supported chromatic accent in sampled source pixels"})
    return {"seeds": seeds[:5], "accentSeed": accent, "sampledPixels": sampled,
            "retainedPixels": sum(colors.values()), "discardedPixels": sampled - sum(colors.values()),
            "preprocessing": "thumbnail-160/rgb-histogram-16/v1",
            "accentOrigin": "source observation" if eligible else "unassigned; any fallback is a product choice"}


def triage(pages):
    text = "\n".join(p["text"] for p in pages)
    available = sum(len(p["text"]) >= 200 for p in pages) / max(1, len(pages))
    identity = sum(len(re.findall(r"\b" + term + r"\b", text.lower())) for term in
                   ["clear space", "wordmark", "minimum size", "reproduction", "visual identity"])
    guidance = sum(len(re.findall(r"\b" + term + r"\b", text.lower())) for term in
                   ["principle", "exercise", "technique", "case study", "bibliography"])
    words = re.findall(r"\w+", text)
    common = Counter(words)
    suspicion = []
    if len(text) >= 200 and text.count("\ufffd") / len(text) > .02:
        suspicion.append("replacement-characters")
    if len(words) >= 30 and common.most_common(1)[0][1] / len(words) > .30:
        suspicion.append("repeated-text")
    terms = Counter(re.findall(r"\b[A-Z][a-z]+(?: [A-Z][a-z]+){0,3}\b", text))
    return {"textAvailability": "text-available" if available >= .60 else "text-sparse" if available >= .25 else "image-only",
            "ocrCorrectness": "unassessed", "suspicion": suspicion,
            "routeOpinion": "identity" if identity > guidance else "guidance" if guidance > identity else "undetermined",
            "routeApplied": False, "routeCounts": {"identity": identity, "guidance": guidance},
            "glossary": [{"term": term, "count": count, "qualification": "candidate"} for term, count in terms.most_common(30)],
            "lineage": {"qualification": "unassessed", "reason": "Tradition requires attributed source interpretation, not keyword certainty"}}


class TextHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.hidden += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.hidden = max(0, self.hidden - 1)

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def retain_render(request, png):
    if not request.get("outputDir"):
        return {}
    directory = Path(request["outputDir"])
    directory.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(png).hexdigest()
    path = directory / f"{digest}.png"
    if path.exists():
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError("Corrupt retained source render")
    else:
        with tempfile.NamedTemporaryFile(dir=directory, delete=False) as file:
            temporary = file.name
            file.write(png)
        os.replace(temporary, path)
    return {"render": str(path), "renderHash": digest}


def extract(request):
    from PIL import Image
    import pymupdf

    source = request["source"]
    kind = source["kind"]
    pages, images = [], []
    source_hash = source.get("contentHash")
    if kind == "structured":
        with Path(source["path"]).open("rb") as file:
            raw = file.read(16 * 1024 * 1024 + 1)
        if len(raw) > 16 * 1024 * 1024:
            raise ValueError("Structured source exceeds 16 MiB")
        data = json.loads(raw)
        if not isinstance(data, dict) or not isinstance(data.get("pages"), list) or len(data["pages"]) > 1000:
            raise ValueError("Structured source needs at most 1000 pages")
        seen = set()
        for n, page in enumerate(data["pages"], 1):
            if not isinstance(page, dict) or not isinstance(page.get("text", ""), str):
                raise ValueError("Structured pages need string text")
            number = page.get("page", n)
            if type(number) is not int or number <= 0 or number in seen:
                raise ValueError("Structured page numbers must be positive and unique")
            seen.add(number)
            spans = page.get("spans", [])
            if not isinstance(spans, list):
                raise ValueError("Structured spans must be an array")
            span_ids = set()
            for span in spans:
                if not isinstance(span, dict) or not isinstance(span.get("id"), str) or not span["id"] or span["id"] in span_ids or not isinstance(span.get("text"), str):
                    raise ValueError("Structured spans need unique IDs and string text")
                span_ids.add(span["id"])
                bbox = span.get("bbox")
                if bbox is not None and (not isinstance(bbox, list) or len(bbox) != 4 or
                        any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1 for v in bbox) or
                        bbox[0] > bbox[2] or bbox[1] > bbox[3]):
                    raise ValueError("Structured span bbox must be ordered normalized coordinates")
            pages.append({"page": number, "text": page.get("text", ""),
                          "spans": page.get("spans", []), "geometry": page.get("geometry"),
                          "observation": "supplied-structured-input"})
    elif kind == "url":
        # Network access belongs to the Rust transport, which validates and pins every hop.
        source_hash = request["capturedHash"]
        parser = TextHTML()
        parser.feed(request["capturedHtml"])
        pages.append({"page": 1, "text": "\n".join(parser.parts), "spans": [],
                      "geometry": None, "observation": "source-html; no computed styles or interaction claims"})
    elif kind == "images":
        for path in sorted(Path(source["path"]).iterdir()):
            if path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
                continue
            with Image.open(path) as original:
                image = original.convert("RGB")
                image.thumbnail((2000, 2000))
            png = io.BytesIO()
            image.save(png, format="PNG")
            rendered = retain_render(request, png.getvalue())
            geometry = list(image.size)
            page = len(pages) + 1
            if page > 1000:
                raise ValueError("Image source exceeds 1000 pages")
            image.thumbnail((160, 160))
            images.append((page, image))
            pages.append({"page": page, "text": "", "spans": [], "geometry": geometry, **rendered,
                          "file": str(path), "fileHash": hashlib.sha256(path.read_bytes()).hexdigest(),
                          "observation": "raster"})
    elif kind == "pdf":
        with pymupdf.open(source["path"]) as pdf:
            for index, page in enumerate(pdf):
                if index >= 1000:
                    raise ValueError("PDF exceeds 1000 pages; supply an explicit smaller source")
                width, height = page.rect.width, page.rect.height
                scale = min(2.0, math.sqrt(PIXEL_CAP / (width * height)))
                while math.ceil(width * scale) * math.ceil(height * scale) > PIXEL_CAP:
                    scale *= .999
                raster = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
                assert raster.width * raster.height <= PIXEL_CAP
                png = raster.tobytes("png")
                rendered = retain_render(request, png)
                image = Image.open(io.BytesIO(png)).convert("RGB")
                image.thumbnail((160, 160))
                images.append((index + 1, image))
                spans = []
                for n, block in enumerate(page.get_text("blocks")):
                    if len(block) <= 4 or not isinstance(block[4], str):
                        continue
                    box = pymupdf.Rect(block[:4]) * page.rotation_matrix
                    spans.append({"id": f"p{index+1}-b{n}", "text": block[4],
                                  "bbox": [box.x0/width, box.y0/height, box.x1/width, box.y1/height],
                                  "observation": "native-pdf-text"})
                text = page.get_text()
                ocr_state = "not-requested"
                if request.get("ocr") and len(text.strip()) < 200:
                    with tempfile.TemporaryDirectory(prefix="impose-ocr-") as folder:
                        png = Path(folder) / "page.png"
                        raster.save(png)
                        try:
                            result = subprocess.run(["tesseract", str(png), "stdout"], capture_output=True, text=True, timeout=30, check=False)
                            if result.returncode:
                                raise RuntimeError(f"OCR nonzero-exit {result.returncode}: {result.stderr[:1000]}")
                            text = result.stdout
                            ocr_state = "text-returned" if text.strip() else "blank"
                            spans.append({"id": f"p{index+1}-ocr", "text": text, "bbox": None, "observation": "ocr-unverified"})
                        except FileNotFoundError as error:
                            raise RuntimeError("OCR missing-executable: tesseract") from error
                        except subprocess.TimeoutExpired as error:
                            raise RuntimeError("OCR timeout") from error
                pages.append({"page": index + 1, "text": text, "spans": spans, **rendered,
                              "geometry": {"widthPt": width, "heightPt": height, "rotation": page.rotation,
                                           "widthPx": raster.width, "heightPx": raster.height},
                              "figures": len(page.get_images()), "ocr": ocr_state,
                              "observation": "pdf-extraction", "state": "ok" if text.strip() else "blank-or-image-only"})
    else:
        raise ValueError("Unsupported source kind")
    if not pages:
        raise ValueError("Source contains no supported pages")
    return {"schemaVersion": 1, "extractor": VERSION, "dependencies": {"pymupdf": pymupdf.VersionBind, "pillow": Image.__version__},
            "sourceHash": source_hash, "pages": pages, "triage": triage(pages), "palette": palette(images)}


if __name__ == "__main__":
    try:
        if "--check" in sys.argv:
            import pymupdf
            from PIL import Image
            print(json.dumps({"pymupdf": pymupdf.VersionBind, "pillow": Image.__version__}))
        else:
            print(json.dumps(extract(json.load(sys.stdin)), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(1)
