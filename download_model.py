"""
One-time setup step: downloads the InsightFace buffalo_l model pack into
./models (not committed to git -- see .gitignore). Run this once after
installing dependencies, before starting the app.

Docker builds run this automatically (see Dockerfile) so there's no
first-run delay when the container starts.
"""
from face_recognizer import BUFFALO_DIR, get_face_app

# The buffalo_l pack ships 5 models; face_recognizer.py only ever loads
# "detection" and "recognition" (allowed_modules), so the other 3 are dead
# weight (~143MB) -- the download itself always fetches all 5 regardless of
# that restriction, so we prune them afterward rather than re-downloading a
# custom subset.
UNUSED_MODEL_FILES = ["1k3d68.onnx", "2d106det.onnx", "genderage.onnx"]

if __name__ == "__main__":
    print("Downloading InsightFace buffalo_l model pack into ./models ...")
    get_face_app()

    for name in UNUSED_MODEL_FILES:
        f = BUFFALO_DIR / name
        if f.exists():
            f.unlink()
            print(f"Removed unused model file: {name}")

    # InsightFace leaves the downloaded zip alongside the extracted files.
    leftover_zip = BUFFALO_DIR.parent / "buffalo_l.zip"
    if leftover_zip.exists():
        leftover_zip.unlink()
        print("Removed leftover buffalo_l.zip")

    print("Done.")
