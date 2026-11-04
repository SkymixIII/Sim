"""Génère sim/gen/<bloc>.inc à partir de design.py (même circuit que le schéma KiCad)."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from design import PARTS

def node(n):
    return {"GND": "0", "+3V3": "v3v3", "+3V3A": "v3v3a"}.get(n, n.lower())

def emit(blocks, path):
    lines = [f"* Généré par sim/gen_spice.py depuis design.py - blocs {', '.join(blocks)}"]
    for p in PARTS:
        if p["block"] in blocks and p["spice"]:
            s = p["spice"]
            for pin, net in p["pins"].items():
                s = s.replace("{" + pin + "}", node(net))
            lines.append(f"* {p['ref']} {p['value']} - {p['desc']}")
            lines.append(s)
    open(path, "w").write("\n".join(lines) + "\n")

if __name__ == "__main__":
    d = os.path.join(os.path.dirname(__file__), "gen")
    os.makedirs(d, exist_ok=True)
    emit(["bnc"], f"{d}/bnc.inc")
    # Variantes figées pour l'analyse AC (ngspice linéarise un S-switch comme ouvert)
    txt = open(f"{d}/bnc.inc").read()
    for mode, on, off in (("tx", "SSW4a", "SSW4c"), ("rx", "SSW4c", "SSW4a")):
        out = []
        for line in txt.splitlines():
            w = line.split()
            if w and w[0] == on:
                line = f"R{on} {w[1]} {w[2]} 0.03"
            elif w and w[0] == off:
                line = f"R{off} {w[1]} {w[2]} 1e12"
            out.append(line)
        open(f"{d}/bnc_{mode}.inc", "w").write("\n".join(out) + "\n")
    emit(["entree"], f"{d}/entree.inc")
    emit(["sortie"], f"{d}/sortie.inc")
    emit(["alim"], f"{d}/alim.inc")
    print("ok")
