"""Simulation C : commutation de la BNC unique entre entrée (TX) et sortie (RX).

C1  TX : LTC externe sur la BNC pendant que la sortie est (par erreur logicielle)
    active avec un autre timecode : le TX doit décoder uniquement le signal externe.
C2  RX : la sortie attaque 10 kohms ; le chemin d'entrée ne doit ni charger la sortie,
    ni produire de transitions sur GPIO4.
C3  Isolement petit signal entre les deux chemins (analyse AC), dans les deux modes.
C4  Contre-exemple : les deux chemins câblés en permanence sur la BNC, « commutés »
    seulement par le logiciel (GPIO5 en haute impédance). Source MixPre 3 Vcc / 1 kohm.
C5  Basculement RX -> TX en fonctionnement (coupure avant fermeture de 2 ms).
"""
import json
import os
import sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from common import run, include, FIG, GEN  # noqa: E402
import ltc  # noqa: E402

OUT = os.path.dirname(os.path.abspath(__file__))
VDD = 3.3
PREROLL = 2e-3


def lsrc(name, rate, tc0, nframes, vpp=None):
    fps, nominal, drop = ltc.RATES[rate]
    bits, tcs, tb = ltc.frames_bits(tc0, nframes, rate)
    edges, _ = ltc.biphase(bits, tb, t0=PREROLL)
    t_end = PREROLL + nframes * 80 * tb + 2e-3
    p = os.path.join(OUT, name.lower() + ".pwl")
    if vpp is None:
        ltc.pwl_logic(p, edges, 1.0, t_end)
    else:
        ltc.pwl_analog(p, edges, vpp, 25e-6, t_end)
    return tcs, tb, edges, t_end, os.path.basename(p)


def fsrc(inst, nodes, pwl):
    return (f"A{inst} %vd([{nodes}]) m{inst}\n.model m{inst} filesource (file=\"{pwl}\" amploffset=[0] "
            f"amplscale=[1] timeoffset=0 timescale=1 timerelative=false amplstep=false)")


def decode(t, v, thr, tcs):
    fr = ltc.decode_edges(ltc.crossings(t, v, thr))
    got = [f["tc"] for f in fr]
    return got, [g for g in got if g in tcs]


COMMON = f"""
Va v3v3a 0 {VDD}
Vd v3v3 0 {VDD}
XESP ltc_rx_gpio v3v3 0 ESP_GPIO_IN
"""


def c1():
    tcs_in, tb, _, t_end, p_in = lsrc("c1_ext", "25", (1, 0, 0, 0), 6, vpp=1.0)
    tcs_out, _, _, _, p_out = lsrc("c1_gpio", "25", (22, 22, 22, 0), 6)
    body = f"""
{include('bnc', 'entree', 'sortie')}
{COMMON}
Vmtx mode_tx 0 1
Vmrx mode_rx 0 0
{fsrc('ext', 'n_src 0', p_in)}
Rsrc n_src bnc_c 50
{fsrc('ctl', 'ctl 0', p_out)}
Voe oe 0 1
XG ltc_tx_gpio v3v3 0 ctl oe ESP_GPIO_OUT
"""
    r = run("C1", OUT, body, ["v(bnc_c)", "v(ltc_out_bnc)", "v(ltc_in_raw)", "v(cmp_inn)", "v(ltc_rx_gpio)", "v(opa_out)"],
            f"tran 0.5u {t_end} 0 0.5u")
    t = r["x"]
    got, valid = decode(t, r["v(ltc_rx_gpio)"], VDD / 2, tcs_in)
    m = t > PREROLL + 80 * tb
    return dict(desc="TX : LTC externe 01:00:00:00 sur la BNC, sortie active par erreur avec 22:22:22:00",
                decoded=[ltc.fmt_tc(g) for g in got], all_from_external=len(valid) == len(got) and len(got) >= 4,
                vpp_bnc=float(np.ptp(r["v(bnc_c)"][m])), vpp_output_path_open=float(np.ptp(r["v(ltc_out_bnc)"][m])))


def c2():
    tcs, tb, _, t_end, p = lsrc("c2_gpio", "25", (3, 0, 0, 0), 6)
    body = f"""
{include('bnc', 'entree', 'sortie')}
{COMMON}
Vmtx mode_tx 0 0
Vmrx mode_rx 0 1
{fsrc('ctl', 'ctl 0', p)}
Voe oe 0 pwl(0 0 {PREROLL - 2e-4} 0 {PREROLL - 2e-4 + 1e-6} 1)
XG ltc_tx_gpio v3v3 0 ctl oe ESP_GPIO_OUT
Rload bnc_c 0 10k
"""
    r = run("C2", OUT, body, ["v(bnc_c)", "v(ltc_in_raw)", "v(cmp_inn)", "v(cmp_inp)", "v(ltc_rx_gpio)"],
            f"tran 0.5u {t_end} 0 0.5u")
    t = r["x"]
    m = t > PREROLL + 80 * tb
    got, valid = decode(t, r["v(bnc_c)"], 0.0, tcs)
    toggles = len(ltc.crossings(t[m], r["v(ltc_rx_gpio)"][m], VDD / 2))
    return dict(desc="RX : sortie sur 10 kohms, chemin d'entrée ouvert",
                vpp_bnc=float(np.ptp(r["v(bnc_c)"][m])), decoded_on_bnc=len(valid),
                vpp_in_raw=float(np.ptp(r["v(ltc_in_raw)"][m])),
                vpp_cmp_inn=float(np.ptp(r["v(cmp_inn)"][m])),
                gpio4_toggles=toggles)


def c3():
    """Isolement AC : on injecte 1 V AC dans un chemin et on mesure l'autre."""
    res = {}
    # TX : signal externe sur la BNC ; la sortie (AOP) injecte 1 V AC sur OPA_OUT
    for mode, inc in (("tx", "bnc_tx"), ("rx", "bnc_rx")):
        body = f"""
{include(inc, 'entree', 'sortie')}
Va v3v3a 0 {VDD}
* 1 V AC injecté à la sortie de l'AOP (via sa source de commande)
Vinj ltc_tx_gpio 0 dc 1.65 ac 1
Rbnc bnc_c 0 {'50' if mode == 'tx' else '10k'}
Rforce cmp_inp 0 1
"""
        r = run(f"C3_{mode}", OUT, body, ["g_in", "g_bnc"],
                "ac dec 20 10 10meg\nlet g_in = mag(v(cmp_inn))\nlet g_bnc = mag(v(bnc_c))")
        f = r["x"]
        at = lambda fr, a: float(np.interp(np.log10(fr), np.log10(f), a))
        res[mode] = dict(f=f.tolist(), g_in=r["g_in"].tolist(), g_bnc=r["g_bnc"].tolist(),
                         in_2k4_db=20 * np.log10(at(2.4e3, r["g_in"]) + 1e-30),
                         in_1M_db=20 * np.log10(at(1e6, r["g_in"]) + 1e-30),
                         bnc_2k4_db=20 * np.log10(at(2.4e3, r["g_bnc"]) + 1e-30))
    fig, ax = plt.subplots(figsize=(8, 3.8))
    for mode, col in (("tx", "#c0392b"), ("rx", "#3b6ea8")):
        d = res[mode]
        ax.semilogx(d["f"], 20 * np.log10(np.array(d["g_in"]) + 1e-30), color=col,
                    label=f"{mode.upper()} : sortie AOP -> entrée comparateur")
    ax.semilogx(res["tx"]["f"], 20 * np.log10(np.array(res["tx"]["g_bnc"]) + 1e-30), color="#e67e22", ls="--",
                label="TX : sortie AOP -> BNC (source 50 ohms)")
    ax.axvspan(960, 2400, color="#f1c40f", alpha=0.25)
    ax.set_ylim(-200, 10)
    ax.set_xlabel("fréquence (Hz)")
    ax.set_ylabel("dB")
    ax.set_title("C3 : isolement entre les chemins d'entrée et de sortie", fontsize=10)
    ax.grid(alpha=0.3, which="both")
    ax.legend(fontsize=7)
    fig.tight_layout()
    fig.savefig(os.path.join(FIG, "simC3_isolement.png"), dpi=110)
    plt.close(fig)
    for mode in res:
        for k in ("f", "g_in", "g_bnc"):
            res[mode].pop(k)
    return res


def naive_inc():
    """bnc.inc sans l'inverseur : les deux chemins sont reliés en permanence à la BNC."""
    txt = open(os.path.join(GEN, "bnc.inc")).read().splitlines()
    out = []
    for line in txt:
        w = line.split()
        if w and w[0] in ("SSW4a", "SSW4c"):
            line = f"R{w[0]} {w[1]} {w[2]} 0.03"
        if w and w[0] in ("CSW4a", "CSW4c"):
            continue
        out.append(line)
    p = os.path.join(OUT, "bnc_sans_inverseur.inc")
    open(p, "w").write("\n".join(out) + "\n")
    return os.path.basename(p)


def c4():
    tcs, tb, _, t_end, p_in = lsrc("c4_ext", "25", (4, 0, 0, 0), 12, vpp=3.0)
    _, _, _, _, p_out = lsrc("c4_gpio", "25", (22, 22, 22, 0), 12)
    out = {}
    for label, oe in (("sortie_haute_impedance", "0"), ("sortie_active", "1")):
        body = f"""
.include {naive_inc()}
{include('entree', 'sortie')}
{COMMON}
Vmtx mode_tx 0 1
Vmrx mode_rx 0 1
{fsrc('ext', 'n_src 0', p_in)}
Rsrc n_src bnc_c 1k
{fsrc('ctl', 'ctl 0', p_out)}
Voe oe 0 {oe}
XG ltc_tx_gpio v3v3 0 ctl oe ESP_GPIO_OUT
"""
        name = f"C4_{label}"
        r = run(name, OUT, body, ["v(bnc_c)", "v(cmp_inn)", "v(ltc_rx_gpio)"], f"tran 0.5u {t_end} 0 0.5u")
        t = r["x"]
        m = t > t_end - 2e-3 - 3 * 80 * tb  # 3 dernières images : régime établi
        got, valid = decode(t, r["v(ltc_rx_gpio)"], VDD / 2, tcs)
        out[label] = dict(vpp_bnc_regime=float(np.ptp(r["v(bnc_c)"][m])), attenuation=3.0 / float(np.ptp(r["v(bnc_c)"][m])),
                          frames_valid=len(valid), frames_sent=12,
                          decoded=[ltc.fmt_tc(g) for g in got][:6], vpp_cmp=float(np.ptp(r["v(cmp_inn)"][m])))
        if label == "sortie_active":
            tt = t * 1e3
            mm = (tt > 300) & (tt < 307)
            fig, ax = plt.subplots(2, 1, figsize=(10, 4.8), sharex=True)
            ax[0].plot(tt[mm], r["v(bnc_c)"][mm], lw=0.8)
            ax[0].set_ylabel("BNC (V)")
            ax[0].set_title("C4 : contre-exemple sans inverseur (MixPre 3 Vcc / 1 kohm + sortie active)", fontsize=10)
            ax[1].plot(tt[mm], r["v(ltc_rx_gpio)"][mm], lw=0.8, color="#27ae60")
            ax[1].set_ylabel("GPIO4 (V)")
            ax[1].set_xlabel("temps (ms)")
            for a in ax:
                a.grid(alpha=0.3)
            fig.tight_layout()
            fig.savefig(os.path.join(FIG, "simC4_sans_inverseur.png"), dpi=110)
            plt.close(fig)
    return out


def c5():
    tcs, tb, _, t_end, p = lsrc("c5_gpio", "25", (5, 0, 0, 0), 4)
    body = f"""
{include('bnc', 'entree', 'sortie')}
{COMMON}
* RX jusqu'à 60 ms, contacts tous ouverts 2 ms, puis TX
Vmrx mode_rx 0 pwl(0 1 60m 1 60.1m 0)
Vmtx mode_tx 0 pwl(0 0 62m 0 62.1m 1)
{fsrc('ctl', 'ctl 0', p)}
Voe oe 0 1
XG ltc_tx_gpio v3v3 0 ctl oe ESP_GPIO_OUT
Rload bnc_c 0 10k
"""
    r = run("C5", OUT, body, ["v(bnc_c)", "v(ltc_out_bnc)", "v(cmp_inn)", "v(ltc_rx_gpio)", "v(ltc_in_raw)"],
            f"tran 1u {t_end} 0 1u")
    t = r["x"]
    m = t > 59e-3
    tt = t * 1e3
    fig, ax = plt.subplots(3, 1, figsize=(10, 6), sharex=True)
    ax[0].plot(tt, r["v(bnc_c)"], lw=0.7)
    ax[0].set_ylabel("BNC (V)")
    ax[0].axvspan(60, 62, color="#f1c40f", alpha=0.3)
    ax[0].set_title("C5 : basculement RX -> TX en fonctionnement (zone jaune : contacts ouverts)", fontsize=10)
    ax[1].plot(tt, r["v(cmp_inn)"], lw=0.7, color="#c0392b")
    ax[1].axhline(-0.5, ls="--", color="k", lw=0.6)
    ax[1].axhline(3.8, ls="--", color="k", lw=0.6)
    ax[1].set_ylabel("IN- (V)")
    ax[2].plot(tt, r["v(ltc_rx_gpio)"], lw=0.7, color="#27ae60")
    ax[2].set_ylabel("GPIO4 (V)")
    ax[2].set_xlabel("temps (ms)")
    for a in ax:
        a.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(os.path.join(FIG, "simC5_basculement.png"), dpi=110)
    plt.close(fig)
    toggles_after = len(ltc.crossings(t[t > 70e-3], r["v(ltc_rx_gpio)"][t > 70e-3], VDD / 2))
    return dict(v_inn_min=float(r["v(cmp_inn)"][m].min()), v_inn_max=float(r["v(cmp_inn)"][m].max()),
                v_bnc_after_max=float(np.abs(r["v(bnc_c)"][t > 63e-3]).max()),
                gpio4_toggles_after_70ms=toggles_after)


if __name__ == "__main__":
    res = dict(C1=c1(), C2=c2(), C3=c3(), C4=c4(), C5=c5())
    json.dump(res, open(os.path.join(OUT, "resultats.json"), "w"), indent=1, ensure_ascii=False)
    print(json.dumps(res, indent=1, ensure_ascii=False))
