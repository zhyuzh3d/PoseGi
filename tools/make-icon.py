#!/usr/bin/env python3
"""把归档的品牌图发布成应用图标。一处源图, 多处派生。

`docs/assets/posegi-icon-source.png` 是设计原图(1920×1910): 一个摆好动态姿势的
木质关节人偶, 下面一行发光的蓝色 PoseGi 字标, 底色近黑。这张图有四个特点决定了
本工具怎么做。

* **它自带三块非设计内容, 必须先排除再量主体。** 右上角有生成器留下的一段折线残迹,
  右下角有「豆包 AI 生成」水印, 右边缘在字标高度上还有一条竖向残迹。它们都比底色亮,
  直接按亮度求包围盒会把它们算进主体, 于是裁出一个偏右的方框 —— 图标右侧凭空多出
  一条黑带。`IGNORE` 里那三块窗口就是干这个的。
* **主体是 1249×1365, 略偏竖。** 所以正方形的边长取**内容高**, 横向以内容居中:
  上下贴齐不留边, 左右各让出一小条(约 4%)。反过来取内容宽会在头顶和字标底部各留
  一条 195 px 的黑边, 那正是要避免的。
* **圆角直接烘进图里, 不靠 CSS。** 浏览器标签页的 favicon 不吃 `border-radius`,
  宿主端各处的圆角(25.9% / 28.6% / 32%)也不统一, 所以这里一次烘好, 处处一致。
  半径取 24% 而不是站点 CSS 的 29%: 字标左端那一点到左下角圆心的距离算下来,
  半径超过 26% 就会啃到「P」。
* **它是写实渲染, 不是扁平图形。** 兄弟仓库的图标是扁平标记, 那边写无损 WebP;
  一张带明暗的 3D 渲染写无损要几百 KB, 所以这里用 quality 92 的有损, 肉眼无异。

输出 512×512 WebP(带透明圆角), favicon 另出 192×192 PNG —— iOS 的
`apple-touch-icon` 不吃 WebP。

用法:
  python3 tools/make-icon.py --out app/assets/icon.webp
  python3 tools/make-icon.py --out app/assets/icon.webp \\
      --copy ../hermitweb/public/assets/site/posegi.webp \\
      --copy ../hermitweb/public/assets/site/posegi-icon-192.png
"""

from __future__ import annotations

import argparse
import pathlib
import shutil

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "assets" / "posegi-icon-source.png"
SIDE = 512
FAVICON_SIDE = 192
QUALITY = 92
RADIUS = 0.24  # 圆角占短边比例; 上限见模块注释(26%)
LUMINANCE_CUTOFF = 45

# 原图里三块不是设计的亮内容, 量主体时要排除。坐标基于 1920×1910。
IGNORE = (
    (0, 0, 1920, 270),  # 右上角生成器残迹
    (1700, 0, 1920, 1910),  # 右边缘竖向残迹
    (1450, 1750, 1920, 1910),  # 「豆包 AI 生成」水印
)


def content_box(image: Image.Image) -> tuple[int, int, int, int]:
    """排除 IGNORE 之后, 亮于阈值的像素的包围盒。"""
    grey = image.convert("L")
    pixels = grey.load()
    width, height = grey.size
    xs: list[int] = []
    ys: list[int] = []
    for y in range(height):
        for x in range(width):
            if pixels[x, y] <= LUMINANCE_CUTOFF:
                continue
            if any(x0 <= x < x1 and y0 <= y < y1 for x0, y0, x1, y1 in IGNORE):
                continue
            xs.append(x)
            ys.append(y)
    if not xs:
        raise SystemExit("没有找到主体, 检查 LUMINANCE_CUTOFF 或 IGNORE")
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def rounded(image: Image.Image, ratio: float) -> Image.Image:
    """把方图裁成圆角矩形, 四角透明。"""
    size = image.size[0]
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=int(round(ratio * size)), fill=255
    )
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(image.convert("RGBA"), (0, 0), mask)
    return out


def artwork(side: int) -> Image.Image:
    art = Image.open(SOURCE).convert("RGB")
    left, top, right, bottom = content_box(art)
    width, height = right - left, bottom - top
    # 方框取内容高, 横向以内容居中 —— 上下贴齐, 左右各让一条。
    span = height
    centre_x = (left + right) / 2
    box = (
        int(round(centre_x - span / 2)),
        top,
        int(round(centre_x - span / 2)) + span,
        bottom,
    )
    canvas = Image.new("RGB", (span, span), (11, 13, 15))
    crop = art.crop(box)
    canvas.paste(crop, (max(0, -box[0]), 0))
    return rounded(canvas.resize((side, side), Image.LANCZOS), RADIUS)


def save(path: pathlib.Path, icon: Image.Image) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() == ".png":
        icon.save(path, format="PNG", optimize=True)
    else:
        icon.save(path, format="WEBP", quality=QUALITY, method=6)
    print(f"{path}  {icon.size[0]}x{icon.size[1]}  {path.stat().st_size} bytes")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="主输出(按后缀决定格式)")
    parser.add_argument("--copy", action="append", default=[], help="额外接收同一图标的路径")
    parser.add_argument("--size", type=int, default=SIDE, help=f"主输出边长, 默认 {SIDE}")
    parser.add_argument("--preview", help="可选的对照图输出路径")
    args = parser.parse_args()

    icon = artwork(args.size)
    output = pathlib.Path(args.out)
    save(output, icon)
    for destination in args.copy:
        path = pathlib.Path(destination)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.suffix.lower() == ".png":
            artwork(FAVICON_SIDE).save(path, format="PNG", optimize=True)
        else:
            shutil.copyfile(output, path)
        print(f"copied to {path}")
    if args.preview:
        icon.save(args.preview, format="PNG")
        print(f"preview {args.preview}")


if __name__ == "__main__":
    main()
