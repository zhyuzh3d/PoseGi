#!/usr/bin/env python3
"""把归档的品牌图发布成应用图标。

`docs/assets/posegi-icon-source.png` 是设计原图:一个摆好动态姿势的木质关节人偶,
下面一行发光的蓝色 PoseGi 字标,底色是近黑。这张图有三个特点决定了本工具做什么。

* **原图不是正方形**（794×814）,而所有会显示应用图标的地方都是。
  这里的做法不是压扁,而是先按主体裁掉近黑的留白,再以很小的呼吸边补成正方形,
  最后整体缩放。人偶的位置和原设计完全一致,没有被重新构图。
* **它是写实渲染,不是扁平图形。** 兄弟仓库的图标是扁平标记,所以它们那边的
  `make-icon.py` 写无损 WebP；一张带明暗的 3D 渲染写无损要几百 KB,
  所以这里用 quality 92 的有损,肉眼看不出差别,体积小一个数量级。
* **字标在最下面三分之一。** 它要在官网页头 38 px 的位置上还认得出来,
  所以上方的留白刻意收紧。

输出 512×512,与该应用此前使用的图标尺寸一致。

用法:
  python3 tools/make-icon.py --out app/assets/icon.webp
  python3 tools/make-icon.py --out app/assets/icon.webp \\
      --copy ../hermitweb/public/assets/site/posegi.webp
"""

from __future__ import annotations

import argparse
import pathlib
import shutil

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "assets" / "posegi-icon-source.png"
SIDE = 512
MARGIN = 0.04
QUALITY = 92
FIELD = (11, 13, 15)  # 原图四角取样的底色,只有需要补边时才会用到
LUMINANCE_CUTOFF = 40  # 亮于此值的像素算主体,不算底色


def luminance(image: Image.Image) -> list[int]:
    """每像素的最大通道值,够用来把发光的浅色主体从近黑底色里分开。"""
    pixels = image.load()
    width, height = image.size
    return [max(pixels[x, y]) for y in range(height) for x in range(width)]


def subject_box(image: Image.Image) -> tuple[int, int, int, int]:
    width, height = image.size
    values = luminance(image)
    xs: list[int] = []
    ys: list[int] = []
    for index, value in enumerate(values):
        if value > LUMINANCE_CUTOFF:
            xs.append(index % width)
            ys.append(index // width)
    if not xs:
        return (0, 0, width, height)
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1)


def square_artwork() -> Image.Image:
    art = Image.open(SOURCE).convert("RGB")
    left, top, right, bottom = subject_box(art)
    subject_w, subject_h = right - left, bottom - top
    side = int(round(max(subject_w, subject_h) * (1 + 2 * MARGIN)))
    centre_x, centre_y = (left + right) / 2, (top + bottom) / 2
    box = (
        int(round(centre_x - side / 2)),
        int(round(centre_y - side / 2)),
        int(round(centre_x + side / 2)),
        int(round(centre_y + side / 2)),
    )
    # 主体本来就偏下,正方形常会越出原图；越出的部分用底色补齐,不裁掉人偶或字标。
    canvas = Image.new("RGB", (side, side), FIELD)
    canvas.paste(art.crop(box), (max(0, -box[0]), max(0, -box[1])))
    return canvas.resize((SIDE, SIDE), Image.LANCZOS)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="输出的 WebP 路径")
    parser.add_argument("--copy", action="append", default=[], help="额外接收同一图标的路径")
    parser.add_argument("--preview", help="可选的 PNG 预览路径")
    args = parser.parse_args()

    icon = square_artwork()
    output = pathlib.Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    icon.save(output, format="WEBP", quality=QUALITY, method=6)
    print(f"created {output} ({icon.size[0]}x{icon.size[1]}, {output.stat().st_size} bytes)")
    for destination in args.copy:
        path = pathlib.Path(destination)
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(output, path)
        print(f"copied to {path}")
    if args.preview:
        icon.save(args.preview, format="PNG")
        print(f"preview {args.preview}")


if __name__ == "__main__":
    main()
