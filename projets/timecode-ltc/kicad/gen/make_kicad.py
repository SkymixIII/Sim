"""Génère le schéma KiCad 7 (boitier-ltc.kicad_sch), sa bibliothèque de symboles
et le fichier projet, à partir de design.py.

Style : chaque broche reçoit un court fil et une étiquette de net (ou un symbole
d'alimentation) ; les blocs fonctionnels sont encadrés et commentés. Toutes les
connexions passent donc par des noms de nets lisibles, identiques à ceux des
netlists SPICE.
"""
import math
import os
import re
import sys
import uuid as _uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)
from design import PARTS  # noqa: E402
from sexp import Sym, dump, find, get_symbol, pins_of, parse  # noqa: E402

PROJECT = "boitier-ltc"
OUTDIR = os.path.dirname(HERE)
NS = _uuid.UUID("6f1d7d1e-0000-4000-8000-0000000000aa")


def uid(*k):
    return Sym(str(_uuid.uuid5(NS, "/".join(map(str, k)))))


SCH_UUID = str(uid("sheet"))
POWER = {"GND": "GND", "+3V3": "+3V3", "+3V3A": "+3.3VA", "VBUS": "VBUS"}
GRID = 1.27


def snap(v):
    return round(v / GRID) * GRID


def S(x):
    return Sym(x)


def S_(x):
    return Sym(x)


def eff(size=1.27, hide=False, justify=None):
    e = [S("effects"), [S("font"), [S("size"), size, size]]]
    if justify:
        e.append([S("justify")] + [S(j) for j in justify.split()])
    if hide:
        e.append(S("hide"))
    return e


# ---------------------------------------------------------------- symboles
def flatten(libname, symname, newname=None):
    """Copie un symbole de la bibliothèque KiCad en résolvant (extends ...)."""
    child = get_symbol(libname, symname)
    ext = find(child, "extends")
    if ext:
        parent = flatten(libname, ext[0][1])
        body = [e for e in parent if not (isinstance(e, list) and e and e[0] == "property")]
        props = {p[1]: p for p in find(parent, "property")}
        for p in find(child, "property"):
            props[p[1]] = p
        out = [S("symbol"), symname] + [e for e in body[2:] if not (isinstance(e, list) and e[0] == "symbol")]
        out += list(props.values())
        pname = parent[1]
        for sub in find(parent, "symbol"):
            sub = [sub[0], sub[1].replace(pname, symname, 1)] + sub[2:]
            out.append(sub)
        sym = out
    else:
        sym = child
    if newname:
        old = sym[1]
        sym = [sym[0], newname] + [([e[0], e[1].replace(old, newname.split(":")[-1], 1)] + e[2:])
                                   if isinstance(e, list) and e and e[0] == "symbol" else e for e in sym[2:]]
    return sym


def box_symbol(name, ref, left, right, top=(), bottom=(), w=10.16):
    """Symbole rectangulaire : listes de (numéro, nom, type)."""
    n = max(len(left), len(right))
    h = max(n * 2.54 + 2.54, 7.62)
    y0 = (n - 1) * 2.54 / 2
    pins = []
    for i, (num, nm, typ) in enumerate(left):
        pins.append(pin(typ, -w / 2 - 2.54, y0 - i * 2.54, 0, nm, num))
    for i, (num, nm, typ) in enumerate(right):
        pins.append(pin(typ, w / 2 + 2.54, y0 - i * 2.54, 180, nm, num))
    for i, (num, nm, typ) in enumerate(top):
        pins.append(pin(typ, (i - (len(top) - 1) / 2) * 2.54, h / 2 + 2.54, 270, nm, num))
    for i, (num, nm, typ) in enumerate(bottom):
        pins.append(pin(typ, (i - (len(bottom) - 1) / 2) * 2.54, -h / 2 - 2.54, 90, nm, num))
    return [S("symbol"), name, [S("in_bom"), S("yes")], [S("on_board"), S("yes")],
            [S("property"), "Reference", ref, [S("at"), 0, h / 2 + 1.27, 0], eff()],
            [S("property"), "Value", name, [S("at"), 0, -h / 2 - 1.27, 0], eff()],
            [S("property"), "Footprint", "", [S("at"), 0, 0, 0], eff(hide=True)],
            [S("property"), "Datasheet", "", [S("at"), 0, 0, 0], eff(hide=True)],
            [S("symbol"), f"{name}_0_1", [S("rectangle"), [S("start"), -w / 2, h / 2], [S("end"), w / 2, -h / 2],
                                          [S("stroke"), [S("width"), 0.254], [S("type"), S("default")]],
                                          [S("fill"), [S("type"), S("background")]]]],
            [S("symbol"), f"{name}_1_1"] + pins]


def pin(typ, x, y, ang, name, num):
    return [S("pin"), S(typ), S("line"), [S("at"), x, y, ang], [S("length"), 2.54],
            [S("name"), name, eff()], [S("number"), num, eff()]]


CUSTOM = {
    "TP4056": box_symbol("TP4056", "U",
                         [("4", "VCC", "power_in"), ("8", "CE", "input"), ("1", "TEMP", "input"), ("2", "PROG", "passive")],
                         [("5", "BAT", "power_out"), ("7", "~{CHRG}", "open_collector"), ("6", "~{STDBY}", "open_collector")],
                         bottom=[("3", "GND", "power_in"), ("9", "EP", "passive")], w=12.7),
    "DW01A": box_symbol("DW01A", "U",
                        [("5", "VCC", "power_in"), ("2", "CS", "input"), ("4", "NC", "no_connect")],
                        [("1", "OD", "output"), ("3", "OC", "output")],
                        bottom=[("6", "GND", "power_in")]),
    "FS8205A": box_symbol("FS8205A", "Q",
                          [("1", "S1", "passive"), ("6", "G1", "input")],
                          [("3", "S2", "passive"), ("4", "G2", "input")],
                          top=[("2", "D", "passive"), ("5", "D", "passive")]),
}


def lib_symbol(lib, sym):
    if lib == "boitier_ltc":
        if sym == "TLV3201":
            s = flatten("Amplifier_Operational", "TLV9061xDBV", "boitier_ltc:TLV3201")
            # remplace la valeur par défaut et la fiche technique
            for p in find(s, "property"):
                if p[1] == "Value":
                    p[2] = "TLV3201"
                if p[1] == "Datasheet":
                    p[2] = "https://www.ti.com/lit/ds/symlink/tlv3201.pdf"
                if p[1] == "Description" or p[1] == "ki_description":
                    p[2] = "Comparateur 40 ns, push-pull, SOT-23-5"
            return s
        s = [e for e in CUSTOM[sym]]
        return [s[0], f"boitier_ltc:{sym}"] + s[2:]
    return flatten(lib, sym, f"{lib}:{sym}")


def sym_pins(libsym, unit):
    return [p for p in pins_of(libsym) if p["unit"] in (0, unit)]


# ---------------------------------------------------------------- géométrie
def rot(x, y, r):
    a = math.radians(r)
    return x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a)


def world(X, Y, px, py, r=0):
    qx, qy = rot(px, py, r)
    return snap(X + qx), snap(Y - qy)


def dirv(ang):
    a = math.radians(ang)
    return math.cos(a), -math.sin(a)


# ---------------------------------------------------------------- éléments
items = []
libs = {}
pwr_count = [0]


def add_symbol(lib_id, X, Y, r, unit, ref, value, fp, props, libsym, in_bom=True, dnp=False):
    nums = sorted({p["number"] for p in sym_pins(libsym, unit)})
    # placement des champs : au-dessus / au-dessous du corps
    pp = [rot(p["x"], p["y"], r) for p in sym_pins(libsym, unit)]
    ys = [p[1] for p in pp] or [0]
    top, bot = max(ys), min(ys)
    vertical_2pin = len(pp) == 2 and abs(pp[0][0] - pp[1][0]) < 0.1
    horizontal_2pin = len(pp) == 2 and abs(pp[0][1] - pp[1][1]) < 0.1
    just = None
    if vertical_2pin:
        dx = 3.81 if r in (90, 270) else 2.54
        ref_at = (X + dx, Y - 1.27)
        val_at = (X + dx, Y + 1.27)
        just = "left"
    elif horizontal_2pin:
        ref_at = (X, Y - 2.54)
        val_at = (X, Y + 3.81)
    elif len(pp) > 8:
        ref_at = (X + 7.62, Y - top - 1.27)
        val_at = (X, Y - bot + 3.81)
    else:
        ref_at = (X, Y - top - 3.81)
        val_at = (X, Y - bot + 3.81)
    s = [S("symbol"), [S("lib_id"), lib_id], [S("at"), X, Y, r], [S("unit"), unit],
         [S("in_bom"), S("yes" if in_bom else "no")], [S("on_board"), S("yes")], [S("dnp"), S("yes" if dnp else "no")],
         [S("uuid"), uid("sym", ref, unit)],
         [S("property"), "Reference", ref, [S("at"), snap(ref_at[0]), snap(ref_at[1]), r], eff(justify=just)],
         [S("property"), "Value", value, [S("at"), snap(val_at[0]), snap(val_at[1]), r], eff(justify=just)],
         [S("property"), "Footprint", fp, [S("at"), X, Y, 0], eff(hide=True)],
         [S("property"), "Datasheet", props.pop("Datasheet", ""), [S("at"), X, Y, 0], eff(hide=True)]]
    for k, v in props.items():
        s.append([S("property"), k, v, [S("at"), X, Y, 0], eff(hide=True)])
    for n in nums:
        s.append([S("pin"), n, [S("uuid"), uid("pin", ref, unit, n)]])
    s.append([S("instances"), [S("project"), PROJECT, [S("path"), "/" + SCH_UUID, [S("reference"), ref], [S("unit"), unit]]]])
    items.append(s)


def wire(a, b):
    items.append([S("wire"), [S("pts"), [S("xy"), a[0], a[1]], [S("xy"), b[0], b[1]]],
                  [S("stroke"), [S("width"), 0], [S("type"), S("default")]], [S("uuid"), uid("w", a, b)]])


def label(net, at, ang):
    just = "right bottom" if ang == 180 else "left bottom"
    items.append([S("label"), net, [S("at"), at[0], at[1], ang], [S("fields_autoplaced")],
                  eff(justify=just), [S("uuid"), uid("lbl", net, at)]])


def power(net, at, outward):
    sym = POWER[net]
    lib_id = f"power:{sym}"
    if lib_id not in libs:
        libs[lib_id] = flatten("power", sym, lib_id)
    body = 270 if net == "GND" else 90
    # symbole droit, sauf si la broche pointe dans la direction opposée à son corps
    r = 180 if (outward - body) % 360 == 180 else 0
    pwr_count[0] += 1
    ref = f"#PWR{pwr_count[0]:03d}"
    items.append([S("symbol"), [S("lib_id"), lib_id], [S("at"), at[0], at[1], r], [S("unit"), 1],
                  [S("in_bom"), S("yes")], [S("on_board"), S("yes")], [S("dnp"), S("no")],
                  [S("uuid"), uid("pwr", ref)],
                  [S("property"), "Reference", ref, [S("at"), at[0], at[1], 0], eff(hide=True)],
                  [S("property"), "Value", sym, [S("at"), at[0], at[1] + (3.81 if net == "GND" else -3.81), 0], eff(1.0)],
                  [S("property"), "Footprint", "", [S("at"), at[0], at[1], 0], eff(hide=True)],
                  [S("property"), "Datasheet", "", [S("at"), at[0], at[1], 0], eff(hide=True)],
                  [S("pin"), "1", [S("uuid"), uid("pwrpin", ref)]],
                  [S("instances"), [S("project"), PROJECT, [S("path"), "/" + SCH_UUID, [S("reference"), ref], [S("unit"), 1]]]]])


def noconnect(at):
    items.append([S("no_connect"), [S("at"), at[0], at[1]], [S("uuid"), uid("nc", at)]])


def text(t, at, size=1.27, bold=False):
    e = [S("effects"), [S("font"), [S("size"), size, size]] + ([S("bold")] if bold else []), [S("justify"), S("left"), S("bottom")]]
    items.append([S("text"), t, [S("at"), at[0], at[1], 0], e, [S("uuid"), uid("txt", t[:40], at)]])


def rect(a, b):
    items.append([S("rectangle"), [S("start"), a[0], a[1]], [S("end"), b[0], b[1]],
                  [S("stroke"), [S("width"), 0.3], [S("type"), S("dash")]], [S("fill"), [S("type"), S("none")]],
                  [S("uuid"), uid("rect", a, b)]])


DATASHEETS = {
    "U1": "https://www.ti.com/lit/ds/symlink/tlv757p.pdf",
    "U2": "https://documentation.espressif.com/esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf",
    "U3": "https://www.ti.com/lit/ds/symlink/tlv3201.pdf",
    "U4": "https://www.ti.com/lit/ds/symlink/tlv9062.pdf",
}


def build():
    for p in PARTS:
        lib_id = f"{p['lib']}:{p['sym']}"
        if lib_id not in libs:
            libs[lib_id] = lib_symbol(p["lib"], p["sym"])
        ls = libs[lib_id]
        X, Y = snap(p["pos"][0]), snap(p["pos"][1])
        r = p.get("rot", 0)
        props = {"MPN": p["mpn"], "Description": p["desc"], "Datasheet": DATASHEETS.get(p["ref"], "")}
        if p["price"]:
            props["Prix_estime_EUR"] = f"{p['price']:.2f}"
        add_symbol(lib_id, X, Y, r, p["unit"], p["ref"], p["value"], p["fp"], props, ls, dnp=p["dnp"])
        pins = sym_pins(ls, p["unit"])
        for pn in pins:
            net = p["pins"].get(pn["number"])
            if net is None:
                raise SystemExit(f"{p['ref']} broche {pn['number']} ({pn['name']}) sans net dans design.py")
            pt = world(X, Y, pn["x"], pn["y"], r)
            if net == "~":
                noconnect(pt)
                continue
            out_ang = (pn["ang"] + 180 + r) % 360
            dx, dy = dirv(out_ang)
            end = (snap(pt[0] + 2.54 * dx), snap(pt[1] + 2.54 * dy))
            wire(pt, end)
            if net in POWER:
                power(net, end, out_ang)
            else:
                label(net, end, 180 if out_ang == 180 else 0)
        unknown = set(p["pins"]) - {pn["number"] for pn in pins}
        if unknown:
            raise SystemExit(f"{p['ref']} : broches inconnues {unknown}")


# ---------------------------------------------------------------- annotations
BLOCKS = [
    ((15, 18), (348, 200), "1. ALIMENTATION : USB-C, charge TP4056 (400 mA), protection DW01A + FS8205A, chemin d'alimentation, LDO 3,3 V", [
        "Sur USB : VSYS = VBUS - VF(D3) ~ 4,5 V, Q1 bloqué (VGS = +0,4 V) : la cellule est chargée sans débit parasite.",
        "Sans USB : R27 tire la grille de Q1 à 0 V, Q1 conduit (60 mohms max à VGS = -4,5 V) : VSYS = VBAT.",
        "TLV75733P : 1 A, dropout 300 mV typ / 425 mV max à 1 A. Sim. D : 3V3 >= 3,0 V sur 500 mA jusqu'à f.é.m. 3,3 V (typ.) / 3,4 V (max.).",
        "DW01A : surcharge 4,28 V, décharge profonde 2,40 V, surintensité 0,16 V / (2 x 22,5 mohms) ~ 3,5 A. TEMP du TP4056 à la masse : pas de CTN.",
    ]),
    ((355, 18), (580, 242), "2. ESP32-S3-WROOM-1-N8 : radio ESP-NOW, décodage et génération LTC", [
        "IO4 <- comparateur (capture MCPWM horodatée) ; IO5 -> mise en forme LTC ; IO6 <- pôle B de SW4 (0 = TX, 1 = RX).",
        "IO5 en entrée haute impédance quand aucun LTC n'est émis : C7//C8 restent centrés à VCC/2 (sim. B).",
        "USB natif IO19/IO20 : programmation et console par la même prise USB-C. Antenne PCB : zone dégagée en bord de carte.",
    ]),
    ((15, 207), (300, 365), "3. BNC UNIQUE + ENTREE LTC (mode TX)", [
        "SW4 pôle A aiguille physiquement l'âme de la BNC : TX -> LTC_IN_RAW, RX -> LTC_OUT_BNC (coupure avant fermeture).",
        "C1 100 nF + R2/R3 : passe-haut 15 Hz ; R2 + C2 : passe-bas 25 kHz ; Zin 52 kohms à 2,4 kHz ; écrêtage BAT54S <= 1,6 mA à 30 Vcc.",
        "Hystérésis : +/- 3,3 V / 2 x R7 / (R7 + R8) = +/- 34 mV au comparateur, +/- 38 mV à la BNC. Seuil de décodage simulé : 0,09 Vcc.",
    ]),
    ((310, 250), (580, 362), "4. SORTIE LTC (mode RX)", [
        "R10/R11/R12 : 0,66 -> 2,64 V (2,0 Vcc) centré à 1,65 V ; Rth = 6 kohms ; C5 1,8 nF : front 10-90 % = 2,2 x Rth x C5 = 24 µs (SMPTE : 25 +/- 5 µs).",
        "Suiveur TLV9061 -> R13 56 ohms -> C7//C8 (liaison) -> R14 22 ohms : Zout = 78 ohms. 2,0 Vcc à vide, 0,98 Vcc sous 75 ohms (sim. B).",
        "D4 écrête un signal extérieur injecté par erreur ; R14 limite ce courant ; R15 maintient la BNC à 0 V continu.",
    ]),
]


def annotate():
    for a, b, title, notes in BLOCKS:
        rect(a, b)
        text(title, (a[0] + 2, a[1] + 5), size=2.0, bold=True)
        for i, n in enumerate(notes):
            text(n, (a[0] + 2, b[1] - 3 - (len(notes) - 1 - i) * 3.0), size=1.4)


def write():
    build()
    annotate()
    sch = [S("kicad_sch"), [S("version"), 20230121], [S("generator"), S("eeschema")],
           [S("uuid"), S(SCH_UUID)], [S("paper"), "A2"],
           [S("title_block"), [S("title"), "Boîtier timecode LTC sans fil TX/RX"], [S("date"), "2026-11-04"],
            [S("rev"), "A"], [S("company"), "Projet Emulateur Puce elec"],
            [S("comment"), 1, "Généré depuis design.py (même source que les netlists ngspice)"],
            [S("comment"), 2, "Simulations A-E : voir sim/ et docs/RAPPORT.md"]],
           [S("lib_symbols")] + list(libs.values())]
    sch += items
    sch.append([S("sheet_instances"), [S("path"), "/", [S("page"), "1"]]])
    path = os.path.join(OUTDIR, PROJECT + ".kicad_sch")
    open(path, "w").write(pretty(sch) + "\n")
    # bibliothèque du projet
    lib = [S("kicad_symbol_lib"), [S("version"), 20220914], [S("generator"), S("boitier_ltc_gen")]]
    for k, v in libs.items():
        if k.startswith("boitier_ltc:"):
            lib.append([v[0], k.split(":")[1]] + [([e[0], e[1]] + e[2:]) if False else e for e in v[2:]])
    open(os.path.join(OUTDIR, "boitier_ltc.kicad_sym"), "w").write(pretty(lib) + "\n")
    open(os.path.join(OUTDIR, "sym-lib-table"), "w").write(
        '(sym_lib_table\n  (version 7)\n  (lib (name "boitier_ltc")(type "KiCad")(uri "${KIPRJMOD}/boitier_ltc.kicad_sym")(options "")(descr "Symboles du boîtier LTC"))\n)\n')
    pro = os.path.join(OUTDIR, PROJECT + ".kicad_pro")
    if not os.path.exists(pro):
        open(pro, "w").write('{\n  "meta": {"filename": "%s.kicad_pro", "version": 1},\n  "schematic": {"legacy_lib_dir": "", "legacy_lib_list": []},\n  "sheets": [["%s", ""]]\n}\n' % (PROJECT, SCH_UUID))
    print("écrit", path, len(items), "éléments")


def pretty(x, ind=0):
    """Sérialisation indentée qui conserve l'ordre des éléments."""
    if not isinstance(x, list):
        return dump(x)
    flat = dump(x)
    if all(not isinstance(e, list) for e in x) or len(flat) < 100:
        return flat
    out = "("
    first = True
    for e in x:
        if isinstance(e, list):
            out += "\n" + "  " * (ind + 1) + pretty(e, ind + 1)
        else:
            out += ("" if first else " ") + dump(e)
        first = False
    return out + ")"


if __name__ == "__main__":
    write()
