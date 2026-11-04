"""Outils communs aux bancs de simulation : lancement de ngspice, lecture des
résultats, mesures, tracés."""
import os
import subprocess
import sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, "ltc"))
sys.path.insert(0, ROOT)
MODELS = os.path.join(HERE, "models", "composants.lib")
GEN = os.path.join(HERE, "gen")
FIG = os.path.join(ROOT, "docs", "figures")
os.makedirs(FIG, exist_ok=True)


def run(name, outdir, body, vectors, analysis, timeout=600):
    """Écrit <outdir>/<name>.cir, lance ngspice en mode batch et renvoie un
    dict {vecteur: np.array} (+ 'x' pour l'axe temps / fréquence)."""
    os.makedirs(outdir, exist_ok=True)
    cir = os.path.join(outdir, name + ".cir")
    dat = os.path.join(outdir, name + ".dat")
    vec = " ".join(vectors)
    text = f"""* {name}
.include {os.path.relpath(MODELS, outdir)}
{body}
.control
set wr_singlescale
set wr_vecnames
option numdgt=7
{analysis}
wrdata {name}.dat {vec}
quit
.endc
.end
"""
    open(cir, "w").write(text)
    p = subprocess.run(["ngspice", "-b", name + ".cir"], cwd=outdir, capture_output=True,
                       text=True, timeout=timeout)
    open(os.path.join(outdir, name + ".log"), "w").write(p.stdout + p.stderr)
    if not os.path.exists(dat) or p.returncode != 0:
        raise RuntimeError(f"ngspice a échoué pour {name} :\n{p.stdout[-3000:]}\n{p.stderr[-3000:]}")
    with open(dat) as fh:
        header = fh.readline().split()
    arr = np.loadtxt(dat, skiprows=1)
    os.remove(dat)  # les .dat sont volumineux ; on garde .cir, .log et les figures
    res = {"x": arr[:, 0]}
    for i, h in enumerate(header[1:], start=1):
        res[h] = arr[:, i]
    # ngspice renomme parfois les vecteurs ; on ajoute les noms demandés dans l'ordre
    for i, v in enumerate(vectors, start=1):
        res.setdefault(v, arr[:, i])
    return res


def include(*blocks):
    return "\n".join(f".include {os.path.join(GEN, b + '.inc')}" for b in blocks)


def rise_time(t, v, lo=None, hi=None):
    """Temps de montée et de descente 10-90 % moyens sur toutes les transitions."""
    lo = np.percentile(v, 2) if lo is None else lo
    hi = np.percentile(v, 98) if hi is None else hi
    a = lo + 0.1 * (hi - lo)
    b = lo + 0.9 * (hi - lo)
    rises, falls = [], []
    state = None
    t_a = t_b = None
    for i in range(1, len(v)):
        if v[i - 1] < a <= v[i]:
            t_a = t[i]
            state = "up"
        if state == "up" and v[i - 1] < b <= v[i] and t_a is not None:
            rises.append(t[i] - t_a)
            state = None
        if v[i - 1] > b >= v[i]:
            t_b = t[i]
            state = "down"
        if state == "down" and v[i - 1] > a >= v[i] and t_b is not None:
            falls.append(t[i] - t_b)
            state = None
    return (np.median(rises) if rises else np.nan, np.median(falls) if falls else np.nan)
