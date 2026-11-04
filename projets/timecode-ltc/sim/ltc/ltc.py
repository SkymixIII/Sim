"""
Codeur / décodeur LTC (SMPTE 12M) de référence, utilisé par les simulations.

- encode_frame()   : 80 bits d'une image (BCD, drapeaux, mot de synchro, bit de polarité)
- biphase()        : modulation biphase-mark -> liste de temps de transition
- pwl_analog()     : fichier PWL ngspice d'un LTC analogique (fronts de durée réglable)
- pwl_logic()      : fichier PWL ngspice du signal logique que produirait une GPIO de l'ESP32
- decode_edges()   : décodeur à partir d'instants de transition (comme le ferait l'ESP32
                     avec une capture matérielle MCPWM sur la sortie du comparateur)
- tc_add()         : comptage d'images, y compris drop-frame 29,97

Références : SMPTE ST 12-1 (structure de trame, telle que décrite par
https://en.wikipedia.org/wiki/Linear_timecode) ; fronts 25 µs ± 5 µs (cités par
US5543976A et philrees.co.uk). Ce module ne dépend que de la bibliothèque standard.
"""
from __future__ import annotations
import math
import random

SYNC = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]  # bits 64..79

RATES = {
    "23.976": (24000 / 1001, 24, False),
    "24": (24.0, 24, False),
    "25": (25.0, 25, False),
    "29.97DF": (30000 / 1001, 30, True),
    "29.97ND": (30000 / 1001, 30, False),
    "30": (30.0, 30, False),
}


def tc_add(tc, n, nominal, drop):
    """Ajoute n images au timecode (h, m, s, f). Gère le drop-frame 29,97."""
    h, m, s, f = tc
    for _ in range(n):
        f += 1
        if f >= nominal:
            f = 0
            s += 1
            if s >= 60:
                s = 0
                m += 1
                if m >= 60:
                    m = 0
                    h = (h + 1) % 24
            if drop and s == 0 and f == 0 and m % 10 != 0:
                f = 2  # on saute les images 00 et 01 sauf toutes les 10 minutes
    return (h, m, s, f)


def _bcd(bits, start, value, width):
    for i in range(width):
        bits[start + i] = (value >> i) & 1


def encode_frame(tc, nominal=25, drop=False, user_bits=0, clock_flag=0):
    h, m, s, f = tc
    b = [0] * 80
    _bcd(b, 0, f % 10, 4)
    _bcd(b, 8, f // 10, 2)
    b[10] = 1 if drop else 0
    _bcd(b, 16, s % 10, 4)
    _bcd(b, 24, s // 10, 3)
    _bcd(b, 32, m % 10, 4)
    _bcd(b, 40, m // 10, 3)
    _bcd(b, 48, h % 10, 4)
    _bcd(b, 56, h // 10, 2)
    for k, pos in enumerate((4, 12, 20, 28, 36, 44, 52, 60)):
        _bcd(b, pos, (user_bits >> (4 * k)) & 0xF, 4)
    b[58] = clock_flag
    b[64:80] = SYNC
    pol = 59 if nominal == 25 else 27
    b[pol] = 0
    zeros = b.count(0)
    if zeros % 2:  # nombre pair de zéros sur la trame complète
        b[pol] = 1
    return b


def biphase(bitstream, bit_period, t0=0.0, level0=0):
    """Biphase-mark : transition à chaque frontière de bit, + une au milieu pour un 1.
    Retourne (liste des instants de transition, niveau initial)."""
    t = t0
    edges = []
    for bit in bitstream:
        edges.append(t)
        if bit:
            edges.append(t + bit_period / 2)
        t += bit_period
    return edges, level0


def frames_bits(tc0, nframes, rate="25"):
    fps, nominal, drop = RATES[rate]
    bits, tcs = [], []
    tc = tc0
    for _ in range(nframes):
        tcs.append(tc)
        bits += encode_frame(tc, nominal, drop)
        tc = tc_add(tc, 1, nominal, drop)
    return bits, tcs, 1.0 / (fps * 80)


def _write_pwl(path, pts):
    with open(path, "w") as fh:
        for t, v in pts:
            fh.write(f"{t:.9e} {v:.6e}\n")


def pwl_analog(path, edges, vpp, rise, t_end, offset=0.0, shape="lin"):
    """LTC analogique symétrique ±vpp/2. 'rise' = temps de montée 10-90 %.
    shape='lin' : rampe linéaire (durée totale rise/0.8) ; 'rc' : premier ordre."""
    lo, hi = offset - vpp / 2, offset + vpp / 2
    level = 0
    pts = [(0.0, lo)]
    if shape == "lin":
        tr = rise / 0.8
        for e in edges:
            a, b = (lo, hi) if level == 0 else (hi, lo)
            pts.append((e, a))
            pts.append((e + tr, b))
            level ^= 1
    else:  # premier ordre, échantillonné
        tau = rise / 2.197
        v = lo
        tgrid = 0.0
        k = 0
        step = tau / 8
        target = lo
        nxt = edges[0] if edges else t_end
        while tgrid < t_end:
            while k < len(edges) and tgrid >= edges[k]:
                target = hi if target == lo else lo
                k += 1
            v = target + (v - target) * math.exp(-step / tau)
            tgrid += step
            pts.append((tgrid, v))
    pts.append((t_end, pts[-1][1]))
    # dédoublonnage (ngspice veut des temps strictement croissants)
    out = []
    for t, v in pts:
        if out and t <= out[-1][0]:
            t = out[-1][0] + 1e-9
        out.append((t, v))
    _write_pwl(path, out)


def pwl_logic(path, edges, vdd, t_end, tr=5e-9):
    """Signal GPIO 0 / VDD avec fronts de 5 ns (sortie push-pull ESP32)."""
    level = 0
    pts = [(0.0, 0.0)]
    for e in edges:
        a, b = (0.0, vdd) if level == 0 else (vdd, 0.0)
        pts.append((e, a))
        pts.append((e + tr, b))
        level ^= 1
    pts.append((t_end, pts[-1][1]))
    _write_pwl(path, pts)


def crossings(t, v, thr_hi, thr_lo=None):
    """Instants de transition d'une forme d'onde échantillonnée, avec hystérésis
    logicielle (thr_lo < thr_hi). Interpolation linéaire."""
    if thr_lo is None:
        thr_lo = thr_hi
    state = v[0] > thr_hi
    out = []
    for i in range(1, len(v)):
        if not state and v[i] > thr_hi:
            a = (thr_hi - v[i - 1]) / (v[i] - v[i - 1]) if v[i] != v[i - 1] else 0
            out.append(t[i - 1] + a * (t[i] - t[i - 1]))
            state = True
        elif state and v[i] < thr_lo:
            a = (thr_lo - v[i - 1]) / (v[i] - v[i - 1]) if v[i] != v[i - 1] else 0
            out.append(t[i - 1] + a * (t[i] - t[i - 1]))
            state = False
    return out


def decode_edges(edges, nominal_bit=None):
    """Décodeur LTC robuste, comme le firmware : on classe chaque intervalle entre
    transitions en demi-bit (court) ou bit (long) avec un seuil adaptatif à 3/4
    de la durée de bit estimée, on reconstitue les bits, on cherche le mot de
    synchro, puis on lit les champs BCD. Retourne une liste de dicts."""
    if len(edges) < 40:
        return []
    iv = [b - a for a, b in zip(edges, edges[1:])]
    if nominal_bit is None:
        nominal_bit = max(sorted(iv)[len(iv) // 2], 1e-6)
        # la médiane peut tomber sur un demi-bit : on prend la plus grande famille
        longs = [x for x in iv if x > 0.75 * max(iv)]
        nominal_bit = sum(longs) / len(longs)
    bit_est = nominal_bit
    bits, bit_t = [], []
    half_pending = None
    errors = 0
    for k, d in enumerate(iv):
        thr = 0.75 * bit_est
        if d > thr:  # bit 0
            if half_pending is not None:
                errors += 1
                half_pending = None
            bits.append(0)
            bit_t.append(edges[k])
            bit_est = 0.9 * bit_est + 0.1 * d
        else:
            if half_pending is None:
                half_pending = edges[k]
            else:
                bits.append(1)
                bit_t.append(half_pending)
                bit_est = 0.9 * bit_est + 0.1 * (d + (edges[k] - half_pending))
                half_pending = None
    frames = []
    n = len(bits)
    i = 0
    while i + 16 <= n:
        if bits[i:i + 16] == SYNC and i >= 64:
            fb = bits[i - 64:i + 16]

            def val(st, w):
                return sum(fb[st + j] << j for j in range(w))

            frames.append({
                "tc": (val(56, 2) * 10 + val(48, 4), val(40, 3) * 10 + val(32, 4),
                       val(24, 3) * 10 + val(16, 4), val(8, 2) * 10 + val(0, 4)),
                "drop": fb[10],
                "t_start": bit_t[i - 64],
                "t_sync_end": bit_t[i + 15] + bit_est if i + 15 < len(bit_t) else None,
                "even_zeros": fb.count(0) % 2 == 0,
            })
            i += 16
        else:
            i += 1
    return frames


def fmt_tc(tc, drop=False):
    sep = ";" if drop else ":"
    return f"{tc[0]:02d}:{tc[1]:02d}:{tc[2]:02d}{sep}{tc[3]:02d}"


if __name__ == "__main__":
    # auto-test : codage -> biphase -> décodage, toutes cadences
    random.seed(1)
    for rate in RATES:
        fps, nominal, drop = RATES[rate]
        tc0 = (10, 9, 59, nominal - 3) if drop else (1, 2, 3, 4)
        bits, tcs, tb = frames_bits(tc0, 6, rate)
        edges, _ = biphase(bits, tb)
        jit = [e + random.gauss(0, 3e-6) for e in edges]  # 3 µs de gigue
        fr = decode_edges(jit)
        got = [f["tc"] for f in fr]
        ok = got == tcs[:len(got)] and len(got) >= 5 and all(f["even_zeros"] for f in fr)
        print(f"{rate:8s} bit={tb*1e6:7.2f} µs  {len(got)} images  "
              f"{fmt_tc(got[0], drop)} -> {fmt_tc(got[-1], drop)}  {'OK' if ok else 'ECHEC'}")
    # drop-frame : 00:00:59;29 -> 00:01:00;02
    assert tc_add((0, 0, 59, 29), 1, 30, True) == (0, 1, 0, 2)
    assert tc_add((0, 9, 59, 29), 1, 30, True) == (0, 10, 0, 0)
    print("drop-frame OK")
