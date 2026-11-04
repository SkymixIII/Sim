"""Vérifie que la netlist exportée par KiCad est identique à celle de design.py."""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))
from sexp import parse, find
from design import nets
POWER_ALIAS = {"+3.3VA": "+3V3A"}
t = parse(open(os.path.join(HERE, "..", "boitier-ltc.net")).read())[0]
kn = {}
for n in find(find(t, "nets")[0], "net"):
    name = find(n, "name")[0][1].lstrip("/")
    name = POWER_ALIAS.get(name, name)
    nodes = sorted((find(x, "ref")[0][1], find(x, "pin")[0][1]) for x in find(n, "node"))
    if name.startswith("unconnected-") or name.startswith("Net-"):
        continue
    kn[name] = nodes
dn = {k: sorted(v) for k, v in nets().items()}
ok = True
for k in sorted(set(kn) | set(dn)):
    if kn.get(k) != dn.get(k):
        ok = False
        print("ECART", k, "\n  kicad :", kn.get(k), "\n  design:", dn.get(k))
print("netlist KiCad == design.py :", ok, f"({len(dn)} nets)")
sys.exit(0 if ok else 1)
