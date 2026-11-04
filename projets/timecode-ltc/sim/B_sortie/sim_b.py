"""Simulation B : circuit de sortie LTC (mode RX).

La GPIO5 de l'ESP32 (modèle de broche calé sur la fiche) produit le LTC logique
biphase. Il traverse la mise en forme R10/R11/R12/C5 (front 25 µs), le suiveur
TLV9061, l'impédance de sortie R13 + R14 (78 ohms), la liaison C7//C8, puis
l'inverseur en position RX jusqu'à la BNC.
On teste plusieurs charges, on mesure niveau, fronts, inclinaison, et on décode
le signal obtenu sur la BNC. B9 reboucle la sortie, à travers 10 m de câble, sur
le circuit d'entrée d'un second boîtier en mode TX.
"""
import json
import os
import re
import sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from common import run, include, FIG, GEN, rise_time  # noqa: E402
import ltc  # noqa: E402

OUT = os.path.dirname(os.path.abspath(__file__))
VDD = 3.3
NFRAMES = 6
PREROLL = 2e-3
CABLE_PF_PER_M = 67  # RG-59 typique

CASES = [
    # nom, description, charge (ohms), câble (m), cadence
    ("B1", "Entrée Sony TC IN (10 kohms) + 10 m de RG-59", 10e3, 10, "25"),
    ("B2", "Charge 75 ohms (terminaison vidéo)", 75, 1, "25"),
    ("B3", "MixPre TC IN (20 kohms), 30 i/s", 20e3, 2, "30"),
    ("B4", "À vide (1 Mohm), 24 i/s", 1e6, 1, "24"),
    ("B5", "Entrée audio 600 ohms, 29,97 DF", 600, 2, "29.97DF"),
    ("B6", "10 kohms au bout de 100 m de RG-59 (6,7 nF)", 10e3, 100, "30"),
]


def rename(inc_path, prefix, keep=("0", "v3v3a", "v3v3", "mode_tx", "mode_rx")):
    """Copie d'un sous-circuit généré avec des nœuds préfixés (second boîtier)."""
    out = []
    for line in open(inc_path).read().splitlines():
        if not line or line.startswith("*"):
            out.append(line)
            continue
        w = line.split()
        name = w[0]
        kind = name[0].upper()
        nn = {"R": 2, "C": 2, "L": 2, "D": 2, "S": 4, "X": len(w) - 2}.get(kind, 2)
        # X : tous les champs sauf le nom du sous-circuit (et ses paramètres)
        if kind == "X":
            nodes_end = next(i for i, x in enumerate(w[1:], 1) if not re.match(r"^[a-z0-9_]+$", x) or x.isupper() or "=" in x)
            nn = nodes_end - 1
        nodes = [x if x in keep else prefix + x for x in w[1:1 + nn]]
        out.append(" ".join([name[0] + prefix + name[1:]] + nodes + w[1 + nn:]))
    return "\n".join(out)


def stimulus(name, rate):
    fps, nominal, drop = ltc.RATES[rate]
    tc0 = (10, 9, 59, nominal - 3) if drop else (12, 34, 56, 0)
    bits, tcs, tb = ltc.frames_bits(tc0, NFRAMES, rate)
    edges, _ = ltc.biphase(bits, tb, t0=PREROLL)
    t_end = PREROLL + NFRAMES * 80 * tb + 2e-3
    pwl = os.path.join(OUT, f"{name.lower()}_gpio.pwl")
    ltc.pwl_logic(pwl, edges, 1.0, t_end)  # commande 0/1 de la broche
    return tcs, tb, edges, t_end, pwl, drop


def gpio_src(pwl):
    return f"""Actl %vd([ctl 0]) ctlmod
.model ctlmod filesource (file="{os.path.basename(pwl)}" amploffset=[0] amplscale=[1] timeoffset=0 timescale=1 timerelative=false amplstep=false)
* GPIO5 en entrée (haute impédance) tant que le LTC n'est pas généré : la
* liaison C7//C8 est alors pré-chargée à VCC/2 par R11/R12 (voir rapport)
Voe oe 0 pwl(0 0 {PREROLL - 0.2e-3} 0 {PREROLL - 0.2e-3 + 1e-6} 1)
XG ltc_tx_gpio v3v3 0 ctl oe ESP_GPIO_OUT"""


def run_case(c):
    name, desc, rl, cable_m, rate = c
    tcs, tb, edges, t_end, pwl, drop = stimulus(name, rate)
    ccab = cable_m * CABLE_PF_PER_M * 1e-12
    body = f"""
{include('bnc', 'sortie')}
Va v3v3a 0 {VDD}
Vd v3v3 0 {VDD}
Vmtx mode_tx 0 0
Vmrx mode_rx 0 1
{gpio_src(pwl)}
* Chemin d'entrée, isolé en RX : R1 seule reste sur son contact
Rin_idle ltc_in_raw 0 1Meg
* Câble (capacité répartie ramenée en deux moitiés autour de 0,1 ohm/m)
Cc1 bnc_c 0 {ccab/2}
Rcab bnc_c far {0.1*cable_m}
Cc2 far 0 {ccab/2}
Rload far 0 {rl}
"""
    vecs = ["v(bnc_c)", "v(far)", "v(out_sh)", "v(opa_out)", "v(ltc_tx_gpio)", "i(va)", "v(out_p)"]
    r = run(name, OUT, body, vecs, f"tran 0.5u {t_end} 0 0.5u")
    return analyse(name, desc, r, tcs, tb, drop, rl, cable_m, rate)


def analyse(name, desc, r, tcs, tb, drop, rl, cable_m, rate, node="v(far)"):
    t = r["x"]
    v = r[node]
    t_settle = PREROLL + 80 * tb
    m = t > t_settle
    vpp = float(np.percentile(v[m], 99.5) - np.percentile(v[m], 0.5))
    dc = float(v[m].mean())
    tr, tf = rise_time(t[m], v[m])
    dig = ltc.crossings(t, v, 0.02 * vpp, -0.02 * vpp)
    frames = ltc.decode_edges(dig)
    got = [f["tc"] for f in frames]
    valid = [g for g in got if g in tcs]
    seq_ok = bool(got) and got[0] in tcs and got == tcs[tcs.index(got[0]):tcs.index(got[0]) + len(got)]
    # inclinaison : chute relative du plateau sur un bit 0 (palier le plus long)
    dd = np.array(dig)
    tilts = []
    for a, b in zip(dd[:-1], dd[1:]):
        if a > t_settle and (b - a) > 0.75 * tb:
            i0 = np.searchsorted(t, a + 0.15 * tb)
            i1 = np.searchsorted(t, b - 0.02 * tb)
            if i1 > i0:
                tilts.append(abs(v[i0] - v[i1]) / (vpp / 2))
    i_opa = (r["v(opa_out)"] - r["v(out_p)"]) / 56.0
    res = dict(name=name, desc=desc, load=rl, cable_m=cable_m, rate=rate,
               vpp=vpp, dc_offset=dc, rise_us=tr * 1e6, fall_us=tf * 1e6,
               tilt_pct=float(np.median(tilts) * 100) if tilts else None,
               frames_decoded=len(got), frames_valid=len(valid), sequence_ok=bool(seq_ok),
               first=ltc.fmt_tc(got[0], drop) if got else None, last=ltc.fmt_tc(got[-1], drop) if got else None,
               i_opa_peak_mA=float(np.abs(i_opa[m]).max() * 1e3),
               i_supply_mA=float(-r["i(va)"][m].mean() * 1e3),
               opa_min=float(r["v(opa_out)"][m].min()), opa_max=float(r["v(opa_out)"][m].max()))
    res["pass"] = bool(seq_ok and len(valid) >= NFRAMES - 3 and len(valid) == len(got)
                       and 15 <= res["rise_us"] <= 35 and abs(dc) < 0.05 * vpp)
    plot(name, desc, r, tb, t_settle, res, node)
    return res


def plot(name, desc, r, tb, t_settle, res, node):
    t = r["x"] * 1e3
    w0 = t_settle * 1e3
    w1 = w0 + 12 * tb * 1e3
    m = (t >= w0) & (t <= w1)
    fig, ax = plt.subplots(2, 1, figsize=(10, 5.5), sharex=True)
    ax[0].plot(t[m], r["v(ltc_tx_gpio)"][m], lw=0.8, color="#7f8c8d", label="GPIO5 (logique)")
    ax[0].plot(t[m], r["v(out_sh)"][m], lw=0.8, color="#e67e22", label="après mise en forme (IN+ AOP)")
    ax[0].set_ylabel("V")
    ax[0].legend(fontsize=8, loc="upper right")
    ax[0].set_title(f"{name} : {desc}", fontsize=10)
    ax[1].plot(t[m], r[node][m], lw=0.9, color="#3b6ea8", label="entrée de l'équipement")
    ax[1].set_ylabel("V")
    ax[1].set_xlabel("temps (ms) - 12 bits")
    ax[1].text(0.01, 0.06, f"{res['vpp']:.2f} Vcc, front 10-90 % {res['rise_us']:.1f} µs, "
               f"{res['frames_valid']} images décodées ({res['first']} -> {res['last']}) : "
               f"{'OK' if res['pass'] else 'ECHEC'}", transform=ax[1].transAxes, fontsize=8,
               bbox=dict(fc="white", ec="0.7"))
    for a in ax:
        a.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(os.path.join(FIG, f"sim{name}.png"), dpi=110)
    plt.close(fig)


def loopback():
    """B9 : boîtier RX -> 10 m de RG-59 -> boîtier TX (circuit d'entrée complet)."""
    name, rate = "B9", "25"
    tcs, tb, edges, t_end, pwl, drop = stimulus(name, rate)
    second = rename(os.path.join(GEN, "bnc.inc"), "b2_") + "\n" + rename(os.path.join(GEN, "entree.inc"), "b2_")
    # le second boîtier est en TX : on inverse ses commandes d'inverseur
    second = second.replace(" mode_tx 0 SWCONT", " mode_rx 0 SWCONT_TMP").replace(" mode_rx 0 SWCONT\n", " mode_tx 0 SWCONT\n")
    second = second.replace("SWCONT_TMP", "SWCONT")
    open(os.path.join(OUT, "boitier2_tx.inc"), "w").write(second + "\n")
    body = f"""
{include('bnc', 'sortie')}
.include boitier2_tx.inc
Va v3v3a 0 {VDD}
Vd v3v3 0 {VDD}
Vmtx mode_tx 0 0
Vmrx mode_rx 0 1
{gpio_src(pwl)}
Rin_idle ltc_in_raw 0 1Meg
Cc1 bnc_c 0 335p
Rcab bnc_c b2_bnc_c 1
Cc2 b2_bnc_c 0 335p
Rb2_idle b2_ltc_out_bnc 0 100k
XESP2 b2_ltc_rx_gpio v3v3 0 ESP_GPIO_IN
"""
    vecs = ["v(bnc_c)", "v(b2_bnc_c)", "v(out_sh)", "v(opa_out)", "v(ltc_tx_gpio)", "i(va)", "v(out_p)",
            "v(b2_ltc_rx_gpio)", "v(b2_cmp_inn)", "v(b2_cmp_inp)"]
    r = run(name, OUT, body, vecs, f"tran 0.5u {t_end} 0 0.5u")
    t = r["x"]
    dig = ltc.crossings(t, r["v(b2_ltc_rx_gpio)"], VDD / 2)
    frames = ltc.decode_edges(dig)
    got = [f["tc"] for f in frames]
    # écart temporel bout à bout : transitions GPIO5 (RX) -> GPIO4 (TX)
    d_in = np.array(edges)
    d_out = np.array(dig)
    lat = []
    for e in d_out[d_out > PREROLL + 80 * tb]:
        k = np.searchsorted(d_in, e) - 1
        if k >= 0:
            lat.append(e - d_in[k])
    lat = np.array(lat)
    res = dict(name=name, desc="Boucle RX -> 10 m RG-59 -> entrée d'un boîtier TX",
               vpp_bnc=float(np.ptp(r["v(b2_bnc_c)"][t > PREROLL + 160 * tb])),
               frames_decoded=len(got), frames_valid=len([g for g in got if g in tcs]),
               first=ltc.fmt_tc(got[0]) if got else None, last=ltc.fmt_tc(got[-1]) if got else None,
               latency_mean_us=float(lat.mean() * 1e6), latency_pp_us=float(np.ptp(lat) * 1e6))
    res["pass"] = res["frames_valid"] >= NFRAMES - 2 and res["frames_valid"] == res["frames_decoded"]
    tt = t * 1e3
    w0 = (PREROLL + 2 * 80 * tb) * 1e3
    m = (tt > w0) & (tt < w0 + 10 * tb * 1e3)
    fig, ax = plt.subplots(3, 1, figsize=(10, 6.5), sharex=True)
    ax[0].plot(tt[m], r["v(ltc_tx_gpio)"][m], lw=0.8, color="#7f8c8d")
    ax[0].set_ylabel("GPIO5 RX (V)")
    ax[0].set_title("B9 : sortie d'un boîtier RX rebouclée sur l'entrée d'un boîtier TX (10 m)", fontsize=10)
    ax[1].plot(tt[m], r["v(b2_bnc_c)"][m], lw=0.8, color="#3b6ea8")
    ax[1].set_ylabel("BNC (V)")
    ax[2].plot(tt[m], r["v(b2_ltc_rx_gpio)"][m], lw=0.8, color="#27ae60")
    ax[2].set_ylabel("GPIO4 TX (V)")
    ax[2].set_xlabel("temps (ms)")
    ax[2].text(0.01, 0.4, f"{res['frames_valid']} images décodées ({res['first']} -> {res['last']}), "
               f"retard bout à bout {res['latency_mean_us']:.1f} µs", transform=ax[2].transAxes, fontsize=8,
               bbox=dict(fc="white", ec="0.7"))
    for a in ax:
        a.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(os.path.join(FIG, "simB9_boucle.png"), dpi=110)
    plt.close(fig)
    return res


def faults():
    """B7 : court-circuit franc sur la BNC ; B8 : une autre sortie timecode (3 Vcc /
    1 kohm, type MixPre) branchée par erreur sur la sortie, en opposition."""
    out = {}
    tcs, tb, edges, t_end, pwl, drop = stimulus("B7", "25")
    for name, load in (("B7", "Rshort bnc_c 0 0.01"),
                       ("B8", "Vext ext 0 sin(0 1.5 1.9k)\nRext ext bnc_c 1k")):
        body = f"""
{include('bnc', 'sortie')}
Va v3v3a 0 {VDD}
Vd v3v3 0 {VDD}
Vmtx mode_tx 0 0
Vmrx mode_rx 0 1
{gpio_src(pwl)}
Rin_idle ltc_in_raw 0 1Meg
{load}
"""
        vecs = ["v(bnc_c)", "v(opa_out)", "v(out_p)", "i(va)"]
        r = run(name, OUT, body, vecs, f"tran 1u {min(t_end, 0.1)} 0 1u")
        t = r["x"]
        m = t > 0.03
        i_opa = (r["v(opa_out)"] - r["v(out_p)"]) / 56.0
        out[name] = dict(i_opa_peak_mA=float(np.abs(i_opa[m]).max() * 1e3),
                         v_outp_min=float(r["v(out_p)"][m].min()), v_outp_max=float(r["v(out_p)"][m].max()),
                         i_supply_mA=float(-r["i(va)"][m].mean() * 1e3),
                         p_r13_mW=float(np.mean((i_opa[m]) ** 2) * 56 * 1e3))
    return out


if __name__ == "__main__":
    results = [run_case(c) for c in CASES]
    lb = loopback()
    fl = faults()
    # impédance de sortie déduite de la mesure à vide et sous 75 ohms
    v_open = next(x["vpp"] for x in results if x["name"] == "B4")
    v_75 = next(x["vpp"] for x in results if x["name"] == "B2")
    zout = 75 * (v_open / v_75 - 1)
    json.dump(dict(cases=results, boucle=lb, defauts=fl, zout_ohms=zout), open(os.path.join(OUT, "resultats.json"), "w"),
              indent=1, ensure_ascii=False)
    for x in results:
        print({k: (round(v, 3) if isinstance(v, float) else v) for k, v in x.items() if k != "desc"})
    print(lb)
    print(fl)
    print("Zout =", round(zout, 1), "ohms")
