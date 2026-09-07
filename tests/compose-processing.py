# /// script
# requires-python = ">=3.11"
# dependencies = ["pymupdf==1.28.2", "pillow==12.3.0"]
# ///
"""Synthetic processing regressions; no donor corpus or provider service."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import pymupdf
from PIL import Image

SCRIPT = Path(__file__).resolve().parents[1] / "skill/scripts/compose-extract.py"
spec = importlib.util.spec_from_file_location("compose_extract", SCRIPT)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class Processing(unittest.TestCase):
    def test_accent_abstention_and_supported_color(self):
        grey = worker.palette([(1, Image.new("RGB", (40, 40), "#dddddd"))])
        self.assertTrue(grey["accentSeed"]["abstained"])
        red = worker.palette([(2, Image.new("RGB", (40, 40), "#b03040"))])
        self.assertFalse(red["accentSeed"]["abstained"])
        self.assertEqual(red["accentSeed"]["page"], 2)
        self.assertEqual(red["accentSeed"]["hex"], "#b03040")

    def test_pdf_geometry_blank_pages_and_ocr_honesty(self):
        with tempfile.TemporaryDirectory(prefix="impose-processing-") as directory:
            source = Path(directory) / "synthetic.pdf"
            with pymupdf.open() as pdf:
                first = pdf.new_page(width=300, height=500)
                first.insert_text((30, 60), "Reading plates and section numbers")
                second = pdf.new_page(width=2133, height=3012)
                second.set_rotation(90)
                third = pdf.new_page(width=300, height=500)
                third.insert_text((30, 60), "Rotated text")
                third.set_rotation(90)
                pdf.save(source)
            before = source.read_bytes()
            result = worker.extract({"source": {"kind": "pdf", "path": str(source)}, "outputDir": str(Path(directory) / "renders")})
            self.assertEqual(len(result["pages"]), 3)
            for page in result["pages"]:
                geometry = page["geometry"]
                self.assertLessEqual(geometry["widthPx"] * geometry["heightPx"], worker.PIXEL_CAP)
                self.assertTrue(Path(page["render"]).is_file())
            self.assertEqual(result["pages"][1]["geometry"]["rotation"], 90)
            self.assertEqual(result["pages"][1]["text"], "")
            box = result["pages"][2]["spans"][0]["bbox"]
            self.assertGreater(box[0], .8)
            self.assertAlmostEqual(box[1], .1, places=2)
            self.assertEqual(result["triage"]["ocrCorrectness"], "unassessed")
            self.assertFalse(result["triage"]["routeApplied"])
            self.assertEqual(source.read_bytes(), before)

    def test_structured_page_and_span_identity_is_validated(self):
        with tempfile.TemporaryDirectory(prefix="impose-structured-") as directory:
            path = Path(directory) / "source.json"
            for pages in [
                [{"page": 1}, {"page": 1}],
                [{"page": -1}],
                [{"page": 1, "spans": [{"id": "span", "text": "text", "bbox": [1, 0, 0, 1]}]}],
            ]:
                path.write_text(json.dumps({"pages": pages}))
                with self.assertRaises(ValueError):
                    worker.extract({"source": {"kind": "structured", "path": str(path)}})

    def test_triage_does_not_confuse_uncertainty_with_mixed_or_correct_ocr(self):
        result = worker.triage([{"text": ""}])
        self.assertEqual(result["routeOpinion"], "undetermined")
        self.assertEqual(result["ocrCorrectness"], "unassessed")
        self.assertEqual(result["textAvailability"], "image-only")


if __name__ == "__main__":
    unittest.main()
