"""Simulation D : alimentation.

Chaîne simulée (générée depuis design.py) : cellule LiPo (f.é.m. + Rint) ->
FS8205A (2 x 25 mohms) -> VBAT -> AO3401A -> VSYS (+ D3 depuis VBUS) ->
TLV75733P -> +3V3 -> FB1 -> +3V3A.
L'ESP32-S3 est remplacé par une source de courant qui reproduit les courants
de la fiche ESP32-S3-WROOM-1 : réception Wi-Fi 95 mA permanente, émission
802.11b à 20,5 dBm 355 mA pendant 1 ms à chaque image (paquet ESP-NOW), et une
pointe de 500 mA pendant 2 ms (le courant minimal que la fiche demande à
l'alimentation, utilisé ici comme pire cas d'étalonnage RF au démarrage).
Le TP4056 et le DW01A ne sont pas simulés en transitoire : leurs seuils sont
vérifiés par calcul (voir rapport).
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

OUT = os.path.dirname(os.path.abspath(__file__))

I_RX = 95e-3      # fiche : Wi-Fi RX 802.11b/g/n HT20
I_TX = 355e-3     # fiche : TX 802.11b 1 Mbit/s @ 20,5 dBm
I_PEAK = 500e-3   # fiche : courant minimal exigé de l'alimentation
I_MISC = 3.5e-3   # LED (3 x ~1,1 mA), diviseurs, rappels
I_ANA = 0.8e-3    # TLV9061 + TLV3201 + VMID (mesuré en A et B)


def load_pwl():
    """Profil de courant ESP32 : démarrage EN à 1 ms, pointe 500 mA à 5 ms,
    puis réception + une émission de 1 ms toutes les 40 ms (25 i/s)."""
    pts = [(0, 0), (1e-3, 0), (1.05e-3, I_RX)]
    pts += [(5e-3, I_RX), (5.01e-3, I_PEAK), (7e-3, I_PEAK), (7.01e-3, I_RX)]
    t = 10e-3
    while t < 130e-3:
        pts += [(t, I_RX), (t + 10e-6, I_TX), (t + 1e-3, I_TX), (t + 1e-3 + 10e-6, I_RX)]
        t += 40e-3
    pts.append((130e-3, I_RX))
    return " ".join(f"{a:.6g} {b:.6g}" for a, b in pts)


def case(name, vocv, vbus=None, rint=0.12, rdo=0.30):
    usb = (f"Vbus vbus 0 pwl(0 0 0.5m {vbus})" if vbus else "Rbus vbus 0 1Meg")
    body = f"""
{include('alim')}
.param rdo_ldo={rdo}
XBAT vcell bat_n LIPO VOCV={vocv} RINT={rint}
Rcell vcell vbat 0.01
{usb}
* Interrupteur marche (SW1 position MARCHE) fermé à t = 0,5 ms
Sw1 vsys ldo_en en_ctl 0 SWCONT
Ven en_ctl 0 pwl(0 0 0.5m 0 0.51m 1)
* Charge ESP32-S3 sur +3V3, circuits analogiques sur +3V3A
* Le profil (en volts = ampères) pilote une source de courant qui s'efface sous
* 2,8 V (un ESP32 non démarré ne consomme pas son courant nominal) : évite une
* source de courant idéale qui tirerait le rail vers des tensions négatives.
Vprof prof 0 pwl({load_pwl()})
Besp v3v3 0 I = V(prof) * min(1, max(V(v3v3), 0) / 2.8)
Rmisc v3v3 0 {3.3 / I_MISC:.1f}
Rana v3v3a 0 {3.3 / I_ANA:.1f}
"""
    # dropout max : on remplace le paramètre RDO de l'instance du LDO
    if rdo != 0.30:
        body = body.replace(f".param rdo_ldo={rdo}", "")
        inc = open(os.path.join(OUT, "..", "gen", "alim.inc")).read()
        inc = inc.replace(" TLV75733P\n", f" TLV75733P RDO={rdo}\n")
        p = os.path.join(OUT, f"alim_rdo{int(rdo*1000)}.inc")
        open(p, "w").write(inc)
        body = body.replace(include('alim'), f".include {os.path.basename(p)}")
    vecs = ["v(v3v3)", "v(v3v3a)", "v(vsys)", "v(vbat)", "i(vbus)" if vbus else "v(vbus)", "v(bat_n)"]
    r = run(name, OUT, body, vecs, "tran 2u 130m 0 2u")
    t = r["x"]
    v3 = r["v(v3v3)"]
    after = t > 3e-3
    burst = (t > 10e-3)
    # courant batterie : chute dans Rcell (10 mohms)
    res = dict(name=name, vocv=vocv, vbus=vbus, rint=rint, rdo=rdo,
               v3v3_min_peak500=float(v3[(t > 5e-3) & (t < 7.5e-3)].min()),
               v3v3_min_bursts=float(v3[burst].min()),
               v3v3_typ=float(np.median(v3[burst])),
               v3v3a_min=float(r["v(v3v3a)"][after].min()),
               vsys_min=float(r["v(vsys)"][after].min()),
               vbat_min=float(r["v(vbat)"][after].min()),
               inrush_v3v3_t90_ms=float((t[np.argmax(v3 > 0.9 * 3.3)] - 0.5e-3) * 1e3))
    if vbus:
        res["i_usb_mA"] = float(-r["i(vbus)"][burst].mean() * 1e3)
    res["ok"] = bool(res["v3v3_min_peak500"] >= 3.0 and res["v3v3_min_bursts"] >= 3.0)
    return res, r


def autonomie():
    """Autonomie : capacité utile jusqu'à la tension de coupure trouvée par la
    simulation, divisée par le courant moyen de chaque mode (LDO linéaire :
    courant batterie = courant consommé + IQ)."""
    # Courbe f.é.m. / état de charge LiPo générique (HYPOTHESE, à remplacer par la
    # courbe de la cellule achetée) : (tension, % restant)
    ocv = [(4.20, 100), (4.06, 90), (3.98, 80), (3.92, 70), (3.87, 60), (3.82, 50),
           (3.79, 40), (3.77, 30), (3.74, 20), (3.68, 10), (3.45, 5), (3.30, 2), (3.00, 0)]
    duty_tx = 1e-3 / 40e-3
    modes = {
        "TX (émet un paquet par image, écoute le reste du temps)": I_RX + (I_TX - I_RX) * duty_tx,
        "RX (écoute permanente, génère le LTC)": I_RX + (I_TX - I_RX) * (1e-3 / 1.0),
        "RX avec fenêtre d'écoute ESP-NOW 10 % (option logicielle, non simulée)": 0.10 * I_RX + 0.9 * 40e-3,
    }
    return ocv, {k: v + I_MISC + I_ANA + 25e-6 for k, v in modes.items()}


if __name__ == "__main__":
    results = []
    traces = {}
    for name, vocv, vbus, rdo in [("D1_4V2", 4.2, None, 0.30), ("D2_3V7", 3.7, None, 0.30),
                                  ("D3_3V55", 3.55, None, 0.30), ("D4_3V45", 3.45, None, 0.30),
                                  ("D5_3V4", 3.40, None, 0.30), ("D5b_3V3", 3.30, None, 0.30), ("D5c_3V2", 3.20, None, 0.30),
                                  ("D6_3V6_rdomax", 3.60, None, 0.425), ("D7_3V5_rdomax", 3.50, None, 0.425),
                                  ("D7b_3V4_rdomax", 3.40, None, 0.425), ("D7c_3V3_rdomax", 3.30, None, 0.425),
                                  ("D8_USB_5V", 3.7, 5.0, 0.30), ("D9_USB_4V75", 3.0, 4.75, 0.30)]:
        res, r = case(name, vocv, vbus, rdo=rdo)
        results.append(res)
        traces[name] = r
        print({k: (round(v, 3) if isinstance(v, float) else v) for k, v in res.items()})
    ocv, modes = autonomie()
    # tension de coupure : plus faible f.é.m. qui tient 3,0 V sur la pointe de 500 mA (dropout typique)
    cut_typ = min(x["vocv"] for x in results if x["ok"] and x["vbus"] is None and x["rdo"] == 0.30)
    cut_max = min([x["vocv"] for x in results if x["ok"] and x["vbus"] is None and x["rdo"] == 0.425] or [9])
    v_ocv = [a for a, b in ocv][::-1]
    pct = [b for a, b in ocv][::-1]
    use_typ = 100 - float(np.interp(cut_typ, v_ocv, pct))
    use_max = 100 - float(np.interp(cut_max, v_ocv, pct))
    cap = 2000e-3
    aut = {k: dict(i_moy_mA=v * 1e3, heures_typ=cap * (1 - float(np.interp(cut_typ, v_ocv, pct)) / 100) / v,
                   heures_cellule_80pct=0.8 * cap * (1 - float(np.interp(cut_max, v_ocv, pct)) / 100) / v)
           for k, v in modes.items()}
    out = dict(cases=results, coupure_fem_typ=cut_typ, coupure_fem_pire=cut_max,
               capacite_perdue_sous_coupure_pct=dict(typ=100 - use_typ, pire=100 - use_max), autonomie=aut,
               charge=dict(i_charge_mA=400, duree_h_estimee=round(2.0 / 0.40 * 1.2, 1),
                           i_usb_total_mA=400 + max(x.get("i_usb_mA", 0) for x in results)),
               dw01a_seuil_surintensite_A=dict(min=0.14 / 0.054, typ=0.16 / 0.045))
    json.dump(out, open(os.path.join(OUT, "resultats.json"), "w"), indent=1, ensure_ascii=False)
    print(json.dumps({k: v for k, v in out.items() if k != "cases"}, indent=1, ensure_ascii=False))
    # figure
    fig, ax = plt.subplots(2, 1, figsize=(10, 6.5), sharex=True)
    for name, col in (("D1_4V2", "#27ae60"), ("D2_3V7", "#3b6ea8"), ("D4_3V45", "#e67e22"), ("D5_3V4", "#c0392b")):
        r = traces[name]
        ax[0].plot(r["x"] * 1e3, r["v(v3v3)"], lw=0.8, color=col, label=f"+3V3, f.é.m. {name.split('_')[1]}")
        ax[1].plot(r["x"] * 1e3, r["v(vsys)"], lw=0.8, color=col, label=f"VSYS, {name.split('_')[1]}")
    ax[0].axhline(3.0, ls="--", color="k", lw=0.6, label="3,0 V : minimum ESP32-S3")
    ax[0].set_ylim(2.6, 3.45)
    ax[0].set_ylabel("V")
    ax[0].legend(fontsize=7, ncol=3, loc="lower right")
    ax[0].set_title("D : rail 3,3 V pendant la pointe 500 mA (5-7 ms) et les émissions 355 mA / 1 ms", fontsize=10)
    ax[1].set_ylabel("V")
    ax[1].set_xlabel("temps (ms)")
    ax[1].legend(fontsize=7, ncol=4, loc="lower right")
    for a in ax:
        a.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(os.path.join(FIG, "simD_alim.png"), dpi=110)
    plt.close(fig)
