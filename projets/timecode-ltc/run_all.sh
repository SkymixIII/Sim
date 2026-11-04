#!/bin/sh
# Régénère netlists, schéma, simulations, BOM. Prérequis : ngspice >= 42, KiCad 7 (kicad-cli), python3 + numpy + matplotlib.
set -e
cd "$(dirname "$0")"
python3 sim/ltc/ltc.py
python3 sim/gen_spice.py
python3 kicad/gen/make_kicad.py
kicad-cli sch export netlist --format kicadsexpr -o kicad/boitier-ltc.net kicad/boitier-ltc.kicad_sch
python3 kicad/gen/check_netlist.py
kicad-cli sch export pdf -o kicad/boitier-ltc.pdf kicad/boitier-ltc.kicad_sch
(cd sim/A_entree && python3 sim_a.py)
(cd sim/B_sortie && python3 sim_b.py)
(cd sim/C_commutation && python3 sim_c.py)
(cd sim/D_alim && python3 sim_d.py)
(cd sim/E_synchro && python3 sim_e.py)
python3 docs/make_bom.py
echo "Terminé."
