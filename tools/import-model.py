#!/usr/bin/env python3
"""把外部 glTF/GLB 人形模型转换成 PoseGi 的"骨架 + 刚性件"数据。

PoseGi 的渲染架构是:每个关节挂一件刚体网格,几何写在"关节局部坐标系"里
(原点 = 关节,骨骼方向 = 局部 +Y),视口只按 FK 给出的矩阵摆放。
所以外部模型必须被压成同一形状,做法四步:

  1) 定骨架 —— 从模型的绑定骨架取出我们那 20 个关节的"关节位置 + 朝向 + 骨长",
     直接替换 rig.js 里的 offset / length / rest。骨架比例因此来自模型本身。
  2) 定姿态 —— 绑定姿态未必是站姿(有些模型的绑定姿态是抱臂或侧身),用 aim 把骨头
     按世界方向掰到自然站姿,再取掰完之后的骨架。这样转换结果一打开就是站着的。
  3) 切几何 —— 按 JOINTS_0/WEIGHTS_0 里权重最大的骨把顶点硬切(刚性件)或直接按节点
     归属(本身就是刚性件的模型),再把顶点变换到对应关节的局部坐标系。
  4) 正解剖 —— **骨架的真相来源是人体测量学,模型的网格只是可以改的皮**。
     这一步按规范表重排关节位置(主要是髋),把关节球重定心到转动原点,把骨杆拉到
     新骨长,并把骨盆下缘补到能包住髋球。--no-anatomy 可关掉做对比。

不需要蒙皮,不需要 GLTFLoader,运行时零依赖:输出就是每关节一份 positions + indices。

用法:
    python3 tools/import-model.py ikea
    python3 tools/import-model.py ikea --no-anatomy    # 关掉解剖学校正,用于对比
    python3 tools/import-model.py --list

新增一个造型 = 在下面的 SOURCES 里加一条(源文件路径 + 关节映射 + 朝向修正),
再在 app/core/models.js 的登记与 index.html 的 script 里各加一行。
"""
import base64
import json
import math
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "app", "assets", "models")
HOME = os.path.expanduser("~")

# ---------------------------------------------------------------- 模型配置
#
# joints 每一项:(PoseGi 关节名, 父关节名, 承载坐标系的模型骨名, [几何来源的模型骨名])
#   父关节写 "broot" 表示直接挂在骨架顶层。
#   几何来源留空表示这件关节不画几何(例如肩,它只是胸与上臂之间的一个零长节点)。
#
# aim    :把绑定姿态掰到站姿。值是**目标世界方向**(转换前的模型空间,单位向量)。
#         `via` 用来指定"用哪根子骨的当前位置算方向",默认取第一根子骨。
#
# split  :一根模型骨要拆给多个 PoseGi 关节时按"件自身最大边长"分流(关节球给内侧关节,
#         骨杆给外侧关节)。键是模型骨名,值是一串 (PoseGi 关节, 边长上限)。
SOURCES = {
    "ikea": {
        "file": os.path.join(HOME, "Downloads", "manniquin.glb"),
        "label": ["宜家人偶", "IKEA figure"],
        "short": ["人偶", "Figure"],
        "height": 1.74,
        "joints": [
            ("hips", "broot", "Pelvis_00", ["Pelvis_00"]),
            ("spine", "hips", "Torso_04", ["Torso_04"]),
            ("chest", "spine", "Chest_05", ["Chest_05"]),
            ("neck", "chest", "Neck_06", ["Neck_06"]),
            ("head", "neck", "Head_07", ["Head_07"]),
            ("shoulder.L", "chest", "Arm.L_011", ["Arm.L_011"]),
            ("upperArm.L", "shoulder.L", "Arm.L_011", []),
            ("forearm.L", "upperArm.L", "Forearm.L_012", ["Forearm.L_012"]),
            ("hand.L", "forearm.L", "Hand.L_013", ["Hand.L_013"]),
            ("shoulder.R", "chest", "Arm.R_08", ["Arm.R_08"]),
            ("upperArm.R", "shoulder.R", "Arm.R_08", []),
            ("forearm.R", "upperArm.R", "Forearm.R_09", ["Forearm.R_09"]),
            ("hand.R", "forearm.R", "Hand.R_010", ["Hand.R_010"]),
            ("thigh.L", "hips", "Thigh.L_01", ["Thigh.L_01"]),
            ("shin.L", "thigh.L", "Leg.L_02", ["Leg.L_02"]),
            ("foot.L", "shin.L", "Foot.L_03", ["Foot.L_03"]),
            ("thigh.R", "hips", "Thigh.R_014", ["Thigh.R_014"]),
            ("shin.R", "thigh.R", "Leg.R_015", ["Leg.R_015"]),
            ("foot.R", "shin.R", "Foot.R_016", ["Foot.R_016"]),
        ],
        # 绑定姿态本来就是标准 T-pose,只要把手臂放下来即可。
        "aim": {
            "Arm.L_011": [0.24, -0.97, 0.0],
            "Forearm.L_012": [0.17, -0.985, 0.03],
            "Arm.R_08": [-0.24, -0.97, 0.0],
            "Forearm.R_09": [-0.17, -0.985, 0.03],
        },
        "split": {
            "Arm.L_011": [("shoulder.L", 0.30), ("upperArm.L", 1e9)],
            "Arm.R_08": [("shoulder.R", 0.30), ("upperArm.R", 1e9)],
        },
    },
}

COMP = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
IDENT = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]


# ---------------------------------------------------------------- 基础数学
def mat_of(node):
    if "matrix" in node:
        m = node["matrix"]
        return [[m[0], m[4], m[8], m[12]], [m[1], m[5], m[9], m[13]],
                [m[2], m[6], m[10], m[14]], [m[3], m[7], m[11], m[15]]]
    t = node.get("translation") or [0, 0, 0]
    q = node.get("rotation") or [0, 0, 0, 1]
    s = node.get("scale") or [1, 1, 1]
    x, y, z, w = q
    r = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
         [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
         [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    return [[r[i][j] * s[j] for j in range(3)] + [t[i]] for i in range(3)] + [[0, 0, 0, 1]]


def mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def xf(m, p):
    return [m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + m[i][3] for i in range(3)]


def inv(m):
    a = [row[:] for row in m]
    r = [[1.0 if i == j else 0.0 for j in range(4)] for i in range(4)]
    for c in range(4):
        piv = max(range(c, 4), key=lambda i: abs(a[i][c]))
        if abs(a[piv][c]) < 1e-12:
            raise ValueError("矩阵不可逆")
        a[c], a[piv] = a[piv], a[c]
        r[c], r[piv] = r[piv], r[c]
        d = a[c][c]
        a[c] = [v / d for v in a[c]]
        r[c] = [v / d for v in r[c]]
        for i in range(4):
            if i != c and abs(a[i][c]) > 1e-12:
                f = a[i][c]
                a[i] = [a[i][k] - f * a[c][k] for k in range(4)]
                r[i] = [r[i][k] - f * r[c][k] for k in range(4)]
    return r


def sub(a, b):
    return [a[i] - b[i] for i in range(3)]


def norm3(a):
    length = math.sqrt(sum(v * v for v in a)) or 1.0
    return [v / length for v in a]


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def dot(a, b):
    return sum(a[i] * b[i] for i in range(3))


def axis_angle(axis, degree):
    x, y, z = norm3(axis)
    a = math.radians(degree)
    c, s = math.cos(a), math.sin(a)
    r = [[c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
         [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
         [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)]]
    return [r[i] + [0] for i in range(3)] + [[0, 0, 0, 1]]


def rot_between(a, b):
    a, b = norm3(a), norm3(b)
    d = max(-1.0, min(1.0, dot(a, b)))
    if d > 0.999999:
        return [row[:] for row in IDENT]
    if d < -0.999999:
        helper = [1, 0, 0] if abs(a[0]) < 0.9 else [0, 1, 0]
        return axis_angle(norm3(cross(a, helper)), 180)
    return axis_angle(cross(a, b), math.degrees(math.acos(d)))


def about(point, rotation):
    t = [[1, 0, 0, point[0]], [0, 1, 0, point[1]], [0, 0, 1, point[2]], [0, 0, 0, 1]]
    ti = [[1, 0, 0, -point[0]], [0, 1, 0, -point[1]], [0, 0, 1, -point[2]], [0, 0, 0, 1]]
    r = [rotation[i][:3] + [0] for i in range(3)] + [[0, 0, 0, 1]]
    return mul(t, mul(r, ti))


def euler_from(delta):
    """从"M = Rz·Ry·Rx"里解回 (x, y, z) 度。与 rig.js 的 eulerFromMatrix 逐字对应。"""
    sy = max(-1.0, min(1.0, -delta[2][0]))
    y = math.asin(sy)
    cy = math.cos(y)
    if abs(cy) > 1e-6:
        x = math.atan2(delta[2][1], delta[2][2])
        z = math.atan2(delta[1][0], delta[0][0])
    else:
        x = 0.0
        z = math.atan2(-delta[0][1], delta[1][1])
    scale = 180.0 / math.pi
    return [round(x * scale, 4), round(y * scale, 4), round(z * scale, 4)]


# ---------------------------------------------------------------- 解剖学校正
#
# 骨架的真相来源是**人体测量学**,模型的网格只是"可以改的皮"。
# 每个关节要满足四条(2026-09-25 与用户定的验收判据):
#   ① 球心 = 转动原点      ② 球与杆同轴同心
#   ③ 近端有窝,球嵌进去    ④ 球半径盖住杆近端断面
#
# 规范值一律以身高 H 归一化(人体测量学常用值):
#   髋(股骨头中心) 0.530H    膝(膝关节线) 0.285H   踝(外踝) 0.039H
#   肩(盂肱关节)   0.818H    肘            0.630H   股骨头中心间距 0.100H
#   骨盆下缘(坐骨结节) 0.480H
#
# 本模型(宜家人偶,1.74m)实测:髋 0.4880H / 膝 0.2785H / 踝 0.0434H /
#   肩 0.8022H / 肘 0.6223H。⇒ **只有髋错了,而且错得离谱(低 73mm)**,
#   其余五个都在 8~43mm 以内。所以这一节动五处,一处不多:
#     1) 肩球重定心(球心离转动原点 47.8mm —— 这是"球杆分离"的根)
#     2) 髋抬到 0.530H,膝抬到 0.285H(踝不动:只差 7.7mm,动它只会让脚离地)
#     3) 股骨颈收细:大腿杆近端收到"装得进股骨头球"的半径(内切判据见第 3 步)
#     4) 骨盆下缘延到坐骨结节 0.480H(原来只到 0.5091H,短了 50mm)
#     5) 骨盆横向轮廓翻正:原网格是一只**上窄下宽的锥台**(最宽 137mm 落在
#        0.519H),真骨盆正好相反 —— 髂嵴最宽、往下收到坐骨结节。同时把底面
#        两髋之间的中线抬起成一道**会阴浅拱**(用户 2026-09-25 点名要求:
#        "髋关节会阴部分也要正确处理","注意和上面腰部衔接,和下面双髋关节衔接")
#     6) 髋臼:股骨头球缩到解剖尺寸 r=0.0138H≈24mm。原来 55.9mm —— 那是把整块
#        髋部软组织当成了球;缩到解剖值之后球整个藏进骨盆,不再是两颗吊在
#        骨盆外面的球(用户参考图指的就是这个)
#   其余关节一律不碰:改了没有收益,只会把已经对齐的东西弄歪。
#
#   第 4/5/6 步会**故意**让大腿根部露出骨盆两侧:真骨盆在髋高度只有 0.069H
#   半宽,而髋关节中心在 0.050H —— 股骨颈断面本来就在骨盆内(第 3 步保证),
#   但往下变粗的大腿杆一定会从骨盆边缘露出来。这在解剖上就是髋/粗隆软组织,
#   2026-09-25 与用户确认过,按"解剖优先"接受。
ANATOMY = {
    "hip": 0.5300,            # thigh 关节原点(股骨头中心)
    "knee": 0.2850,           # shin 关节原点(膝关节线)
    "hip_lateral": 0.0500,    # 股骨头中心到身体中线的横向距离(间距 0.100H)
    "hip_ball_r": 0.0321,     # 股骨头球半径(= 源模型的 55.9mm)
    "hip_clearance": 0.005,   # 零件表面离骨盆壁的余量:第 6 步用它判"球是不是悬在外面"
    "pelvis_overlap": 0.035,  # 骨盆下缘至少要压到杆顶之下这么多(下限保护)
    "pelvis_bottom": 0.4800,  # 骨盆下缘(坐骨结节)高度
    "pelvis_anchor": 1.020,   # 骨盆高于这个高度就一点都不动(腰部衔接)
    # **股骨颈不再收细**(2026-09-25 用户要求:"大腿的上端也不要故意做细,
    # 恢复到最初端部的状态")。0.42 那一版把杆顶收到 20.7mm,大腿看着像一根
    # 细杆从骨盆底下伸出来 —— 关节也就不在视觉上的髋位置了。
    # 1.0 = 完全不收细;要重新收紧就把这个数调小(机制留着,不改代码)。
    "neck_taper": 1.0,
    "neck_taper_ramp": 0.105,  # 从杆近端往下多少米之内恢复原半径
    "neck_ball_fit": 0.86,    # 收细时杆近端半径上限 = 股骨头半径 × 这个系数
    "neck_taper_joints": ("thigh.L", "thigh.R"),
    "pelvis_depth_gain": 0.60,  # 横向放大时纵深跟进的比例(0.6 = 比横向保守)
    "pelvis_table_skip": 0.004,  # 建"当前半宽表"时跳过最低这么多米
    "pelvis_crest": 0.6050,   # 髂嵴高度:这以上横向缩放淡出到 0(保腰部接缝)
    # 底面:**要凸,不能凹**(2026-09-25 用户纠正:"裆部不应该是凹进去的,
    # 我说的会阴应该是阴部")。曾经按人体解剖学把底面中线抬起 26mm 做成"会阴浅拱",
    # 渲染出来是一道**向上凹的缺口**,读作"骨盆底下被挖了一块"。
    # 现在反过来:**把底面的两侧往上抬、中央留最低** ⇒ 一个向下的弧/尖,
    # 也就是阴部该有的样子(第 5b 步的 pelvis_arch)。
    # 用户 2026-09-25 第二次看参考图后要求"阴部更向下凸起",所以落差从 2mm 加到 50mm。
    "pelvis_arch": 0.045,      # 底面两侧相对中央往上抬多高(米)
    "pelvis_arch_r0": 0.0340,  # 离中线这么宽(H)之内不抬(中央阴部那一段)
    "pelvis_arch_r1": 0.0720,  # 超过这么宽(H)就抬满(轮廓的外侧角)
    "pelvis_arch_top": 0.5200, # 抬升往上淡出到这么高(H),再高一点不动
    # 骨盆的横向轮廓,控制点 (y/H, 半宽/H)。
    # 2026-09-25 第二次重塑(用户参考图第三版 + "横向更宽要能完全包裹髋关节"):
    #   ① **最宽点从髂嵴下移到 0.542H**(153mm)。原表最宽在 0.605H 的 136mm,
    #      而髋关节球外缘在 0.0500+0.0321 = 0.0821H(=143mm)⇒ 球在最宽处仍然
    #      露在骨盆外面,读作"外挂的两颗球"。真髋部最宽处本来就在股骨头略上方。
    #   ② **0.498–0.530H 这一段沿"球外缘 + 1mm 壁"取下限**:要"完全包裹髋关节",
    #      骨盆在这个高度区间的半宽必须不小于球在该高度的横向外缘
    #      r_ball(h) = 0.0500 + sqrt(0.0321² − (0.5300−h)²)。
    #   ③ **下段急收**:0.509H(外侧角 132mm)→ 0.480H(中央尖),就是"底部侧面
    #      更倾斜"。这一段的具体数值与第 5b 步的 pelvis_arch 弧线互为逆函数
    #      (半宽 w 处的下缘高度 = 0.480H + arch(w))。
    # 髂嵴 0.605H 以上完全照旧:那一段和第 5 步的淡出一起守着腰部接缝。
    "pelvis_width": [
        (0.4800, 0.0060),     # 中央尖(阴部最低点)
        (0.4860, 0.0350),
        (0.4920, 0.0500),
        (0.4980, 0.0620),
        (0.5040, 0.0720),
        (0.5100, 0.0780),     # 外侧角:轮廓最下缘
        (0.5160, 0.0810),
        (0.5220, 0.0828),
        (0.5300, 0.0840),     # 股骨头中心高度:≥ 球外缘 0.0821H
        (0.5360, 0.0860),
        (0.5420, 0.0875),     # 最宽 = 153mm
        (0.5500, 0.0865),
        (0.5600, 0.0850),
        (0.5700, 0.0835),
        (0.5800, 0.0820),
        (0.5950, 0.0805),
        (0.6050, 0.0805),     # 髂嵴(与上一版相同,不动)
        (0.6140, 0.0775),
        (0.6250, 0.0700),
        (0.6312, 0.0620),
    ],
}


def centroid(pts):
    n = len(pts)
    return [sum(p[k] for p in pts) / n for k in range(3)]


def dist3(a, b):
    return math.sqrt(sum((a[k] - b[k]) ** 2 for k in range(3)))


def components(verts, idx):
    """按 index 求连通块。宜家的每一件都是"球 + 杆"两个(有时三个)互不相连的块,
    拆开才能"只把球搬到新原点,只把杆拉到新骨长"。"""
    n = len(verts)
    par = list(range(n))

    def find(a):
        while par[a] != a:
            par[a] = par[par[a]]
            a = par[a]
        return a

    for k in range(0, len(idx), 3):
        a = find(idx[k])
        par[a] = find(idx[k + 1])
        par[find(idx[k + 1])] = find(idx[k + 2])
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())


def sphere_grade(pts):
    """球性 = 最远顶点距离 / 最近顶点距离。1 附近就是球,越大越像杆。"""
    c = centroid(pts)
    ds = [dist3(c, p) for p in pts]
    return c, max(ds) / (min(ds) or 1e-9), max(ds)


def point_tri(p, a, b, c):
    """点到三角形的最近距离(垂直落在三角形内时取垂距,否则退到边/顶点)。"""
    ab, ac = sub(b, a), sub(c, a)
    n = cross(ab, ac)
    nn = dot(n, n)
    if nn > 1e-18:
        t = dot(sub(p, a), n) / nn
        foot = [p[i] - t * n[i] for i in range(3)]
        ap = sub(foot, a)
        d00, d01, d11 = dot(ab, ab), dot(ab, ac), dot(ac, ac)
        d20, d21 = dot(ap, ab), dot(ap, ac)
        den = d00 * d11 - d01 * d01
        if abs(den) > 1e-18:
            v = (d11 * d20 - d01 * d21) / den
            w = (d00 * d21 - d01 * d20) / den
            if v >= -1e-9 and w >= -1e-9 and v + w <= 1 + 1e-9:
                return abs(t) * math.sqrt(nn)
    best = min(dist3(p, a), dist3(p, b), dist3(p, c))
    for e0, e1 in ((a, b), (b, c), (c, a)):
        e = sub(e1, e0)
        L2 = dot(e, e)
        s = 0.0 if L2 < 1e-18 else max(0.0, min(1.0, dot(sub(p, e0), e) / L2))
        best = min(best, dist3(p, [e0[i] + s * e[i] for i in range(3)]))
    return best


def surface_gap(verts, idx, p):
    """点 p 到这块网格表面的最近距离。"""
    best = float("inf")
    for k in range(0, len(idx), 3):
        d = point_tri(p, verts[idx[k]], verts[idx[k + 1]], verts[idx[k + 2]])
        if d < best:
            best = d
    return best


def cross_section(verts, idx, y):
    """水平面 y 与网格相交得到的所有点。

    为什么不用"按高度分带取顶点最大 |x|":骨盆只有 450 个顶点,摊到 250mm 高度上,
    有些带里几乎没有顶点,取出来的"最宽"是假的(实测同一段高度两种分带差 90mm)。
    三角形求交是分段线性的,层与层之间没有采样空洞。"""
    pts = []
    for k in range(0, len(idx), 3):
        tri = [verts[idx[k]], verts[idx[k + 1]], verts[idx[k + 2]]]
        ys = [p[1] for p in tri]
        if min(ys) > y or max(ys) < y:
            continue
        for a in range(3):
            p, q = tri[a], tri[(a + 1) % 3]
            if (p[1] - y) * (q[1] - y) < 0:
                t = (y - p[1]) / (q[1] - p[1])
                pts.append([p[i] + t * (q[i] - p[i]) for i in range(3)])
            elif abs(p[1] - y) < 1e-12:
                pts.append(list(p))
    return pts


def width_table(verts, idx, cx, steps=48, skip=0.0):
    """该网格的"半宽 vs 高度"表(按高度扫截面外缘)。

    `skip` 用来跳过最低的一小段:骨盆的最低点是**单个**坐骨结节顶点,在它附近
    水平面几乎切不到三角形(切到的也只是尖角),量出来的"半宽"会假性变小,
    按它缩放会把底面向中间缩成一团。跳过几毫米之后截面才是完整的环。"""
    ys = [v[1] for v in verts]
    lo, hi = min(ys) + skip, max(ys)
    table = []
    for k in range(steps + 1):
        y = lo + (hi - lo) * k / steps
        pts = cross_section(verts, idx, y)
        table.append((y, max(abs(p[0] - cx) for p in pts) if pts else 0.0))
    return table


def interp_table(table, y):
    """在表里按高度线性插值。"""
    if not table:
        return 0.0
    if y <= table[0][0]:
        return table[0][1]
    if y >= table[-1][0]:
        return table[-1][1]
    for k in range(1, len(table)):
        y0, w0 = table[k - 1]
        y1, w1 = table[k]
        if y0 <= y <= y1:
            t = 0.0 if y1 <= y0 else (y - y0) / (y1 - y0)
            return w0 + (w1 - w0) * t
    return table[-1][1]


def pelvis_target_width(y, H, points):
    """目标半宽(米)。控制点之间用 smoothstep 过渡,免得轮廓出现折角。"""
    ys = [p[0] * H for p in points]
    ws = [p[1] * H for p in points]
    if y <= ys[0]:
        return ws[0]
    if y >= ys[-1]:
        return ws[-1]
    for k in range(1, len(ys)):
        if ys[k - 1] <= y <= ys[k]:
            t = 0.0 if ys[k] <= ys[k - 1] else (y - ys[k - 1]) / (ys[k] - ys[k - 1])
            s = t * t * (3.0 - 2.0 * t)
            return ws[k - 1] + (ws[k] - ws[k - 1]) * s
    return ws[-1]


def smoothstep(t):
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    return t * t * (3.0 - 2.0 * t)


def correct_anatomy(frames, bucket, children, spec, notes):
    """按人体测量学重排骨架,并把每件网格刚性搬到新关节原点。

    只改 frames 的**平移**与顶点位置:旋转一个都不动(rest 因此逐字不变)。
    这样后面"由 frames 反推 offset / rest / 换算局部坐标"的原逻辑一行都不用改 ——
    搬完关节原点,零件局部坐标自动跟着平移,不需要另写一套。

    返回 (frames, bucket);原地改也成立,返回值只是让调用点读起来清楚。
    """
    H = float(spec["height"])
    origin = {n: [frames[n][i][3] for i in range(3)] for n in frames}
    new = {n: list(origin[n]) for n in origin}
    cap = {}                    # 杆的近端断面(世界 y):第 4 步要用它定骨盆下缘

    # ---- 1) 肩球重定心:把转动原点搬到球心上 --------------------------------
    # 不搬的后果是量出来的:球绕原点画 4.78cm 的弧,上臂杆画 5.64cm 的弧,
    # 两者一转就错开 —— 30000 个随机合法姿态里 39.7% 球杆之间裂开,最坏 +4.9cm。
    # 搬完球心 = 转动原点,球与杆的相对位置**与角度无关**,结构上不可能再裂。
    # 顺带把髋,膝,腕,肘一起复核:只有肩偏心(47.8mm),其余都在 6.2mm 以内,不碰。
    for side in ("L", "R"):
        name = "shoulder." + side
        vs = bucket[name]["verts"]
        groups = components(vs, bucket[name]["idx"])
        if not groups:
            continue
        g = max(groups, key=len)
        c, grade, _ = sphere_grade([vs[i] for i in g])
        if grade > 1.35:
            continue
        off = dist3(c, origin[name])
        new[name] = c
        # **与它"零位移同点"的子关节必须一起搬**(宜家这里就是 upperArm,offset 全 0),
        # 否则上臂的转动轴还留在旧原点上 —— 搬了等于没搬,球杆照旧分离。
        # 判据只看 offset 是否为零:零位移子关节按定义与父关节同点,父走它就得走;
        # 而 offset 非零的子关节(前臂,小腿)保持世界位置,偏移由 frames 反推自动吸收。
        for child in children.get(name, []):
            d = mul(inv(frames[name]), frames[child])
            if max(abs(d[i][3]) for i in range(3)) < 1e-9:
                new[child] = list(c)
                notes.append("  同点子关节 %s 随 %s 一起搬到球心" % (child, name))
        notes.append("  肩球重定心 %s:转动原点外移 %.1f mm ⇒ 归零"
                     % (name, off * 1000))

    # ---- 2) 髋抬到 0.530H 且横向挪到 ±0.050H,膝抬到 0.285H -----------------
    # 高度早就差 73mm(0.4880H → 0.530H);**横向从来没改过**,源模型只给 0.0787H
    # (两髋 137mm),而规范值写着 0.100H(174mm)—— 少 37mm,也就是屁股比真人窄。
    # 这一步用的就是文件头第 209 行那条一直没落地的规范值。
    # 横向的基准取**身体中线**(hips 关节原点的 x),不是世界原点:本模型的中线
    # 在 x=0.0052,源网格的两条腿正是绕它对称的(±0.0685)。若按世界原点摆,
    # 两髋会一边 87mm 一边 93mm,骨盆就会一边包得住一边包不住(实测右球被迫缩到
    # 22mm 而左球 24mm)。
    mid_x = origin["hips"][0]
    for side in ("L", "R"):
        new["thigh." + side][1] = ANATOMY["hip"] * H
        new["shin." + side][1] = ANATOMY["knee"] * H
        sign = 1.0 if side == "L" else -1.0
        new["thigh." + side][0] = mid_x + ANATOMY["hip_lateral"] * H * sign
        notes.append("  整骨 %s:髋 %.4f→%.4f 膝 %.4f→%.4f (股骨 %+.1fcm 胫骨 %+.1fcm)"
                     % (side, origin["thigh." + side][1], new["thigh." + side][1],
                        origin["shin." + side][1], new["shin." + side][1],
                        (dist3(new["thigh." + side], new["shin." + side])
                         - dist3(origin["thigh." + side], origin["shin." + side])) * 100,
                        (dist3(new["shin." + side], new["foot." + side])
                         - dist3(origin["shin." + side], origin["foot." + side])) * 100))
    before_gap = abs(origin["thigh.L"][0] - origin["thigh.R"][0])
    after_gap = abs(new["thigh.L"][0] - new["thigh.R"][0])
    notes.append("  髋横向:中线 x=%.4f,单侧 %.1f→%.1f mm;间距 %.1f→%.1f mm(%.4fH→%.4fH)"
                 % (mid_x, abs(origin["thigh.L"][0] - mid_x) * 1000,
                    abs(new["thigh.L"][0] - mid_x) * 1000,
                    before_gap * 1000, after_gap * 1000, before_gap / H, after_gap / H))

    # ---- 3) 零件几何:球刚性搬到新原点,杆沿骨轴缩放到新骨长 ----------------
    # 判据②与④靠这一步:球心搬到关节原点(转动时球不动),杆的近端锚点也在球心上,
    # 于是"球裹住杆的近端断面"这件事与角度无关。
    for side in ("L", "R"):
        for name, child in (("thigh." + side, "shin." + side),
                            ("shin." + side, "foot." + side)):
            vs = bucket[name]["verts"]
            groups = components(vs, bucket[name]["idx"])
            if not groups:
                continue
            rod = max(groups, key=len)
            balls = []
            for g in groups:
                if g is rod:
                    continue
                c, grade, rmax = sphere_grade([vs[i] for i in g])
                if grade > 1.35:
                    continue
                owner = name if dist3(c, origin[name]) <= dist3(c, origin[child]) else child
                balls.append([g, c, owner, rmax])
            # 搬球:球心 → 它所属关节的新原点
            near = far = None
            for g, c, owner, rmax in balls:
                tgt = new[name] if owner == name else new[child]
                for i in g:
                    vs[i] = [vs[i][k] + tgt[k] - c[k] for k in range(3)]
                if owner == name and (near is None or dist3(c, origin[name]) < dist3(near[0], origin[name])):
                    near = (c, tgt)
                if owner == child and (far is None or dist3(c, origin[child]) < dist3(far[0], origin[child])):
                    far = (c, tgt)
            # 杆:把"近锚点→远锚点"这一段映射到新的骨上
            b_old, b_new = near if near else (origin[name], new[name])
            c_old, c_new = far if far else (origin[child], new[child])
            l_old, l_new = dist3(b_old, c_old), dist3(b_new, c_new)
            if abs(l_new - l_old) < 1e-6:
                continue
            u = [v / l_old for v in sub(c_old, b_old)]
            u2 = [v / l_new for v in sub(c_new, b_new)]
            k = l_new / l_old
            # **股骨颈收细**(只对髋,而且只有 `neck_taper` < 1 时才真的动手)。
            # 它曾经的目的:让杆顶藏进骨盆与那颗小球。2026-09-25 用户判定"大腿
            # 上端被故意做细"是错的 —— 大腿上端该有自己的粗细(源网格 69~74mm),
            # 那才是视觉上的髋关节位置。所以现在 `neck_taper` = 1.0 = 不收细,
            # 机制留着(要收紧只改参数,不改代码)。杆顶(近端断面)的高度**照样记录**,
            # 第 4 步要用它守"骨盆下缘压在杆顶之下"这条下限。
            neck = name in ANATOMY["neck_taper_joints"]
            s_min, ramp = ANATOMY["neck_taper"], ANATOMY["neck_taper_ramp"]
            tapering = neck and s_min < 1.0
            if neck:
                neck_r = ANATOMY["hip_ball_r"] * H * ANATOMY["neck_ball_fit"]
                t0 = min(sum(sub(vs[i], b_old)[j] * u[j] for j in range(3)) * k for i in rod)
                r_pre = 0.0
                for i in rod:
                    d = sub(vs[i], b_old)
                    a = sum(d[j] * u[j] for j in range(3))
                    p = [d[j] - a * u[j] for j in range(3)]
                    if a * k < t0 + ramp:
                        r_pre = max(r_pre, math.sqrt(sum(x * x for x in p)))
            for i in rod:
                d = sub(vs[i], b_old)
                a = sum(d[j] * u[j] for j in range(3))
                perp = [d[j] - a * u[j] for j in range(3)]
                s = 1.0
                if tapering:
                    f = max(0.0, min(1.0, (a * k - t0) / ramp))
                    s = s_min + (1.0 - s_min) * f
                    pr = math.sqrt(sum(x * x for x in perp))
                    if pr > 1e-9:
                        # 绝对上限只准在近端渐变区里说话,而且**按同一个 f 淡出**:
                        # 写成 min(s, neck_r/pr) 是错的 —— 那等于给整根股骨一个
                        # 20.6mm 的全程半径上限,大腿会变成一根细棍(实测就是这样)。
                        s_cap = neck_r / pr
                        s_lim = 1.0 + (s_cap - 1.0) * (1.0 - f)
                        s = min(s, s_lim)
                vs[i] = [b_new[j] + perp[j] * s + a * k * u2[j] for j in range(3)]
            if neck:
                cap[name] = b_new[1] + t0 * u2[1]
                if tapering:
                    notes.append("  股骨颈 %s:杆近端半径 ×%.2f 且 ≤%.1fmm(颈段原 %.1fmm),"
                                 "往下 %.0fmm 内恢复原半径"
                                 % (name, s_min, neck_r * 1000, r_pre * 1000, ramp * 1000))
                else:
                    notes.append("  股骨颈 %s:不收细,杆近端保持原半径 %.1fmm,"
                                 "杆顶在 %.4f(%.4fH)"
                                 % (name, r_pre * 1000, cap[name], cap[name] / H))

    # ---- 4) 骨盆下缘延到坐骨结节 0.480H ------------------------------------
    # 两件事同时要成立,取**更低**的那个:
    #   ① 解剖:下缘(坐骨结节)在 0.480H。原网格只到 0.8858 = 0.5091H,短 50mm,
    #      所以"屁股没有下沿",大腿根直接从骨盆侧面穿出去。
    #   ② 零件:下缘必须压在杆顶之下至少 pelvis_overlap,否则杆顶的平顶断面
    #      会露在骨盆外面(渲染成一根悬空的平顶圆柱 —— 与用户抱怨肩部"球杆分离"
    #      是同一类病)。抬髋之后杆顶在 0.9222 附近,① 比它低得多,所以通常 ① 说话。
    # 纵向只动 anchor 以下,且 anchor 恰好映到 anchor ⇒ **腰部对齐逐字不变**。
    vs = bucket["hips"]["verts"]
    low = min(v[1] for v in vs)
    y0 = ANATOMY["pelvis_anchor"]
    cap_y = min(cap.values()) if cap else None
    anat_bottom = ANATOMY["pelvis_bottom"] * H
    want = anat_bottom if cap_y is None else min(anat_bottom, cap_y - ANATOMY["pelvis_overlap"])
    if want < low:
        k = (y0 - want) / (y0 - low)
        for v in vs:
            if v[1] < y0:
                v[1] = y0 - (y0 - v[1]) * k
        notes.append("  骨盆下缘 %.4f→%.4f m (%.4fH→%.4fH,纵向下延 ×%.3f),"
                     "杆顶 %.4f 之上留 %.0fmm"
                     % (low, want, low / H, want / H, k, cap_y, (cap_y - want) * 1000))
    else:
        notes.append("  骨盆下缘 %.4f 已在目标 %.4f 之下,不动" % (low, want))

    # ---- 5) 骨盆横向轮廓翻正 + 会阴浅拱 ------------------------------------
    # 原网格是一只**上窄下宽的锥台**:最宽 137mm 落在 0.519H,再往上单调收到
    # 0.6246H 的 94mm。真骨盆正好相反 —— 髂嵴(0.605H)最宽,往下经髋臼收到
    # 坐骨结节(0.480H)。所以这一步是**把轮廓翻正**:
    #   ① 按高度量出"当前半宽"(三角形与水平面求交,不是分带取顶点 —— 骨盆只
    #      450 个顶点,分带取最大会假性变小,同一高度两套分带能差 90mm);
    #   ② 每个顶点按 目标半宽/当前半宽 绕中线缩放 x;
    #   ③ 纵深(绕 z)按 pelvis_depth_gain 跟进:本网格是实心的整体,
    #      只放 x 会把它压成一块板;而真骨盆的入口本来就是近乎正圆的
    #      (横径 0.082H vs 前后径 0.070H),跟进是解剖上正确的。
    #   ④ 髂嵴以上(pelvis_crest)把缩放**淡出到 0**:骨盆件的顶面正是外套在
    #      spine 件外面的那一圈腰,动它就在腰上留一道台阶。淡出之后腰部
    #      接缝逐字不变(与第 4 步守的是同一件事)。
    vs = bucket["hips"]["verts"]
    idx = bucket["hips"]["idx"]
    cx = (min(v[0] for v in vs) + max(v[0] for v in vs)) / 2.0
    cz = (min(v[2] for v in vs) + max(v[2] for v in vs)) / 2.0
    table = width_table(vs, idx, cx, skip=ANATOMY["pelvis_table_skip"])
    y_crest = ANATOMY["pelvis_crest"] * H
    y_top = max(v[1] for v in vs)
    gain = ANATOMY["pelvis_depth_gain"]
    probe = (0.5090, 0.5300, 0.5420, 0.6050)
    before = [interp_table(table, h * H) for h in probe]
    for v in vs:
        cur = interp_table(table, v[1])
        if cur < 1e-6:
            continue
        k = pelvis_target_width(v[1], H, ANATOMY["pelvis_width"]) / cur
        if v[1] > y_crest:
            k = 1.0 + (k - 1.0) * (1.0 - smoothstep((v[1] - y_crest) / (y_top - y_crest)))
        v[0] = cx + (v[0] - cx) * k
        v[2] = cz + (v[2] - cz) * (1.0 + (k - 1.0) * gain)
    after = [interp_table(width_table(vs, idx, cx, skip=ANATOMY["pelvis_table_skip"]),
                          h * H) for h in probe]
    notes.append("  骨盆轮廓翻正(半宽 mm,0.509/0.530/0.542/0.605H):"
                 + " / ".join("%.1f→%.1f" % (a * 1000, b * 1000)
                              for a, b in zip(before, after)))
    notes.append("  骨盆最宽 %.1fmm 在 %.4fH(原来 %.1fmm 在 %.4fH)"
                 % (max(after) * 1000, probe[after.index(max(after))],
                    max(before) * 1000, probe[before.index(max(before))]))

    # ---- 5b) 底面 V 形:两侧往上抬、中央留最低(阴部向下凸) ------------------
    # 这一节的历史:曾经做过"会阴浅拱"(按 |x−中线| 把底面中线**抬起** 26mm),
    # 理由是真骨盆的坐骨结节比会阴低 —— 方向做反了,渲染成一道向上凹的缺口。
    # 改成"什么都不做"之后中央只比两侧低 2.1mm,量出来几乎是一条平底,
    # 用户 2026-09-25 第三次看参考图仍然指出"阴部更向下凸起"。
    # 现在按 r = |x−中线| 把底面**两侧抬起来**(中央不动),抬升量随 r 用 smoothstep
    # 从 0 涨到 pelvis_arch(=50mm),往上在 pelvis_arch_top 处线性淡出到 0:
    #     lift(r, y) = arch · smoothstep((r−r0)/(r1−r0)) · (top−y)/(top−bottom)
    # 于是:中央(r≈0)不动 ⇒ 尖落在 0.480H;外侧(r ≥ r1)抬满 ⇒ 外侧角落在
    # 0.480H + 0.050 = 0.5087H —— 正是用户要的"底部侧面更倾斜"(一条从中央尖
    # 斜向外上的边)。抬升权重随高度淡出,骨盆上部一点不动。
    # **必须在第 5 步之后**:第 5 步是按高度量半宽表来缩放的,先抬 y 会把表读歪。
    low = min(v[1] for v in vs)
    arch = ANATOMY["pelvis_arch"]
    r0 = ANATOMY["pelvis_arch_r0"] * H
    r1 = ANATOMY["pelvis_arch_r1"] * H
    y_arch_top = ANATOMY["pelvis_arch_top"] * H
    if arch > 0.0 and y_arch_top > low:
        for v in vs:
            if v[1] >= y_arch_top:
                continue
            w = smoothstep((abs(v[0] - cx) - r0) / (r1 - r0)) if r1 > r0 else 1.0
            if w <= 0.0:
                continue
            t = (y_arch_top - v[1]) / (y_arch_top - low)
            v[1] += arch * w * max(0.0, min(1.0, t))
    mid_low = min([v[1] for v in vs if abs(v[0] - cx) < 0.010 * H] or [low])
    side_low = min([v[1] for v in vs if abs(v[0] - cx) > r1] or [low])
    notes.append("  底面 V 形:中央 %.4f(%.4fH) / 外侧 %.4f(%.4fH)⇒ 阴部比两侧低 %.1fmm"
                 % (mid_low, mid_low / H, side_low, side_low / H,
                    (side_low - mid_low) * 1000))

    # ---- 6) 髋关节合位:报告股骨头球与骨盆的相对位置(不做缩放) -------------
    # 这一节曾经把球从 55.9mm 缩到 24mm(理由是"真股骨头直径 0.0276H")。
    # **2026-09-25 撤销**:用户要求"大腿的上端恢复到最初端部的状态" —— 那颗球
    # 就是大腿零件上端的一部分,而且它是**视觉上"髋关节"之所以成立的那块体量**:
    # 缩到 24mm 之后它整个埋进骨盆、什么也看不见,髋关节就"消失"了。
    # 现在只做两件事:
    #   ① 报出球心到骨盆壁的距离 —— 球是**一半嵌在骨盆里、一半从骨盆侧壁鼓出来**,
    #      那个交线就是髋关节的外观(用户参考图里画的两个圈正是这里);
    #   ② 球心必须落在骨盆内(dmin 大于某个门槛说明球被推到了骨盆外面、变成悬空的球,
    #      那才是原始模型真正的毛病)。数量级:骨盆壁到球心约 30mm,
    #      球心在骨盆外会掉到 10mm 以下。
    for side in ("L", "R"):
        name = "thigh." + side
        vs = bucket[name]["verts"]
        bc = new[name]
        dmin = surface_gap(bucket["hips"]["verts"], bucket["hips"]["idx"], bc)
        for g in components(vs, bucket[name]["idx"]):
            c, grade, rmax = sphere_grade([vs[i] for i in g])
            if grade > 1.35 or rmax > 0.12:
                continue                      # 只认球;髋球的最大半径 0.056,杆是 0.164
            out = rmax - dmin                 # >0 = 球从骨盆壁鼓出去多少
            notes.append("  髋关节 %s:球半径 %.1fmm,球心到骨盆壁 %.1fmm ⇒ 嵌入 %.1fmm、"
                         "外露 %.1fmm"
                         % (side, rmax * 1000, dmin * 1000,
                            min(rmax, dmin) * 1000, max(0.0, out) * 1000))
            # ③ 横向包裹复核(2026-09-25 用户要求"横向更宽要能完全包裹髋关节")。
            #    球心在 ±hip_lateral、半径 rmax ⇒ 高度 h 处球的横向外缘
            #        r_ball(h) = hip_lateral + sqrt(rmax² − (hip − h)²)
            #    拿它和第 5 步的**目标**半宽比(不是实际网格:网格只有 450 个顶点,
            #    在某个高度上可能一个顶点都没有)。最紧的一点报出来。
            worst = None
            for h in (0.4980, 0.5060, 0.5140, 0.5220, 0.5300):
                dy = (ANATOMY["hip"] - h) * H
                if abs(dy) >= rmax:
                    continue
                out_r = ANATOMY["hip_lateral"] * H + math.sqrt(rmax * rmax - dy * dy)
                wall = pelvis_target_width(h * H, H, ANATOMY["pelvis_width"])
                if worst is None or (out_r - wall) > worst[1]:
                    worst = (h, out_r - wall, out_r, wall)
            if worst:
                notes.append("    横向包裹:最紧在 %.4fH —— 球外缘 %.1fmm vs 目标骨盆壁 "
                             "%.1fmm ⇒ %s %.1fmm"
                             % (worst[0], worst[2] * 1000, worst[3] * 1000,
                                "包住" if worst[1] <= 0.0 else "还露",
                                abs(worst[1]) * 1000))
            if dmin < ANATOMY["hip_clearance"] * 2:
                notes.append("    ! 球心离骨盆壁只有 %.1fmm,球基本悬在骨盆外 —— "
                             "检查髋横向 / 骨盆下缘" % (dmin * 1000))

    # ---- 7) 把新原点写回 frames(只动平移列) ------------------------------
    for name in frames:
        for i in range(3):
            frames[name][i][3] = new[name][i]
    return frames, bucket


# ---------------------------------------------------------------- glTF 读取
def load(path):
    raw = open(path, "rb").read()
    if path.lower().endswith(".glb"):
        _, _, length = struct.unpack_from("<4sII", raw, 0)
        off, chunks = 12, {}
        while off < length:
            clen, ctype = struct.unpack_from("<I4s", raw, off)
            chunks[ctype.strip(b"\x00")] = (off + 8, clen)
            off += 8 + clen
        joff, jlen = chunks[b"JSON"]
        gltf = json.loads(raw[joff:joff + jlen])
        binoff = chunks[b"BIN"][0] if b"BIN" in chunks else 0
        return gltf, raw, binoff
    gltf = json.load(open(path))
    buf = gltf["buffers"][0]
    if "uri" not in buf:
        raise SystemExit("外部 .gltf 缺少 buffer uri")
    return gltf, open(os.path.join(os.path.dirname(path), buf["uri"]), "rb").read(), 0


def accessor(gltf, raw, binoff, index):
    acc = gltf["accessors"][index]
    view = gltf["bufferViews"][acc["bufferView"]]
    fmt, size = COMP[acc["componentType"]]
    count = NCOMP[acc["type"]]
    stride = view.get("byteStride") or size * count
    base = binoff + view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    return [struct.unpack_from("<" + fmt * count, raw, base + i * stride) for i in range(acc["count"])]


def hierarchy(gltf):
    parent, kids = {}, {}
    for i, node in enumerate(gltf["nodes"]):
        kids[i] = list(node.get("children", []))
        for c in kids[i]:
            parent[c] = i
    return parent, kids


def world_matrices(gltf, kids, parent):
    world = {}

    def walk(i, m):
        w = mul(m, mat_of(gltf["nodes"][i]))
        world[i] = w
        for c in kids[i]:
            walk(c, w)

    for i in range(len(gltf["nodes"])):
        if i not in parent:
            walk(i, IDENT)
    return world


def posed_world(gltf, kids, parent, bind, aim):
    """按 aim 把骨架掰到站姿。aim 是"该骨的目标世界方向",旋转施加在关节自身位置上。

    注意子节点要按名字过滤掉网格挂载层(Cube.xxx / *_Material_0),
    它们在层级里和骨头混在一起,拿错了算出来的骨轴就是位移向量的方向(踩过)。
    """
    posed = {}
    bone_children = {}
    for i in range(len(gltf["nodes"])):
        bone_children[i] = [c for c in kids[i]
                            if not (gltf["nodes"][c].get("name") or "").startswith("Cube.")
                            and not (gltf["nodes"][c].get("name") or "").endswith("_Material_0")]

    def walk(i, mp):
        local = bind[i] if parent.get(i) is None else mul(inv(bind[parent[i]]), bind[i])
        m = mul(mp, local)
        name = gltf["nodes"][i].get("name")
        if name in aim and bone_children[i]:
            child = bone_children[i][0]
            offset = mul(inv(bind[i]), bind[child])
            pos = [m[r][3] for r in range(3)]
            child_pos = xf(m, [offset[r][3] for r in range(3)])
            m = mul(about(pos, rot_between(norm3(sub(child_pos, pos)), aim[name])), m)
        posed[i] = m
        for c in kids[i]:
            walk(c, m)

    for i in range(len(gltf["nodes"])):
        if i not in parent:
            walk(i, IDENT)
    return posed


# ---------------------------------------------------------------- 主流程
def build(model_id, spec):
    gltf, raw, binoff = load(spec["file"])
    nodes = gltf["nodes"]
    parent, kids = hierarchy(gltf)
    bind = world_matrices(gltf, kids, parent)
    index_by_name = {}
    for i, node in enumerate(nodes):
        if node.get("name"):
            index_by_name.setdefault(node["name"], i)

    # 先把整个模型转正,再掰姿态 —— aim 里的方向是按"角色朝 +Z,左侧为 +X"写的。
    # 绑定姿态不一定朝前:有的模型绑定姿态整体偏航几十度,不转正一打开就是个斜站的人。
    # 判据取"左髋→右髋"这条线,它对镜像与左右互换都稳。
    frame_bone = {item[0]: item[2] for item in spec["joints"]}
    hl = bind[index_by_name[frame_bone["thigh.L"]]]
    hr = bind[index_by_name[frame_bone["thigh.R"]]]
    vx, vz = hl[0][3] - hr[0][3], hl[2][3] - hr[2][3]
    yaw = math.atan2(vz, vx) if (abs(vx) + abs(vz)) > 1e-9 else 0.0
    if abs(yaw) > 1e-4:
        c, s = math.cos(yaw), math.sin(yaw)
        ry = [[c, 0, s, 0], [0, 1, 0, 0], [-s, 0, c, 0], [0, 0, 0, 1]]
        # 只转根:非根节点的"相对父"保持不变,于是整棵树刚性转过去
        bind = {i: mul(ry, m) for i, m in bind.items()}
    posed = posed_world(gltf, kids, parent, bind, spec.get("aim", {}))
    print("  偏航校正 %.2f 度" % math.degrees(yaw))

    # --- 顶点 -> 世界坐标 + 归属骨 -------------------------------------------------
    skin = (gltf.get("skins") or [None])[0]
    joint_names = []
    jmats = []
    if skin:
        ip = accessor(gltf, raw, binoff, skin["inverseBindMatrices"])
        for k, jn in enumerate(skin["joints"]):
            joint_names.append(nodes[jn].get("name"))
            ibm = ip[k]
            ibm_mat = [[ibm[0], ibm[4], ibm[8], ibm[12]], [ibm[1], ibm[5], ibm[9], ibm[13]],
                       [ibm[2], ibm[6], ibm[10], ibm[14]], [ibm[3], ibm[7], ibm[11], ibm[15]]]
            jmats.append(mul(posed[jn], ibm_mat))

    verts = []   # (world xyz, 归属骨名, 件最大边长, 件名)
    for i, node in enumerate(nodes):
        if "mesh" not in node:
            continue
        bound = skin is not None and "skin" in node
        # 刚性件:顶点在**网格节点自己**的坐标系里。中间那层 Cube.xxx / *_Material_0
        # 带着自己的位移与旋转,用骨骼节点的矩阵去变换会整体错位(踩过)。
        owner_node = i
        if not bound:
            walker = parent.get(i)
            while walker is not None:
                nm = nodes[walker].get("name") or ""
                if not nm.endswith("_Material_0") and not nm.startswith("Cube."):
                    owner_node = walker
                    break
                walker = parent.get(walker)
        owner_name = nodes[owner_node].get("name")
        node_world = posed[i]

        for prim in gltf["meshes"][node["mesh"]].get("primitives", []):
            pos = accessor(gltf, raw, binoff, prim["attributes"]["POSITION"])
            idx = [v[0] for v in accessor(gltf, raw, binoff, prim["indices"])] if "indices" in prim else list(range(len(pos)))
            joins = accessor(gltf, raw, binoff, prim["attributes"]["JOINTS_0"]) if bound else None
            weights = accessor(gltf, raw, binoff, prim["attributes"]["WEIGHTS_0"]) if bound else None
            lo = [min(p[k] for p in pos) for k in range(3)]
            hi = [max(p[k] for p in pos) for k in range(3)]
            span = max(hi[k] - lo[k] for k in range(3))
            local = []
            for vi, v in enumerate(pos):
                if bound:
                    total = sum(weights[vi]) or 1.0
                    best = max(range(4), key=lambda z: weights[vi][z])
                    p = xf(jmats[joins[vi][best]], v)
                    bone = joint_names[joins[vi][best]]
                else:
                    p = xf(node_world, v)
                    bone = owner_name
                local.append((p, bone))
            for k in range(0, len(idx), 3):
                tri = [local[idx[k]], local[idx[k + 1]], local[idx[k + 2]]]
                verts.append((tri, span, nodes[i].get("name")))

    # --- 定骨架:把模型的骨名映射到 PoseGi 的关节 ----------------------------------
    names_order = [item[0] for item in spec["joints"]]
    parent_of = {item[0]: item[1] for item in spec["joints"]}
    frame_node = {item[0]: index_by_name[item[2]] for item in spec["joints"]}
    children = {}
    for name in names_order:
        children.setdefault(parent_of[name], []).append(name)

    bone_to_joint = {}
    for joint_name, _, _, sources in spec["joints"]:
        for b in sources:
            bone_to_joint.setdefault(b, []).append(joint_name)
    for bone, rules in spec.get("split", {}).items():
        bone_to_joint[bone] = rules

    # --- 定尺度:统一缩放到目标身高,脚底压到 y=0,x/z 居中 -------------------------
    ys = [p[1] for tri, _, _ in verts for p, _ in tri]
    xs = [p[0] for tri, _, _ in verts for p, _ in tri]
    zs = [p[2] for tri, _, _ in verts for p, _ in tri]
    raw_height = max(ys) - min(ys)
    scale = spec["height"] / raw_height
    shift = [-(max(xs) + min(xs)) / 2.0 * scale, -min(ys) * scale,
             -(max(zs) + min(zs)) / 2.0 * scale]

    def to_world(p):
        return [p[0] * scale + shift[0], p[1] * scale + shift[1], p[2] * scale + shift[2]]

    def to_metric(m):
        t = to_world([m[0][3], m[1][3], m[2][3]])
        return [m[i][:3] + [t[i]] for i in range(3)] + [[0, 0, 0, 1]]

    # 顶点是在模型原始单位里收集的,这里一次性换到米。往后每一处坐标系都是米 ——
    # 漏掉这一步的表现是"顶点数与三角数全对,但骨长与包围半径大出十几倍"(踩过)。
    verts = [([(to_world(p), bone) for p, bone in tri], span, nm) for tri, span, nm in verts]

    raw_frames = {name: to_metric(posed[frame_node[name]]) for name in names_order}

    # --- 切几何(第一遍):三角按归属骨丢进各关节,这一遍先不动坐标系 ----------------
    bucket = {name: {"idx": [], "verts": [], "map": {}} for name in names_order}
    orphan = {}
    for tri, span, node_name in verts:
        votes = {}
        for p, bone in tri:
            rules = bone_to_joint.get(bone)
            if not rules:
                orphan[bone] = orphan.get(bone, 0) + 1
                continue
            if isinstance(rules[0], tuple):
                target = rules[-1][0]
                for jn, cap in rules:
                    if span <= cap:
                        target = jn
                        break
            else:
                target = rules[0]
            votes[target] = votes.get(target, 0) + 1
        if not votes:
            continue
        target = max(votes.items(), key=lambda kv: kv[1])[0]
        b = bucket[target]
        for p, _ in tri:
            key = (round(p[0], 6), round(p[1], 6), round(p[2], 6))
            vi = b["map"].get(key)
            if vi is None:
                vi = len(b["verts"])
                b["map"][key] = vi
                b["verts"].append(p)
            b["idx"].append(vi)
    if orphan:
        print("  警告:以下骨没有对应 PoseGi 关节,顶点被丢弃:", orphan)

    # --- 骨轴对齐:把每根骨的方向摆到"关节局部 +Y" ---------------------------------
    # 外部模型多用"局部 +X 沿骨"(UE)之类的约定。不对齐的话骨长,骨骼末端,胖射线
    # 全都指错方向 —— 表现为拖拽解算和点选一起失灵,而且看不出是谁的错。
    def axial(name):
        """沿 PoseGi 链条往下找第一根位置真的不同的后代,用它定骨轴。"""
        here = [raw_frames[name][i][3] for i in range(3)]
        queue = list(children.get(name, []))
        while queue:
            c = queue.pop(0)
            there = [raw_frames[c][i][3] for i in range(3)]
            if math.dist(here, there) > 1e-4:
                return c
            queue.extend(children.get(c, []))
        return None

    def reframe(m, world_rotation):
        """保留原点,只把朝向换成 world_rotation · m 的旋转部分。
        必须在世界侧左乘:局部侧右乘得到的是 raw·R,它的 +Y 在世界里仍是 R 转过的方向,
        骨长与坐标会全部落在错误的方向上。"""
        rows = [[sum(world_rotation[i][k] * m[k][j] for k in range(3)) for j in range(3)] + [m[i][3]]
                for i in range(3)]
        return rows + [[0, 0, 0, 1]]

    # 骨架顶层的坐标系取单位阵,让 hips 的朝向**如实**进 rest。
    # 早先把 hips 的 rest 强行写成 [0,0,0],等于丢掉 hips 坐标系相对世界的朝向;
    # 但子关节的 offset 又是在 hips 坐标系里算的,两边不一致,整棵骨架被转回去
    # (踩过:某份模型的 hips 带了 44 度偏航,渲染出来是个侧身站着的人;而宜家人偶的 hips
    # 朝向碰巧就是单位阵,所以这个 bug 在它身上一直看不出来)。
    frames = {"broot": [row[:] for row in IDENT]}
    for name in names_order:
        origin = [raw_frames[name][i][3] for i in range(3)]
        child = axial(name)
        if child is not None:
            target = [raw_frames[child][i][3] - origin[i] for i in range(3)]
        else:
            # 叶子骨(头 / 手 / 脚):没有子关节,拿离关节最远的那颗顶点当骨轴
            far, best = 0.0, None
            for p in bucket[name]["verts"]:
                d = math.dist(p, origin)
                if d > far:
                    far, best = d, p
            target = [best[i] - origin[i] for i in range(3)] if best else None
        if not target:
            frames[name] = raw_frames[name]
            continue
        # 3x3 的第二列就是"该坐标系局部 +Y"在世界里的方向,把它转到骨轴上
        up = [raw_frames[name][i][1] for i in range(3)]
        frames[name] = reframe(raw_frames[name], rot_between(up, norm3(target)))

    # --- 解剖学校正:骨架按人体测量学重排,网格跟着搬 ------------------------------
    # 放在这里是因为**下游全是从 frames 反推的**:offset / rest / length / radius 与
    # 每件网格的局部坐标都读 frames。改完 frames 的平移,后面一行都不用动。
    notes = []
    if spec.get("anatomy", True):
        correct_anatomy(frames, bucket, children, spec, notes)
    else:
        notes.append("  解剖学校正已关闭(--no-anatomy),骨架保持模型原样")

    # --- 关节表:offset / rest / length / radius -----------------------------------
    table = {}
    for name in names_order:
        frame = frames[name]
        pname = parent_of[name]
        delta = mul(inv(frames[pname]), frame)
        table[name] = {
            "offset": [round(delta[i][3], 6) for i in range(3)],
            # 含 hips 在内,所有关节的 rest 都是"相对父坐标系的朝向",不能特殊化。
            "rest": euler_from(delta),
            "length": 0.0,
            "radius": 0.05
        }
    for name in names_order:
        kids_j = children.get(name, [])
        if kids_j:
            here = [frames[name][i][3] for i in range(3)]
            # 取链条上的第一根子关节当骨骼末端。用 min 会被"髋→大腿"这类分支带偏:
            # 髋的长度会算成到股关节的 0.086,而不是到脊椎的 0.15,胖射线跟着缩水。
            table[name]["length"] = round(
                math.dist(here, [frames[kids_j[0]][i][3] for i in range(3)]), 6)
    table["broot"] = {"offset": [0, 0, 0], "rest": [0, 0, 0], "length": 0.0, "radius": 0}

    # --- 切几何(第二遍):顶点变换到各自关节的局部坐标系 ---------------------------
    parts = {}
    tri_count = {}
    for name in names_order:
        b = bucket[name]
        if not b["verts"]:
            continue
        inverse = inv(frames[name])
        local = [xf(inverse, p) for p in b["verts"]]
        far = max(math.dist(p, [0, 0, 0]) for p in local)
        if table[name]["length"] <= 0:
            table[name]["length"] = round(far, 6)
        table[name]["radius"] = round(max(0.03, min(0.24, far * 0.5)), 4)
        parts[name] = {"pos": local, "idx": b["idx"]}
        tri_count[name] = len(b["idx"]) // 3

    return {
        "id": model_id,
        "label": spec["label"],
        "short": spec["short"],
        "source": os.path.basename(spec["file"]),
        "height": spec["height"],
        "joints": table,
        "parts": parts,
        "notes": notes,
        "stats": {"tris": tri_count, "scale": scale, "shift": shift, "raw": raw_height},
    }


def b64_f32(values):
    return base64.b64encode(struct.pack("<" + "f" * len(values), *values)).decode("ascii")


def b64_u16(values):
    return base64.b64encode(struct.pack("<" + "H" * len(values), *values)).decode("ascii")


def emit(result):
    joints = ["broot"] + [j for j in result["joints"] if j != "broot"]
    lines = []
    lines.append("/* 由 tools/import-model.py 生成,不要手改。")
    lines.append(" * 源:%s(统一缩放到 %.4fm,脚底 y=0)" % (result["source"], result["height"]))
    lines.append(" * 每个关节一件刚体几何,顶点写在关节局部坐标系里(原点=关节)。 */")
    lines.append("(function (app) {")
    lines.append('  "use strict";')
    lines.append("  app.models.register({")
    lines.append('    id: "%s",' % result["id"])
    lines.append('    label: ["%s", "%s"],' % tuple(result["label"]))
    lines.append('    short: ["%s", "%s"],' % tuple(result["short"]))
    lines.append('    source: "%s",' % result["source"])
    lines.append("    joints: {")
    for name in joints:
        row = result["joints"][name]
        lines.append('      "%s": { offset: [%s], rest: [%s], length: %s, radius: %s },'
                     % (name,
                        ", ".join("%.6g" % v for v in row["offset"]),
                        ", ".join("%.6g" % v for v in row["rest"]),
                        "%.6g" % row["length"], "%.6g" % row["radius"]))
    lines.append("    },")
    lines.append("    parts: {")
    for name in joints:
        part = result["parts"].get(name)
        if not part:
            continue
        lines.append('      "%s": { n: %d, pos: "%s", idx: "%s" },'
                     % (name, len(part["pos"]), b64_f32([c for p in part["pos"] for c in p]),
                        b64_u16(part["idx"])))
    lines.append("    }")
    lines.append("  });")
    lines.append("})(window.posegi);")
    lines.append("")
    return "\n".join(lines)


def report(result):
    print("  身高缩放系数 %.5f,原始高 %.4f,平移 [%.4f, %.4f, %.4f]"
          % (result["stats"]["scale"], result["stats"]["raw"], *result["stats"]["shift"]))
    for line in result.get("notes", []):
        print(line)
    print("  %-14s %8s %8s %10s %10s" % ("关节", "顶点", "三角", "骨长", "坐标(米)"))
    total_v = total_t = 0
    for name, row in result["joints"].items():
        if name == "broot":
            continue
        part = result["parts"].get(name) or {"pos": [], "idx": []}
        tri = len(part["idx"]) // 3
        total_v += len(part["pos"])
        total_t += tri
        origin = [row["offset"][0], row["offset"][1], row["offset"][2]]
        print("  %-14s %8d %8d %10.4f   [%.3f, %.3f, %.3f]"
              % (name, len(part["pos"]), tri, row["length"], *origin))
    print("  合计 顶点 %d,三角 %d" % (total_v, total_t))


def main():
    args = sys.argv[1:]
    if not args or args[0] == "--list":
        print("可用模型:" + ", ".join(sorted(SOURCES)))
        return
    no_anatomy = "--no-anatomy" in args
    plains = [a for a in args if not a.startswith("--")]
    if not plains:
        raise SystemExit("缺少模型名,可选:" + ", ".join(sorted(SOURCES)))
    model_id = plains[0]
    if model_id not in SOURCES:
        raise SystemExit("未知模型 %r,可选:%s" % (model_id, ", ".join(sorted(SOURCES))))
    spec = dict(SOURCES[model_id])
    if no_anatomy:
        spec["anatomy"] = False
    if not os.path.exists(spec["file"]):
        raise SystemExit("找不到源文件:" + spec["file"])
    print("== %s <= %s" % (model_id, spec["file"]))
    result = build(model_id, spec)
    report(result)
    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, model_id + ".js")
    text = emit(result)
    open(out, "w").write(text)
    print("  -> %s  (%.1f KB)" % (os.path.relpath(out, ROOT), len(text) / 1024.0))


if __name__ == "__main__":
    main()
