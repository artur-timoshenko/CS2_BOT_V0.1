"""Light copy of an imported map's glTF: textures larger than --max pixels are written downscaled to lite/ next to it and a
<map>.lite.gltf points at them (the .bin and smaller textures are shared, nothing original is changed). de_dust2's export
has 167 textures at 2048² + 199 at 1024² — ~5 GB of video memory with mipmaps, minutes of decoding and the risk of a lost
WebGL context; at 1024 it is a quarter of that. The viewer loads the lite copy when it exists (?hq = the originals).

    py tools/shrink-map-textures.py D:/.../Maps/Dust_2_v21/maps/de_dust2.gltf [--max 1024]
"""
import argparse
import json
import os
from urllib.parse import unquote, quote

from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('gltf')
ap.add_argument('--max', type=int, default=1024)
a = ap.parse_args()
src_dir = os.path.dirname(os.path.abspath(a.gltf))
with open(a.gltf, encoding='utf-8') as f:
    g = json.load(f)
os.makedirs(os.path.join(src_dir, 'lite'), exist_ok=True)
shrunk = kept = 0
for im in g.get('images', []):
    uri = im.get('uri')
    if not uri or uri.startswith('data:'):
        continue
    path = os.path.join(src_dir, unquote(uri))
    try:
        with Image.open(path) as img:
            if max(img.size) <= a.max:
                kept += 1
                continue
            k = a.max / max(img.size)
            if img.mode not in ('L', 'LA', 'RGB', 'RGBA'):
                img = img.convert('RGBA')
            small = img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.LANCZOS)
    except Exception as e:  # unreadable / exotic format: keep the original
        print('kept', uri, e)
        kept += 1
        continue
    out = os.path.join(src_dir, 'lite', os.path.basename(unquote(uri)))
    if not os.path.exists(out):
        small.save(out + '.part.png')
        os.replace(out + '.part.png', out)
    im['uri'] = 'lite/' + quote(os.path.basename(unquote(uri)))
    shrunk += 1
dst = os.path.splitext(a.gltf)[0] + '.lite.gltf'
with open(dst, 'w', encoding='utf-8') as f:
    json.dump(g, f)
print(f'{dst}: {shrunk} textures shrunk to <= {a.max}px, {kept} kept')
