"""Nomenclature (BOM) et coût, générés depuis design.py."""
import csv, os, sys
from collections import OrderedDict
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from design import PARTS

EXTRA = [  # hors schéma
    ("BT1", "Cellule LiPo 3,7 V 2000 mAh 8 x 38 x 60 mm max, avec PCM et fils JST-PH", "LiPo 803860 (ou 804060) - à choisir avec protection intégrée", 1, 7.00),
    ("PCB", "Circuit imprimé 2 couches ~62 x 36 mm, 1,6 mm (lot de 5)", "JLCPCB / PCBWay", 1, 3.00),
    ("BOITE", "Boîtier imprimé 3D PETG ~72 x 42 x 26 mm + capuchon de glissière", "impression école", 1, 1.50),
    ("VIS", "Vis M2 x 6 et inserts", "-", 4, 0.10),
    ("PATCH", "Fenêtres LED (PETG transparent) / guides de lumière", "-", 1, 0.20),
]

groups = OrderedDict()
for p in PARTS:
    if p["fp"] == "" and p["unit"] > 1:
        continue  # second pôle de SW4
    key = (p["value"], p["mpn"], p["fp"])
    g = groups.setdefault(key, dict(refs=[], value=p["value"], mpn=p["mpn"], fp=p["fp"].split(":")[-1],
                                    desc=p["desc"], price=p["price"], dnp=p["dnp"]))
    g["refs"].append(p["ref"])

rows = []
total = 0.0
for g in groups.values():
    q = len(g["refs"])
    sub = 0 if g["dnp"] else q * g["price"]
    total += sub
    rows.append([", ".join(g["refs"]), q, g["value"], g["mpn"], g["fp"], g["desc"] + (" (non monté)" if g["dnp"] else ""),
                 f"{g['price']:.3f}", f"{sub:.2f}"])
for ref, desc, mpn, q, pu in EXTRA:
    total += q * pu
    rows.append([ref, q, "", mpn, "", desc, f"{pu:.3f}", f"{q*pu:.2f}"])
hdr = ["Références", "Qté", "Valeur", "Référence fabricant / type", "Empreinte", "Fonction", "PU estimé (EUR)", "Total (EUR)"]
with open(os.path.join(HERE, "BOM.csv"), "w", newline="") as fh:
    w = csv.writer(fh, delimiter=";")
    w.writerow(hdr); w.writerows(rows); w.writerow(["", "", "", "", "", "TOTAL par boîtier (hors port)", "", f"{total:.2f}"])
with open(os.path.join(HERE, "BOM.md"), "w") as fh:
    fh.write("# Nomenclature du boîtier timecode LTC (1 boîtier)\n\n")
    fh.write("Générée par `docs/make_bom.py` depuis `design.py`. Prix unitaires : estimations pour 10 boîtiers chez "
             "LCSC / Mouser / AliExpress (novembre 2026), hors frais de port et TVA : **à vérifier avant commande**.\n\n")
    fh.write("| " + " | ".join(hdr) + " |\n|" + "---|" * len(hdr) + "\n")
    for r in rows:
        fh.write("| " + " | ".join(str(x) for x in r) + " |\n")
    fh.write(f"| | | | | | **Total par boîtier (hors port)** | | **{total:.2f}** |\n")
print(f"{len(rows)} lignes, total {total:.2f} EUR")
