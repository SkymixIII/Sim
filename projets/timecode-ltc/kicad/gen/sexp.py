"""Petit lecteur / écrivain d'expressions S (format KiCad)."""
import re
TOK = re.compile(r'\s*(?:(\()|(\))|"((?:[^"\\]|\\.)*)"|([^\s()"]+))', re.S)
class Sym(str):
    pass
def parse(text):
    stack = [[]]
    pos = 0
    n = len(text)
    while pos < n:
        m = TOK.match(text, pos)
        if not m:
            if text[pos:].strip() == "":
                break
            raise ValueError(text[pos:pos+50])
        pos = m.end()
        if m.group(1):
            stack.append([])
        elif m.group(2):
            x = stack.pop(); stack[-1].append(x)
        elif m.group(3) is not None:
            stack[-1].append(m.group(3).replace('\\"', '"').replace('\\\\', '\\'))
        else:
            stack[-1].append(Sym(m.group(4)))
    return stack[0]
def q(s):
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'
def dump(x, ind=0):
    """Écrit une expression S sur une ligne, dans l'ordre d'origine."""
    if isinstance(x, list):
        return "(" + " ".join(dump(e) for e in x) + ")"
    if isinstance(x, Sym):
        return str(x)
    if isinstance(x, bool):
        return "yes" if x else "no"
    if isinstance(x, float):
        r = round(x, 4)
        return str(int(r)) if r == int(r) else f"{r:.4f}".rstrip("0")
    if isinstance(x, int):
        return str(x)
    return q(str(x))


def find(x, key):
    return [e for e in x if isinstance(e, list) and e and e[0] == key]
_cache = {}
def lib(name):
    if name not in _cache:
        _cache[name] = parse(open(f"/usr/share/kicad/symbols/{name}.kicad_sym").read())[0]
    return _cache[name]
def get_symbol(libname, symname):
    L = lib(libname)
    for s in find(L, "symbol"):
        if s[1] == symname:
            return s
    raise KeyError(symname)
def pins_of(sym_tree):
    pins = []
    def walk(t, unit):
        for e in t:
            if isinstance(e, list) and e:
                if e[0] == "symbol":
                    m = re.search(r"_(\d+)_(\d+)$", e[1]); walk(e, int(m.group(1)) if m else unit)
                elif e[0] == "pin":
                    at = find(e, "at")[0]; ln = find(e, "length")[0][1]
                    nm = find(e, "name")[0][1]; nb = find(e, "number")[0][1]
                    pins.append(dict(unit=unit, type=str(e[1]), name=nm, number=nb,
                                     x=float(at[1]), y=float(at[2]), ang=float(at[3]) if len(at) > 3 else 0.0, length=float(ln)))
    walk(sym_tree, 0)
    return pins
