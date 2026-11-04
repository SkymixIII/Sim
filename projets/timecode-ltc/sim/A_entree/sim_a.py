"""Simulation A : circuit d'entrée LTC (mode TX).

Un vrai LTC (trames SMPTE complètes, mot de synchro, bit de polarité) est
généré par ltc.py, appliqué sur la BNC à travers l'impédance de sortie de la
source, puis traverse : TVS -> inverseur TX/RX (position TX) -> C1/R2/BAT54S/
C2/R3/R4 -> TLV3201 avec hystérésis -> R9 -> broche ESP32.
La sortie du comparateur est ensuite décodée par le même algorithme que le
firmware : une simulation n'est déclarée réussie que si chaque image décodée
porte exactement le timecode émis.
"""
import json
import os
import sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from common import run, include, FIG  # noqa: E402
import ltc  # noqa: E402

OUT = os.path.dirname(os.path.abspath(__file__))
VDD = 3.3
VIH, VIL = 0.75 * VDD, 0.25 * VDD

CASES = [
    # nom, description, Vcc, Rsource, cadence, front 10-90 %, forme, bruit rms, ronflement 50 Hz crête-crête, offset DC
    ("A1", "Sony TC OUT typique : 1 Vcc / 50 ohms, 25 i/s", 1.0, 50, "25", 25e-6, "lin", 0.0, 0.0, 0.0),
    ("A2", "Niveau faible 0,3 Vcc / 1 kohm, 30 i/s, bruit 10 mV rms + 50 Hz 50 mVcc", 0.3, 1000, "30", 25e-6, "lin", 10e-3, 50e-3, 0.0),
    ("A3", "Niveau maximal Sony 18 Vcc / 50 ohms, 24 i/s", 18.0, 50, "24", 25e-6, "lin", 0.0, 0.0, 0.0),
    ("A4", "MixPre TC OUT : 3 Vcc / 1 kohm, 29,97 DF", 3.0, 1000, "29.97DF", 25e-6, "lin", 0.0, 0.0, 0.0),
    ("A5", "Fronts lents hors norme (60 µs, 1er ordre), 0,5 Vcc, 25 i/s", 0.5, 600, "25", 60e-6, "rc", 5e-3, 0.0, 0.0),
    ("A6", "Signal carré rapide (1 µs), 2 Vcc / 50 ohms, 30 i/s", 2.0, 50, "30", 1e-6, "lin", 0.0, 0.0, 0.0),
    ("A7", "Source à couplage continu : 1 Vcc + 5 V DC, 25 i/s", 1.0, 50, "25", 25e-6, "lin", 0.0, 0.0, 5.0),
]

NFRAMES = 6  # la 1re image sert à l'acquisition, la dernière n'a pas de front de fin
PREROLL = 1e-3


def entree_inc(vos):
    """Copie de gen/entree.inc avec un offset de comparateur imposé."""
    src = open(os.path.join(OUT, "..", "gen", "entree.inc")).read()
    path = os.path.join(OUT, f"entree_vos{int(round(vos*1e3)):+d}mV.inc")
    open(path, "w").write(src.replace(" TLV3201\n", f" TLV3201 VOS={vos}\n"))
    return path


def run_case(c, vos=1e-3, plot_it=True):
    name, desc, vpp, rs, rate, rise, shape, noise, hum, dc = c
    fps, nominal, drop = ltc.RATES[rate]
    tc0 = (10, 9, 59, nominal - 3) if drop else (12, 34, 56, 0)
    bits, tcs, tb = ltc.frames_bits(tc0, NFRAMES, rate)
    edges, _ = ltc.biphase(bits, tb, t0=PREROLL)
    t_end = PREROLL + NFRAMES * 80 * tb + 2e-3
    pwl = os.path.join(OUT, f"{name.lower()}_src.pwl")
    ltc.pwl_analog(pwl, edges, vpp, rise, t_end, offset=dc, shape=shape)
    noise_src = f"Vnoise n_src2 n_src3 dc 0 trnoise({noise} 1u 0 0)" if noise else "Vnoise n_src2 n_src3 0"
    hum_src = f"Vhum n_src3 0 dc 0 sin(0 {hum/2} 50)" if hum else "Vhum n_src3 0 0"
    body = f"""
{include('bnc')}
.include {os.path.basename(entree_inc(vos))}
* Alimentation analogique idéale (l'alimentation réelle est vérifiée en D)
Va v3v3a 0 {VDD}
Vmtx mode_tx 0 1
Vmrx mode_rx 0 0
* Source LTC : f.é.m. PWL + bruit + ronflement, impédance de sortie Rs
Asig %vd([n_src n_src2]) srcmod
.model srcmod filesource (file="{os.path.basename(pwl)}" amploffset=[0] amplscale=[1] timeoffset=0 timescale=1 timerelative=false amplstep=false)
{noise_src}
{hum_src}
Rsrc n_src bnc_c {rs}
* Câble 10 m RG-59 ramené à sa capacité (67 pF/m) : négligeable à 2,4 kHz
Ccable bnc_c 0 670p
* Chemin de sortie, inactif en TX : terminaison de décharge seule
Rout_idle ltc_out_bnc 0 100k
* Broche ESP32 (entrée)
Vd v3v3 0 {VDD}
XESP ltc_rx_gpio v3v3 0 ESP_GPIO_IN
"""
    vecs = ["v(bnc_c)", "v(in_a)", "v(cmp_inn)", "v(cmp_inp)", "v(ltc_rx_gpio)", "i(va)", "v(in_ac)"]
    r = run(name, OUT, body, vecs, f"tran 0.5u {t_end} 0 0.5u")
    t = r["x"]
    g = r["v(ltc_rx_gpio)"]
    dig = ltc.crossings(t, g, VDD / 2)
    frames = ltc.decode_edges(dig)
    got = [f["tc"] for f in frames]
    # alignement : on cherche la séquence attendue
    ok_frames = [tc for tc in got if tc in tcs]
    seq_ok = len(got) > 0 and got == tcs[tcs.index(got[0]):tcs.index(got[0]) + len(got)] if got and got[0] in tcs else False
    # niveaux logiques en régime établi (après la première image)
    t_settle = PREROLL + 80 * tb
    m = t > t_settle
    # niveaux échantillonnés au milieu de chaque palier (entre deux transitions)
    dd = np.array(dig)
    mids = (dd[1:] + dd[:-1]) / 2
    mids = mids[mids > t_settle]
    gv = np.interp(mids, t, g)
    gh = gv[gv > VDD / 2]
    gl = gv[gv < VDD / 2]
    # retard et gigue : transitions logiques vs instants de croisement du zéro idéal
    ideal = np.array(edges) + (rise / 0.8) / 2 if shape == "lin" else np.array(edges) + rise / 2.197 * np.log(2)
    dig_a = np.array(dig)
    delays = []
    for e in dig_a[dig_a > t_settle]:
        k = np.searchsorted(ideal, e)
        cands = [ideal[j] for j in (k - 1, k) if 0 <= j < len(ideal)]
        if cands:
            delays.append(e - min(cands, key=lambda x: abs(e - x)))
    delays = np.array(delays)
    # courant dans R2 (écrêtage)
    i_r2 = (r["v(in_ac)"] - r["v(in_a)"]) / 10e3
    res = dict(
        name=name, desc=desc, vpp=vpp, rs=rs, rate=rate,
        frames_expected=NFRAMES, frames_decoded=len(got), frames_valid=len(ok_frames),
        sequence_ok=bool(seq_ok),
        first=ltc.fmt_tc(got[0], drop) if got else None, last=ltc.fmt_tc(got[-1], drop) if got else None,
        voh_min=float(gh.min()) if len(gh) else None, vol_max=float(gl.max()) if len(gl) else None,
        delay_mean_us=float(delays.mean() * 1e6) if len(delays) else None,
        delay_pp_us=float(np.ptp(delays) * 1e6) if len(delays) else None,
        half_bit_us=tb / 2 * 1e6,
        i_clamp_max_mA=float(np.abs(i_r2).max() * 1e3),
        v_inn_min=float(r["v(cmp_inn)"].min()), v_inn_max=float(r["v(cmp_inn)"].max()),
        i_supply_mA=float(-r["i(va)"][m].mean() * 1e3),
    )
    res["pass"] = bool(res["frames_valid"] >= NFRAMES - 2 and res["sequence_ok"]
                       and res["frames_valid"] == res["frames_decoded"]
                       and res["voh_min"] and res["voh_min"] > VIH and res["vol_max"] < VIL
                       and -0.5 < res["v_inn_min"] and res["v_inn_max"] < VDD + 0.5)
    res['vos_mV'] = vos * 1e3
    if plot_it:
        plot(name, desc, r, tb, t_settle, res)
    return res


def plot(name, desc, r, tb, t_settle, res):
    t = r["x"] * 1e3
    fig, ax = plt.subplots(3, 1, figsize=(10, 7.5), sharex=False)
    w0 = t_settle * 1e3
    w1 = w0 + 80 * tb * 1e3
    m = (t >= w0) & (t <= w1)
    ax[0].plot(t[m], r["v(bnc_c)"][m], lw=0.8, color="#3b6ea8")
    ax[0].set_ylabel("BNC (V)")
    ax[0].set_title(f"{name} : {desc}", fontsize=10)
    ax[1].plot(t[m], r["v(cmp_inn)"][m], lw=0.8, color="#c0392b", label="IN- (signal)")
    ax[1].plot(t[m], r["v(cmp_inp)"][m], lw=0.8, color="#7f8c8d", label="IN+ (seuil + hystérésis)")
    ax[1].set_ylabel("Comparateur (V)")
    ax[1].legend(loc="upper right", fontsize=8)
    ax[2].plot(t[m], r["v(ltc_rx_gpio)"][m], lw=0.8, color="#27ae60")
    ax[2].axhline(VIH, ls="--", lw=0.6, color="k")
    ax[2].axhline(VIL, ls="--", lw=0.6, color="k")
    ax[2].set_ylabel("GPIO4 (V)")
    ax[2].set_xlabel("temps (ms) - une image complète")
    verdict = "OK" if res["pass"] else "ECHEC"
    ax[2].text(0.01, 0.5, f"{res['frames_valid']}/{res['frames_expected']} images décodées "
               f"({res['first']} -> {res['last']}) : {verdict}", transform=ax[2].transAxes,
               fontsize=8, bbox=dict(fc="white", ec="0.7"))
    for a in ax:
        a.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(os.path.join(FIG, f"sim{name}.png"), dpi=110)
    plt.close(fig)


def sweep_threshold():
    """Amplitude minimale décodée, offset du comparateur au pire (+/-3 mV, fiche)."""
    out = []
    for vos in (-3e-3, 3e-3):
        for vpp in (0.05, 0.07, 0.09, 0.12):
            c = (f"S{int(vpp*1000)}{'p' if vos > 0 else 'm'}", "seuil", vpp, 1000, "25", 25e-6, "lin", 2e-3, 0.0, 0.0)
            r = run_case(c, vos=vos, plot_it=False)
            out.append(dict(vos_mV=vos * 1e3, vpp=vpp, decoded=r["frames_valid"], ok=r["pass"]))
            for ext in (".cir", ".log"):
                p = os.path.join(OUT, c[0] + ext)
                if os.path.exists(p):
                    os.remove(p)
            os.remove(os.path.join(OUT, c[0].lower() + "_src.pwl"))
    return out


def faults():
    """Défauts de branchement : (1) branchement à chaud d'une source 12 V continue
    (50 ohms) puis débranchement, (2) sinusoïde 30 Vcc à 2 kHz (sous le seuil de
    la TVS), (3) pointe 24 V / 50 ohms pendant 1 ms (au-delà de VBR de la TVS)."""
    body = f"""
{include('bnc', 'entree')}
Va v3v3a 0 3.3
Vmtx mode_tx 0 1
Vmrx mode_rx 0 0
Rout_idle ltc_out_bnc 0 100k
Vf1 f1 0 pwl(0 0 1m 0 1.001m 12 30m 12 30.001m 0)
Vf2 f2 0 sin(0 15 2k 40m)
Vf3 f3 0 pwl(0 0 70m 0 70.01m 24 71m 24 71.01m 0)
Bsum fsum 0 V = V(f1) + V(f2)*(time > 40m && time < 60m ? 1 : 0) + V(f3)
Rsrc fsum bnc_c 50
"""
    r = run("A9_defauts", OUT, body, ["v(bnc_c)", "v(in_a)", "v(cmp_inn)", "v(cmp_out)", "i(va)", "v(in_ac)", "v(ltc_in_raw)"],
            "tran 2u 80m 0 2u")
    t = r["x"]
    i_r2 = (r["v(in_ac)"] - r["v(in_a)"]) / 10e3
    i_tvs = (r["v(bnc_c)"] * 0)  # placeholder
    seg = lambda a, b: (t >= a) & (t < b)
    res = {}
    for k, (a, b) in {"branchement_12V": (0.5e-3, 40e-3), "sinus_30Vcc": (40e-3, 60e-3), "pointe_24V": (69e-3, 80e-3)}.items():
        m = seg(a, b)
        res[k] = dict(v_bnc_max=float(r["v(bnc_c)"][m].max()), v_bnc_min=float(r["v(bnc_c)"][m].min()),
                      i_clamp_max_mA=float(np.abs(i_r2[m]).max() * 1e3),
                      v_inn_min=float(r["v(cmp_inn)"][m].min()), v_inn_max=float(r["v(cmp_inn)"][m].max()),
                      i_rail_injecte_mA=float(max(0, r["i(va)"][m].max()) * 1e3))
    fig, ax = plt.subplots(2, 1, figsize=(10, 5.5), sharex=True)
    ax[0].plot(t * 1e3, r["v(bnc_c)"], lw=0.8, label="BNC")
    ax[0].set_ylabel("V")
    ax[0].legend(fontsize=8)
    ax[0].set_title("A9 : défauts (12 V DC à chaud, 30 Vcc, pointe 24 V)", fontsize=10)
    ax[1].plot(t * 1e3, r["v(cmp_inn)"], lw=0.8, color="#c0392b", label="IN- comparateur")
    ax[1].axhline(-0.5, ls="--", color="k", lw=0.6)
    ax[1].axhline(3.8, ls="--", color="k", lw=0.6, label="max. absolus TLV3201 (-0,5 / VCC+0,5)")
    ax[1].plot(t * 1e3, i_r2 * 1e3, lw=0.8, color="#8e44ad", label="courant d'écrêtage (mA)")
    ax[1].legend(fontsize=8)
    ax[1].set_xlabel("temps (ms)")
    for a in ax:
        a.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(os.path.join(FIG, "simA9_defauts.png"), dpi=110)
    plt.close(fig)
    return res


if __name__ == "__main__":
    results = [run_case(c) for c in CASES]
    seuil = sweep_threshold()
    defauts = faults()
    print(seuil)
    print(defauts)
    # AC : impédance d'entrée et réponse en fréquence (modules)
    body = f"""
{include('bnc_tx', 'entree')}
Va v3v3a 0 3.3
Vac bnc_c 0 dc 0 ac 1
Rout_idle ltc_out_bnc 0 100k
* comparateur forcé en saturation (sortie basse) : seule la chaîne passive est linéarisée
Rforce cmp_inp 0 1
"""
    r = run("A0_ac", OUT, body, ["gi", "zi"], "ac dec 50 1 10meg\nlet gi = mag(v(cmp_inn))\nlet zi = 1/mag(i(vac))")
    f = r["x"]
    zin = r["zi"]
    gain = r["gi"]
    def at(freq, arr):
        return float(np.interp(np.log10(freq), np.log10(f), arr))
    ac = dict(zin_1k=at(1e3, zin), zin_2k4=at(2.4e3, zin), zin_20k=at(20e3, zin),
              gain_1k=at(1e3, gain), gain_2k4=at(2.4e3, gain),
              f_low_3db=float(f[np.argmax(gain > gain.max() / np.sqrt(2))]),
              f_high_3db=float(f[len(gain) - 1 - np.argmax(gain[::-1] > gain.max() / np.sqrt(2))]))
    fig, ax = plt.subplots(1, 2, figsize=(10, 3.6))
    ax[0].semilogx(f, 20 * np.log10(gain), color="#c0392b")
    ax[0].set_title("Gain BNC -> IN- du comparateur (dB)", fontsize=10)
    ax[0].axvspan(960, 2400, color="#f1c40f", alpha=0.25, label="bande LTC 960 Hz - 2,4 kHz")
    ax[0].legend(fontsize=8)
    ax[1].loglog(f, zin, color="#3b6ea8")
    ax[1].set_title("Impédance d'entrée vue de la BNC (ohms)", fontsize=10)
    ax[1].axhline(10e3, ls="--", color="k", lw=0.6)
    for a in ax:
        a.grid(alpha=0.3, which="both")
        a.set_xlabel("fréquence (Hz)")
    fig.tight_layout()
    fig.savefig(os.path.join(FIG, "simA0_ac.png"), dpi=110)
    json.dump(dict(cases=results, ac=ac, seuil=seuil, defauts=defauts), open(os.path.join(OUT, "resultats.json"), "w"), indent=1,
              ensure_ascii=False)
    for x in results:
        print({k: (round(v, 3) if isinstance(v, float) else v) for k, v in x.items() if k != "desc"})
    print(ac)
