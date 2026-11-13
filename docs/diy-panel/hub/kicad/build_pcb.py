#!/usr/bin/env python3
"""Builds the Level 1 hub board in KiCad from ../layout.json (written by ../gen.mjs).

Places the footprints on the paper-checked positions, gives every pad its net, routes the board
with a small two-layer grid router (A*, 0.25 mm grid, 0.3 mm tracks, 0.2 mm clearance) and saves
hub-l1.kicad_pcb. Run with the system Python that has KiCad's pcbnew module (KiCad 9):

    python3 docs/diy-panel/hub/kicad/build_pcb.py

Then check and export with kicad-cli (see README.md next to this file).
"""
import heapq
import json
import math
import os
import sys

import numpy as np
import pcbnew
from pcbnew import FromMM, ToMM, VECTOR2I

HERE = os.path.dirname(os.path.abspath(__file__))
LAY = json.load(open(os.path.join(HERE, '..', 'layout.json')))
W, H = LAY['W'], LAY['H']
FPLIB = '/usr/share/kicad/footprints/'
OUT = os.path.join(HERE, 'hub-l1.kicad_pcb')
VERSION = 'v1.0'

TRACK, CLEAR, VIA, VIA_DRILL = 0.3, 0.2, 0.6, 0.3
EDGE_KEEP = 0.5          # copper to board edge
HOLE_KEEP = 3.2          # copper to mounting-hole centre (M2.5 screw head / standoff)
G = 0.25                 # router grid
MARGIN = 0.03            # extra on top of the clearance, for the grid


# ---- nets -----------------------------------------------------------------------------------
def net_for(ref, i, name):
    if ref == 'J1' or ref in ('J2', 'J3', 'J4', 'J5', 'J6'):
        return name
    if ref == 'J7':
        return ['HORN', 'GND'][i]
    if ref == 'J8':
        return ['ST_R', 'ST_G', 'ST_B', 'GND'][i]
    if ref == 'J9':
        return ['LK_R', 'LK_G', 'LK_B', 'GND'][i]
    if ref == 'J10':
        return ['5V', 'GND', 'BTN1', 'BTN2'][i]
    if ref == 'J11':
        return ['BTN1', 'BTN2'][i]
    if ref == 'U1':
        return {'VCC': '3V3', 'GND': 'GND', 'SCL': 'SCL', 'SDA': 'SDA', 'RST': '3V3',
                'A0': 'GND', 'A1': 'GND', 'A2': 'GND'}.get(name)
    if ref == 'U1b':
        return {'VCC': '3V3'}.get(name)
    if ref == 'U1a':
        return {'A0': 'HORN', 'A1': 'GPA1', 'A2': 'GPA2', 'A3': 'GPA3', 'A4': 'GPA4',
                'A5': 'GPA5', 'A6': 'GPA6', 'GND': 'GND'}.get(name)
    if ref == 'U2':
        return {'VCC': '3V3'}.get(name, name)
    raise KeyError(ref)


RES_NETS = {'R1': ('OE', '3V3'), 'R2': ('GPA1', 'ST_R'), 'R3': ('GPA2', 'ST_G'), 'R4': ('GPA3', 'ST_B'),
            'R5': ('GPA4', 'LK_R'), 'R6': ('GPA5', 'LK_G'), 'R7': ('GPA6', 'LK_B')}
LABEL = {'J1': 'PI: 3V3 5V GND SDA SCL OE', 'J2': 'INA 0x40', 'J3': 'INA 0x41', 'J4': 'PD 0x28',
         'J5': 'SHT40', 'J6': 'SPARE', 'J7': 'HORN SIG GND', 'J8': 'STATUS RGBK', 'J9': 'LINK RGBK',
         'J10': 'BTN 5V G SW SW', 'J11': 'PI5 J2'}

board = pcbnew.BOARD()
nets = {}


def net(name):
    if name not in nets:
        n = pcbnew.NETINFO_ITEM(board, name)
        board.Add(n)
        nets[name] = n
    return nets[name]


def load(lib, name, ref, value):
    fp = pcbnew.FootprintLoad(FPLIB + lib + '.pretty', name)
    fp.SetReference(ref)
    fp.SetValue(value)
    fp.Value().SetVisible(False)
    fp.Reference().SetVisible(False)   # the silk labels below carry the reference
    board.Add(fp)
    return fp


def mm(v):
    return ToMM(v)


def pad_xy(p):
    q = p.GetPosition()
    return (mm(q.x), mm(q.y))


def place(fp, targets, ordered):
    """Rotate/move fp so its pads sit on targets (by pad number when ordered, else as a set)."""
    cx = sum(t[0] for t in targets) / len(targets)
    cy = sum(t[1] for t in targets) / len(targets)
    for rot in (0, 90, 180, 270):
        fp.SetOrientationDegrees(rot)
        fp.SetPosition(VECTOR2I(0, 0))
        pads = sorted(fp.Pads(), key=lambda p: int(p.GetNumber()))
        pts = [pad_xy(p) for p in pads]
        px = sum(p[0] for p in pts) / len(pts)
        py = sum(p[1] for p in pts) / len(pts)
        fp.SetPosition(VECTOR2I(FromMM(cx - px), FromMM(cy - py)))
        pts = [pad_xy(p) for p in pads]
        if ordered:
            ok = all(math.dist(a, b) < 0.02 for a, b in zip(pts, targets))
        else:
            ok = all(min(math.dist(a, b) for b in targets) < 0.02 for a in pts)
        if ok:
            return rot
    raise RuntimeError('cannot place ' + fp.GetReference())


def assign(fp, named):
    """named: list of ((x, y), netname or None)."""
    for p in fp.Pads():
        xy = pad_xy(p)
        (_, n) = min(named, key=lambda t: math.dist(t[0], xy))
        if n:
            p.SetNet(net(n))


def silk(txt, x, y, size=1.0, angle=0, layer=pcbnew.F_SilkS, justify=None):
    t = pcbnew.PCB_TEXT(board)
    t.SetText(txt)
    t.SetLayer(layer)
    t.SetTextSize(VECTOR2I(FromMM(size), FromMM(size)))
    t.SetTextThickness(FromMM(0.15))
    t.SetPosition(VECTOR2I(FromMM(x), FromMM(y)))
    t.SetTextAngleDegrees(angle)
    if justify:
        t.SetHorizJustify(justify)
    board.Add(t)


def line(x1, y1, x2, y2, layer, w=0.15):
    s = pcbnew.PCB_SHAPE(board)
    s.SetShape(pcbnew.SHAPE_T_SEGMENT)
    s.SetStart(VECTOR2I(FromMM(x1), FromMM(y1)))
    s.SetEnd(VECTOR2I(FromMM(x2), FromMM(y2)))
    s.SetLayer(layer)
    s.SetWidth(FromMM(w))
    board.Add(s)


def rect(x, y, w, h, layer, wd=0.15):
    for a, b in (((x, y), (x + w, y)), ((x + w, y), (x + w, y + h)), ((x + w, y + h), (x, y + h)), ((x, y + h), (x, y))):
        line(a[0], a[1], b[0], b[1], layer, wd)


# ---- footprints -----------------------------------------------------------------------------
parts = {p['ref']: p for p in LAY['parts']}
for ref, p in parts.items():
    if p['kind'] != 'xh':
        continue
    n = len(p['pts'])
    fp = load('Connector_JST', f'JST_XH_B{n}B-XH-A_1x{n:02d}_P2.50mm_Vertical', ref, f'XH-{n}')
    place(fp, [tuple(t) for t in p['pts']], True)
    # Keep the courtyard 0.4 inside the board: the footprint's long side (3.94 from the pins) may face
    # the edge, the drawing assumed the short side.
    pads = sorted(fp.Pads(), key=lambda q: int(q.GetNumber()))
    p1, p2 = pad_xy(pads[0]), pad_xy(pads[1])
    ux, uy = (p2[0] - p1[0]) / 2.5, (p2[1] - p1[1]) / 2.5
    vx, vy = -uy, ux
    corners = []
    for lx in (-3.0, (n - 1) * 2.5 + 3.0):
        for ly in (-2.9, 3.94):
            corners.append((p1[0] + lx * ux + ly * vx, p1[1] + lx * uy + ly * vy))
    dx = dy = 0.0
    xs, ys = [c[0] for c in corners], [c[1] for c in corners]
    if min(xs) < 0.4: dx = 0.4 - min(xs)
    if max(xs) > W - 0.4: dx = W - 0.4 - max(xs)
    if min(ys) < 0.4: dy = 0.4 - min(ys)
    if max(ys) > H - 0.4: dy = H - 0.4 - max(ys)
    if dx or dy:
        pos = fp.GetPosition()
        fp.SetPosition(VECTOR2I(pos.x + FromMM(dx), pos.y + FromMM(dy)))
    assign(fp, [((t[0] + dx, t[1] + dy), net_for(ref, i, nm)) for i, (t, nm) in enumerate(zip(p['pts'], p['pins']))])
    p['placed'] = [(t[0] + dx, t[1] + dy) for t in p['pts']]
    # silk label just inside the courtyard, on the side towards the board centre
    xs, ys = [c[0] + dx for c in corners], [c[1] + dy for c in corners]
    cxp, cyp = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    if abs(ux) > 0.5:      # pins along x: label below/above
        ly = max(ys) + 0.9 if cyp < H / 2 else min(ys) - 0.9
        silk(f'{ref} {LABEL[ref]}', cxp, ly, 0.9)
        if ref in ('J2', 'J3', 'J4', 'J5', 'J6'):
            silk('GND 3V3 SDA SCL', cxp, ly + 1.3, 0.8)
    else:                  # pins along y: vertical label right/left
        lx = max(xs) + 0.9 if cxp < W / 2 else min(xs) - 0.9
        silk(f'{ref} {LABEL[ref]}', lx, cyp, 0.9, 270)   # reads top to bottom, like pin 1 → n

u1 = load('Connector_PinSocket_2.54mm', 'PinSocket_1x10_P2.54mm_Vertical', 'U1A', 'MCP23017 single row')
place(u1, [tuple(t) for t in parts['U1']['pts']], False)
assign(u1, [(tuple(t), net_for('U1', i, nm)) for i, (t, nm) in enumerate(zip(parts['U1']['pts'], parts['U1']['pins']))])
u1b = load('Connector_PinSocket_2.54mm', 'PinSocket_2x10_P2.54mm_Vertical', 'U1B', 'MCP23017 ports')
dbl = [(tuple(t), net_for('U1b', i, nm)) for i, (t, nm) in enumerate(zip(parts['U1b']['pts'], parts['U1b']['pins']))] + \
      [(tuple(t), net_for('U1a', i, nm)) for i, (t, nm) in enumerate(zip(parts['U1a']['pts'], parts['U1a']['pins']))]
place(u1b, [t for t, _ in dbl], False)
assign(u1b, dbl)
for p in u1b.Pads():                 # only the single row's VCC gets the square pad
    p.SetShape(pcbnew.PAD_SHAPE_CIRCLE)
u2 = load('Connector_PinSocket_2.54mm', 'PinSocket_1x04_P2.54mm_Vertical', 'U2', 'DS3231 pass-through')
place(u2, [tuple(t) for t in parts['U2']['pts']], True)
assign(u2, [(tuple(t), net_for('U2', i, nm)) for i, (t, nm) in enumerate(zip(parts['U2']['pts'], parts['U2']['pins']))])
for (x, y), nm in zip(parts['U2']['pts'], parts['U2']['pins']):
    silk(nm, x - 1.6, y, 0.8, 0, pcbnew.F_SilkS, pcbnew.GR_TEXT_H_ALIGN_RIGHT)
for ref, p in parts.items():
    if p['kind'] != 'res':
        continue
    val = {'R1': '10k', 'R2': '150', 'R3': '47', 'R4': '47', 'R5': '150', 'R6': '47', 'R7': '47'}[ref]
    fp = load('Resistor_THT', 'R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal', ref, val)
    place(fp, [tuple(p['a']), tuple(p['b'])], True)
    assign(fp, [(tuple(p['a']), RES_NETS[ref][0]), (tuple(p['b']), RES_NETS[ref][1])])
    fp.Reference().SetVisible(False)
    silk(f'{ref} {val}', (p['a'][0] + p['b'][0]) / 2, p['a'][1], 0.8, 0, pcbnew.F_SilkS)
for k, (x, y) in enumerate(LAY['holes']):
    fp = load('MountingHole', 'MountingHole_2.7mm_M2.5', f'H{k + 1}', 'M2.5')
    fp.SetPosition(VECTOR2I(FromMM(x), FromMM(y)))
    fp.Reference().SetVisible(False)

# silk: module outlines, orientation notes, title
m, r = LAY['mcp'], LAY['rtc']
rect(m['x'], m['y'], m['w'], m['h'], pcbnew.F_SilkS)
silk('U1 MCP23017 - LABELS UP', m['x'] + m['w'] / 2, m['y'] + m['h'] / 2 - 1.2, 1.0)
silk('VCC on the square pad', m['x'] + m['w'] / 2, m['y'] + m['h'] / 2 + 0.6, 0.8)
rect(r['x'], r['y'], r['w'], r['h'], pcbnew.F_SilkS)
silk('U2 DS3231 - CHIP SIDE UP', r['x'] + r['w'] / 2 - 3, r['y'] + r['h'] / 2 - 1, 1.0)
silk('cell underneath', r['x'] + r['w'] / 2 - 3, r['y'] + r['h'] / 2 + 0.8, 0.8)
silk(f'POINT HUB - hub L1 {VERSION}', 70, 44.5, 1.0)
silk('2026-11', 70, 46.3, 0.8)

# outline
rect(0, 0, W, H, pcbnew.Edge_Cuts, 0.1)

# design rules
ds = board.GetDesignSettings()
ds.m_MinClearance = FromMM(CLEAR)
ds.m_TrackMinWidth = FromMM(0.2)
ds.m_ViasMinSize = FromMM(VIA)
ds.m_MinThroughDrill = FromMM(VIA_DRILL)
ds.m_CopperEdgeClearance = FromMM(0.3)
nc = ds.m_NetSettings.GetDefaultNetclass()
nc.SetClearance(FromMM(CLEAR))
nc.SetTrackWidth(FromMM(TRACK))
nc.SetViaDiameter(FromMM(VIA))
nc.SetViaDrill(FromMM(VIA_DRILL))

# ---- router ---------------------------------------------------------------------------------
NX, NY = int(round(W / G)) + 1, int(round(H / G)) + 1
names = sorted(nets)
nid = {n: i for i, n in enumerate(names)}
FREE, BLOCK = -1, -2
tmap = np.full((2, NX, NY), FREE, dtype=np.int16)   # who may put a track centreline here
vmap = np.full((2, NX, NY), FREE, dtype=np.int16)   # who may put a via centre here
R_T = CLEAR + TRACK / 2 + MARGIN
R_V = CLEAR + VIA / 2 + MARGIN


def stamp(layers, owner, dist, bbox, radius):
    x0, y0, x1, y1 = bbox
    i0, i1 = max(0, int((x0 - radius) / G) - 1), min(NX - 1, int((x1 + radius) / G) + 1)
    j0, j1 = max(0, int((y0 - radius) / G) - 1), min(NY - 1, int((y1 + radius) / G) + 1)
    for i in range(i0, i1 + 1):
        x = i * G
        for j in range(j0, j1 + 1):
            if dist(x, j * G) < radius:
                for L, mp in layers:
                    v = mp[L, i, j]
                    if v == FREE:
                        mp[L, i, j] = owner
                    elif v != owner and v != BLOCK:
                        mp[L, i, j] = BLOCK


def add_copper(L_list, owner, dist, bbox):
    stamp([(L, tmap) for L in L_list], owner, dist, bbox, R_T)
    stamp([(L, vmap) for L in L_list], owner, dist, bbox, R_V)


def seg_dist(ax, ay, bx, by, hw):
    dx, dy = bx - ax, by - ay
    ll = dx * dx + dy * dy

    def d(x, y):
        t = 0 if ll == 0 else max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / ll))
        return math.hypot(x - (ax + t * dx), y - (ay + t * dy)) - hw
    return d


# board edge and holes: nobody
for i in range(NX):
    for j in range(NY):
        x, y = i * G, j * G
        if x < EDGE_KEEP + TRACK / 2 or y < EDGE_KEEP + TRACK / 2 or x > W - EDGE_KEEP - TRACK / 2 or y > H - EDGE_KEEP - TRACK / 2 \
                or any(math.hypot(x - hx, y - hy) < HOLE_KEEP for hx, hy in LAY['holes']):
            tmap[:, i, j] = BLOCK
            vmap[:, i, j] = BLOCK
        if x < EDGE_KEEP + VIA / 2 or y < EDGE_KEEP + VIA / 2 or x > W - EDGE_KEEP - VIA / 2 or y > H - EDGE_KEEP - VIA / 2:
            vmap[:, i, j] = BLOCK

pads_by_net = {}
pad_cells = {}           # (i, j) -> net id, cells where a THT pad joins both layers
for fp in board.GetFootprints():
    for p in fp.Pads():
        if not p.IsOnCopperLayer():
            continue
        cx, cy = pad_xy(p)
        sx, sy = mm(p.GetSize().x), mm(p.GetSize().y)
        if round(fp.GetOrientationDegrees()) % 180 == 90:
            sx, sy = sy, sx
        owner = nid[p.GetNetname()] if p.GetNetname() else BLOCK
        if p.GetShape() == pcbnew.PAD_SHAPE_CIRCLE:
            dist = (lambda cx, cy, r: lambda x, y: math.hypot(x - cx, y - cy) - r)(cx, cy, sx / 2)
        else:
            dist = (lambda cx, cy, hx, hy: lambda x, y: math.hypot(max(abs(x - cx) - hx, 0), max(abs(y - cy) - hy, 0)))(cx, cy, sx / 2, sy / 2)
        if owner == BLOCK:
            stamp([(0, tmap), (1, tmap)], 30000, dist, (cx - sx / 2, cy - sy / 2, cx + sx / 2, cy + sy / 2), R_T)
            stamp([(0, vmap), (1, vmap)], 30000, dist, (cx - sx / 2, cy - sy / 2, cx + sx / 2, cy + sy / 2), R_V)
        else:
            add_copper([0, 1], owner, dist, (cx - sx / 2, cy - sy / 2, cx + sx / 2, cy + sy / 2))
            cell = (int(round(cx / G)), int(round(cy / G)))
            pads_by_net.setdefault(p.GetNetname(), []).append(((cx, cy), cell))
            pad_cells[cell] = owner

DIRS = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]
VIA_COST = 6.0


def astar(n, sources, targets, goal_xy):
    """sources/targets: sets of (L, i, j). Returns the cell path or None."""
    gi, gj = goal_xy

    def h(i, j):
        dx, dy = abs(i - gi), abs(j - gj)
        return max(dx, dy) + 0.414 * min(dx, dy)

    ok = lambda L, i, j: 0 <= i < NX and 0 <= j < NY and tmap[L, i, j] in (FREE, n)
    openq, best, came = [], {}, {}
    for s in sources:
        best[s] = 0.0
        came[s] = (None, None)
        heapq.heappush(openq, (h(s[1], s[2]), 0.0, s))
    while openq:
        f, g, cur = heapq.heappop(openq)
        if g > best.get(cur, 1e9) + 1e-9:
            continue
        if cur in targets:
            path = [cur]
            while came[path[-1]][0] is not None:
                path.append(came[path[-1]][0])
            return path[::-1]
        L, i, j = cur
        pdir = came[cur][1]
        for d in DIRS:
            ni, nj = i + d[0], j + d[1]
            if not ok(L, ni, nj):
                continue
            if d[0] and d[1] and not (ok(L, i + d[0], j) and ok(L, i, j + d[1])):
                continue
            step = 1.414 if d[0] and d[1] else 1.0
            # F.Cu prefers horizontal, B.Cu vertical
            if (L == 0 and d[0] == 0) or (L == 1 and d[1] == 0):
                step *= 1.6
            if pdir is not None and pdir != d:
                step += 0.6
            nxt = (L, ni, nj)
            ng = g + step
            if ng < best.get(nxt, 1e9):
                best[nxt] = ng
                came[nxt] = (cur, d)
                heapq.heappush(openq, (ng + h(ni, nj), ng, nxt))
        # layer change: free in a THT pad of this net, a via elsewhere
        nxt = (1 - L, i, j)
        if pad_cells.get((i, j)) == n:
            cost = 0.0
        elif vmap[0, i, j] in (FREE, n) and vmap[1, i, j] in (FREE, n):
            cost = VIA_COST
        else:
            continue
        ng = g + cost
        if ng < best.get(nxt, 1e9):
            best[nxt] = ng
            came[nxt] = (cur, None)
            heapq.heappush(openq, (ng + h(i, j), ng, nxt))
    return None


def commit(n, path, routes):
    """Record copper for a found path: stamp the maps, remember segments and vias."""
    for a, b in zip(path, path[1:]):
        if a[0] == b[0]:
            ax, ay, bx, by = a[1] * G, a[2] * G, b[1] * G, b[2] * G
            add_copper([a[0]], n, seg_dist(ax, ay, bx, by, TRACK / 2), (min(ax, bx), min(ay, by), max(ax, bx), max(ay, by)))
        elif pad_cells.get((a[1], a[2])) != n:
            x, y = a[1] * G, a[2] * G
            add_copper([0, 1], n, (lambda x, y: lambda px, py: math.hypot(px - x, py - y) - VIA / 2)(x, y), (x, y, x, y))
    routes.append(path)


ORDER = ['OE', 'HORN', 'GPA1', 'GPA2', 'GPA3', 'GPA4', 'GPA5', 'GPA6', 'ST_R', 'ST_G', 'ST_B',
         'LK_R', 'LK_G', 'LK_B', 'BTN1', 'BTN2', '5V', 'SDA', 'SCL', '3V3', 'GND']
assert sorted(ORDER) == sorted(pads_by_net), (sorted(ORDER), sorted(pads_by_net))

all_routes = {}
failed = []
for name in ORDER:
    n = nid[name]
    pads = pads_by_net[name]
    done = [pads[0]]
    tree = {(L, pads[0][1][0], pads[0][1][1]) for L in (0, 1)}
    todo = pads[1:]
    routes = []
    while todo:
        # Prim: the unconnected pad nearest to anything already connected
        k = min(range(len(todo)), key=lambda q: min(math.dist(todo[q][0], d[0]) for d in done))
        pad = todo.pop(k)
        near = min(done, key=lambda d: math.dist(pad[0], d[0]))
        src = {(L, pad[1][0], pad[1][1]) for L in (0, 1)}
        path = astar(n, src, tree, near[1])
        if path is None:
            failed.append((name, pad[0]))
            continue
        commit(n, path, routes)
        tree |= set(path)
        tree |= {(L, pad[1][0], pad[1][1]) for L in (0, 1)}
        done.append(pad)
    all_routes[name] = routes
    print(f'{name:5s} {len(pads):2d} pads, {len(routes)} links', file=sys.stderr)

if failed:
    print('UNROUTED:', failed, file=sys.stderr)

# ---- write tracks and vias ------------------------------------------------------------------
pad_center = {}
for name, plist in pads_by_net.items():
    for xy, cell in plist:
        pad_center[cell] = xy


def add_track(L, a, b, n):
    if math.dist(a, b) < 1e-6:
        return
    t = pcbnew.PCB_TRACK(board)
    t.SetStart(VECTOR2I(FromMM(a[0]), FromMM(a[1])))
    t.SetEnd(VECTOR2I(FromMM(b[0]), FromMM(b[1])))
    t.SetWidth(FromMM(TRACK))
    t.SetLayer(pcbnew.F_Cu if L == 0 else pcbnew.B_Cu)
    t.SetNet(net(n))
    board.Add(t)


def add_via(xy, n):
    v = pcbnew.PCB_VIA(board)
    v.SetPosition(VECTOR2I(FromMM(xy[0]), FromMM(xy[1])))
    v.SetWidth(pcbnew.F_Cu, FromMM(VIA))
    v.SetDrill(FromMM(VIA_DRILL))
    v.SetNet(net(n))
    board.Add(v)


nvias = 0
for name, routes in all_routes.items():
    n = nid[name]
    # every cell where paths meet stays a vertex, so T-joints land on track ends
    joints = set()
    for path in routes:
        joints.add((path[0][1], path[0][2]))
        joints.add((path[-1][1], path[-1][2]))
    for path in routes:
        runs = []                         # [(layer, [cells...])]
        for c in path:
            if runs and runs[-1][0] == c[0]:
                runs[-1][1].append((c[1], c[2]))
            else:
                if runs and pad_cells.get((c[1], c[2])) != n:
                    add_via((c[1] * G, c[2] * G), name)
                    nvias += 1
                runs.append((c[0], [(c[1], c[2])]))
        for L, cells in runs:
            if len(cells) < 2:
                continue
            pts = [cells[0]]
            for k in range(1, len(cells) - 1):
                a, b, c = pts[-1], cells[k], cells[k + 1]
                d1 = (b[0] - a[0], b[1] - a[1])
                d2 = (c[0] - b[0], c[1] - b[1])
                straight = d1[0] * d2[1] - d1[1] * d2[0] == 0 and d1[0] * d2[0] + d1[1] * d2[1] > 0
                if not straight or b in joints:
                    pts.append(b)
            pts.append(cells[-1])
            xy = [(i * G, j * G) for i, j in pts]
            for a, b in zip(xy, xy[1:]):
                add_track(L, a, b, name)
            # tails into the exact pad centres
            for end in (pts[0], pts[-1]):
                if end in pad_center and pad_cells.get(end) == n:
                    add_track(L, (end[0] * G, end[1] * G), pad_center[end], name)

print(f'vias: {nvias}', file=sys.stderr)
pcbnew.SaveBoard(OUT, board)
print('wrote', OUT)
sys.exit(1 if failed else 0)
