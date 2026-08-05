#!/usr/bin/env python3
"""Mock object detector (YOLO-shaped JSON on stdout).

Replace this script with a real ultralytics / OpenCV pipeline later.
Keep the same CLI + JSON contract so the agent tool wiring stays stable.

CLI:
  python scripts/detect.py --json-stdin   # stdin: {"imagePath": "...", "conf": 0.25}
  python scripts/detect.py --image PATH [--conf 0.25]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Mock YOLO-style detector")
    p.add_argument("--json-stdin", action="store_true")
    p.add_argument("--image", type=str, default="")
    p.add_argument("--conf", type=float, default=0.25)
    return p.parse_args()


def load_input(args: argparse.Namespace) -> tuple[str, float]:
    if args.json_stdin:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
        image = str(data.get("imagePath") or data.get("image") or "")
        conf = float(data.get("conf") if data.get("conf") is not None else 0.25)
        return image, conf
    return args.image, float(args.conf)


def mock_detections(image_path: str, conf: float) -> list[dict]:
    """Deterministic fake boxes so agents can reason without GPU/weights."""
    name = Path(image_path).name.lower() if image_path else ""
    # Heuristic demos: filename keywords steer the mock scene.
    if "empty" in name or "blank" in name:
        return []
    if "person" in name or "crowd" in name:
        return [
            {
                "label": "person",
                "confidence": max(conf, 0.81),
                "bbox_xyxy": [120, 80, 340, 520],
            },
            {
                "label": "person",
                "confidence": max(conf, 0.64),
                "bbox_xyxy": [360, 100, 520, 500],
            },
        ]
    if "car" in name or "traffic" in name:
        return [
            {
                "label": "car",
                "confidence": max(conf, 0.88),
                "bbox_xyxy": [40, 200, 280, 400],
            },
            {
                "label": "truck",
                "confidence": max(conf, 0.55),
                "bbox_xyxy": [300, 160, 620, 420],
            },
        ]
    # Default scene
    return [
        {
            "label": "object",
            "confidence": max(conf, 0.42),
            "bbox_xyxy": [10, 10, 100, 100],
        }
    ]


def main() -> int:
    args = parse_args()
    image_path, conf = load_input(args)
    exists = bool(image_path) and os.path.isfile(image_path)
    detections = mock_detections(image_path, conf)
    # Filter by conf threshold
    detections = [d for d in detections if float(d["confidence"]) >= conf]

    out = {
        "model": "mock-yolo-v0",
        "imagePath": image_path,
        "imageExists": exists,
        "confThreshold": conf,
        "detections": detections,
        "count": len(detections),
        "notes": (
            "Mock detector — replace scripts/detect.py + requirements.txt "
            "with ultralytics for real inference. Keep this JSON shape."
        ),
    }
    if image_path and not exists:
        out["warning"] = f"image not found: {image_path}"

    json.dump(out, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
