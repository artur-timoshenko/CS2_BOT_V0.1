"""Shrinks textures in place to at most --max pixels per side (CS2 HD weapon maps are 4096²: ~64 MB of video memory
each, three per weapon). Run after tools/build-weapons.js:

    py tools/shrink-textures.py D:/.../Maps/weapons [--max 2048]
"""
import argparse
import os

from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('dir')
ap.add_argument('--max', type=int, default=2048)
a = ap.parse_args()
done = 0
for root, _, files in os.walk(a.dir):
    for f in files:
        if not f.lower().endswith('.png'):
            continue
        p = os.path.join(root, f)
        with Image.open(p) as im:
            if max(im.size) <= a.max:
                continue
            k = a.max / max(im.size)
            small = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
        small.save(p + '.part.png', optimize=True)
        os.replace(p + '.part.png', p)  # never leaves a half-written texture behind
        done += 1
print(f'{done} textures shrunk to <= {a.max}px')
