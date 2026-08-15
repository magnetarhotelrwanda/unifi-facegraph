"""
Local face recognition using InsightFace (buffalo_l / ArcFace), running
entirely on-device -- no UniFi face data or embeddings are used here, only
the raw cropped face images fetched from the controller.

Model files live in ./models, downloaded once via download_model.py (not
committed to git -- the recognition model alone is 166MB, over GitHub's
100MB per-file limit). Direct installs run that script once as a setup
step; Docker builds run it automatically (see Dockerfile).
"""
from pathlib import Path

import cv2
import numpy as np

MODELS_DIR = Path(__file__).parent / "models"
# Where InsightFace actually extracts the buffalo_l pack under MODELS_DIR.
BUFFALO_DIR = MODELS_DIR / "models" / "buffalo_l"

_face_app = None


def get_face_app():
    global _face_app
    if _face_app is None:
        from insightface.app import FaceAnalysis

        _face_app = FaceAnalysis(
            name="buffalo_l",
            root=str(MODELS_DIR),
            providers=["CPUExecutionProvider"],
            allowed_modules=["detection", "recognition"],
        )
        _face_app.prepare(ctx_id=-1, det_size=(640, 640))
    return _face_app


def embed_image_bytes(image_bytes):
    """
    Decodes a JPEG, runs local face detection + ArcFace embedding, and
    returns a single L2-normalized 512-d vector for the largest face found
    (None if no face is detected).

    UniFi's thumbnail crops are tight around the face, which can trip up
    InsightFace's own detector (it expects some surrounding context) -- we
    pad the image before detection to improve hit rate.
    """
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return None

    pad_y = int(img.shape[0] * 0.4)
    pad_x = int(img.shape[1] * 0.4)
    padded = cv2.copyMakeBorder(img, pad_y, pad_y, pad_x, pad_x, cv2.BORDER_REPLICATE)

    faces = get_face_app().get(padded)
    if not faces:
        return None

    faces.sort(key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]), reverse=True)
    return faces[0].normed_embedding


def cosine_similarity(a, b):
    return float(np.dot(a, b))
