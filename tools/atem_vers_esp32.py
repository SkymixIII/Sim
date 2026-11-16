#!/usr/bin/env python3
"""Lit le tally de l'ATEM sur le Mac (RJ45) et l'envoie à l'ESP32 émetteur par USB.

Le Mac calcule lui-même ce qui est à l'antenne, sur toutes les M/E :
  - source de programme et de preview de chaque M/E ;
  - clés en incrustation (DVE, luma, chroma, motif) : leur source de remplissage ;
  - SuperSource : sources de chaque boîte active et le fond (art fill) ;
  - multiview envoyé comme source : toutes les sources de ses fenêtres ;
  - sortie d'une M/E utilisée comme source dans une autre (M/E 2 dans M/E 1…) ;
  - incrustateurs aval (DSK) sur la M/E 1, et les transitions en cours.
Une caméra est au PROGRAMME (rouge) si elle est visible sur le programme de l'une
des M/E suivies, sinon en PREVIEW (vert) si elle est visible sur l'un des previews.

Usage :  python3 atem_vers_esp32.py 192.168.2.20                (toutes les M/E)
         python3 atem_vers_esp32.py 192.168.2.20 --me 1,2       (seulement ces M/E)
         python3 atem_vers_esp32.py 192.168.2.20 /dev/cu.usbserial-0001
Sans port indiqué, le script prend le premier /dev/cu.usbserial*, cu.SLAB* ou cu.wchusbserial*.
Le Moniteur série d'Arduino IDE doit être fermé. Aucune installation. Ctrl+C pour arrêter.
"""
import glob, os, random, socket, sys, termios, time

ARGS = [a for a in sys.argv[1:]]
MES_SUIVIES = None             # None : toutes les M/E de l'ATEM ; sinon ex. {0, 1}
if "--me" in ARGS:
    i = ARGS.index("--me")
    MES_SUIVIES = {int(x) - 1 for x in ARGS[i + 1].split(",") if x.strip()}
    del ARGS[i:i + 2]
IP_ATEM = ARGS[0] if ARGS else "192.168.2.20"
PORT_ATEM = 9910
NB_CAMS = 8                    # caméra n = entrée n de l'ATEM
PERIODE_ENVOI = 0.1
F_ACK_DEMANDE, F_HELLO, F_ACK = 0x08, 0x10, 0x80
VERSION_8 = (2, 28)            # protocole des firmwares ATEM 8.0 et plus


# ---------------------------------------------------------------------------
#  État de l'ATEM et calcul du tally
# ---------------------------------------------------------------------------
class EtatAtem:
    def __init__(self):
        self.version = (2, 30)
        self.nb_me = 0
        self.prg, self.prv = {}, {}                 # M/E -> source
        self.cle_air = {}                           # (M/E, clé) -> à l'antenne
        self.cle_type = {}                          # (M/E, clé) -> type (3 = DVE)
        self.cle_fill = {}                          # (M/E, clé) -> source de remplissage
        self.en_transition = {}                     # M/E -> transition en cours
        self.selection = {}                         # M/E -> bits fond / clés de la prochaine transition
        self.dsk_air, self.dsk_tr, self.dsk_lie, self.dsk_fill = {}, {}, {}, {}
        self.ss_boite = {}                          # (SuperSource, boîte) -> (active, source)
        self.ss_fond = {}                           # SuperSource -> art fill
        self.mv = {}                                # (multiview, fenêtre) -> source
        self.dump_fini = False

    # -- lecture des commandes ------------------------------------------------
    def traiter(self, nom, c):
        u16 = lambda p: int.from_bytes(c[p:p + 2], "big") if len(c) >= p + 2 else None
        if nom == "_ver" and len(c) >= 4:
            self.version = (u16(0), u16(2))
        elif nom == "_top" and len(c) >= 1:
            self.nb_me = c[0]
        elif nom == "PrgI" and len(c) >= 4:
            self.prg[c[0]] = u16(2)
        elif nom == "PrvI" and len(c) >= 4:
            self.prv[c[0]] = u16(2)
        elif nom == "KeOn" and len(c) >= 3:
            self.cle_air[(c[0], c[1])] = bool(c[2])
        elif nom == "KeBS" and len(c) >= 10:
            self.cle_type[(c[0], c[1])] = c[2]
            self.cle_fill[(c[0], c[1])] = u16(8)
        elif nom == "TrPs" and len(c) >= 2:
            self.en_transition[c[0]] = bool(c[1] & 1)
        elif nom == "TrSS" and len(c) >= 3:
            self.selection[c[0]] = c[2]
        elif nom == "DskB" and len(c) >= 4:
            self.dsk_fill[c[0]] = u16(2)
        elif nom == "DskS" and len(c) >= 3:
            self.dsk_air[c[0]] = bool(c[1])
            self.dsk_tr[c[0]] = bool(c[2])
        elif nom == "DskP" and len(c) >= 2:
            self.dsk_lie[c[0]] = bool(c[1])
        elif nom == "SSBP":
            if self.version >= VERSION_8 and len(c) >= 6:
                self.ss_boite[(c[0], c[1])] = (bool(c[2]), u16(4))
            elif len(c) >= 4:
                self.ss_boite[(0, c[0])] = (bool(c[1]), u16(2))
        elif nom == "SSrc":
            if self.version >= VERSION_8 and len(c) >= 4:
                self.ss_fond[c[0]] = u16(2)
            elif len(c) >= 2:
                self.ss_fond[0] = u16(0)
        elif nom == "MvIn" and len(c) >= 4:
            self.mv[(c[0], c[1])] = u16(2)
        elif nom == "InCm":
            self.dump_fini = True

    # -- ce que montre une source ----------------------------------------------
    def visible(self, src, vus):
        """Ensemble des entrées (caméras) visibles dans la source src."""
        if src is None or src in vus:
            return set()
        vus = vus | {src}
        if 1 <= src <= 999:                                   # entrée physique
            return {src}
        if 6000 <= src <= 6009:                               # SuperSource
            n = src - 6000
            s = self.visible(self.ss_fond.get(n), vus)
            for (ss, _b), (active, source) in self.ss_boite.items():
                if ss == n and active:
                    s |= self.visible(source, vus)
            return s
        if 7001 <= src <= 7009:                               # clean feed : M/E 1 sans DSK
            return self.programme(0, vus, avec_dsk=False)
        if 9001 <= src <= 9099:                               # multiview
            n = src - 9001
            s = set()
            for (m, _f), source in self.mv.items():
                if m == n:
                    s |= self.visible(source, vus)
            return s
        if 10010 <= src <= 10999:                             # sortie de M/E : 10010 = M/E 1 prog, 10011 = prev
            me, quoi = divmod(src - 10000, 10)
            if quoi == 0:
                return self.programme(me - 1, vus)
            if quoi == 1:
                return self.preview(me - 1, vus)
        return set()

    def programme(self, me, vus=frozenset(), avec_dsk=True):
        tr = self.en_transition.get(me, False)
        sel = self.selection.get(me, 1)
        s = self.visible(self.prg.get(me), vus)
        if tr and sel & 1:                                     # mix en cours : le preview arrive
            s |= self.visible(self.prv.get(me), vus)
        for (m, k), fill in self.cle_fill.items():
            if m == me and (self.cle_air.get((m, k)) or (tr and sel & (2 << k))):
                s |= self.visible(fill, vus)
        if me == 0 and avec_dsk:
            for d, fill in self.dsk_fill.items():
                if self.dsk_air.get(d) or self.dsk_tr.get(d):
                    s |= self.visible(fill, vus)
        return s

    def preview(self, me, vus=frozenset()):
        sel = self.selection.get(me, 1)
        s = self.visible(self.prv.get(me) if sel & 1 else self.prg.get(me), vus)
        for (m, k), fill in self.cle_fill.items():
            if m == me and bool(self.cle_air.get((m, k))) != bool(sel & (2 << k)):
                s |= self.visible(fill, vus)                   # à l'antenne après la prochaine transition
        if me == 0:
            for d, fill in self.dsk_fill.items():
                if self.dsk_air.get(d) != bool(self.dsk_lie.get(d)):
                    s |= self.visible(fill, vus)
        return s

    def mes(self):
        toutes = range(max(self.nb_me, max(self.prg, default=-1) + 1))
        return [m for m in toutes if MES_SUIVIES is None or m in MES_SUIVIES]

    def tally(self):
        pgm, pvw = set(), set()
        for m in self.mes():
            pgm |= self.programme(m)
            pvw |= self.preview(m)
        return [1 if k + 1 in pgm else 2 if k + 1 in pvw else 0 for k in range(NB_CAMS)]

    def detail(self):
        morceaux = []
        for m in self.mes():
            cles = [f"clé {k + 1}{' DVE' if self.cle_type.get((m, k)) == 3 else ''}={f}"
                    for (mm, k), f in sorted(self.cle_fill.items()) if mm == m and self.cle_air.get((mm, k))]
            pg = sorted(self.programme(m))
            morceaux.append(f"M/E {m + 1} : prog {self.prg.get(m, '?')}"
                            + (f" + {', '.join(cles)}" if cles else "")
                            + f" -> caméras {pg or '-'}")
        return " | ".join(morceaux)


# ---------------------------------------------------------------------------
#  Liaisons : USB vers l'ESP32 et UDP vers l'ATEM
# ---------------------------------------------------------------------------
def trouver_port():
    if len(ARGS) > 1:
        return ARGS[1]
    for motif in ("/dev/cu.usbserial*", "/dev/cu.SLAB*", "/dev/cu.wchusbserial*", "/dev/ttyUSB*"):
        ports = sorted(glob.glob(motif))
        if ports:
            return ports[0]
    sys.exit("Aucun ESP32 trouvé en USB. Branchez-le, ou indiquez le port : "
             "python3 atem_vers_esp32.py <ip> /dev/cu.usbserial-XXXX")


def ouvrir_serie(chemin):
    fd = os.open(chemin, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    a = termios.tcgetattr(fd)
    a[0] = 0
    a[1] = 0
    a[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
    a[3] = 0
    a[4] = a[5] = termios.B115200
    a[6][termios.VMIN] = 0
    a[6][termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, a)
    return fd


def entete(drapeaux, longueur, session, ack_id=0):
    h = bytearray(12)
    h[0] = drapeaux | ((longueur >> 8) & 0x07)
    h[1] = longueur & 0xFF
    h[2:4] = session.to_bytes(2, "big")
    h[4:6] = ack_id.to_bytes(2, "big")
    return h


def hello(session):
    p = entete(F_HELLO, 20, session) + bytearray(8)
    p[9] = 0x3A
    p[12] = 0x01
    return bytes(p)


def trame_esp32(connecte, tally):
    m = bytearray([0xA5, 0x5A, 1 if connecte else 0])
    m += bytes((tally[k] & 0x03) if connecte and k < len(tally) else 0 for k in range(NB_CAMS))
    x = 0
    for b in m[2:11]:
        x ^= b
    m.append(x)
    return bytes(m)


def commandes(data):
    i = 12
    while i + 8 <= len(data):
        l = int.from_bytes(data[i:i + 2], "big")
        if l < 8 or i + l > len(data):
            break
        yield data[i + 4:i + 8].decode("latin-1"), data[i + 8:i + l]
        i += l


def main():
    port = trouver_port()
    fd = ouvrir_serie(port)
    quoi = "toutes les M/E" if MES_SUIVIES is None else "M/E " + ", ".join(str(m + 1) for m in sorted(MES_SUIVIES))
    print(f"ESP32 sur {port}, ATEM {IP_ATEM}, {quoi}", flush=True)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("", 0))
    sock.settimeout(0.05)
    tally = [0] * NB_CAMS
    connecte = False
    atem = EtatAtem()
    dernier_recu = dernier_hello = dernier_envoi = 0.0
    tampon_esp = b""

    def envoyer_esp():
        nonlocal dernier_envoi
        try:
            os.write(fd, trame_esp32(connecte, tally))
        except (BlockingIOError, OSError):
            pass
        dernier_envoi = time.time()

    while True:
        maintenant = time.time()
        if not connecte and maintenant - dernier_hello > 1.0:
            sock.sendto(hello(0x5300 | random.randint(0, 255)), (IP_ATEM, PORT_ATEM))
            dernier_hello = maintenant
        try:
            data, adr = sock.recvfrom(2048)
        except socket.timeout:
            data, adr = b"", None
        except OSError as e:
            print("Réseau :", e, flush=True)
            time.sleep(1)
            data, adr = b"", None

        if data and adr and adr[0] == IP_ATEM and len(data) >= 12:
            dernier_recu = time.time()
            drapeaux = data[0] & 0xF8
            sess = int.from_bytes(data[2:4], "big")
            if drapeaux & F_HELLO:
                if len(data) > 12 and data[12] == 0x02:
                    sock.sendto(bytes(entete(F_ACK, 12, sess)), (IP_ATEM, PORT_ATEM))
                    connecte = True
                    atem = EtatAtem()
                    print("Connecté à l'ATEM, lecture de son état…", flush=True)
                elif len(data) > 12 and data[12] == 0x03:
                    print("L'ATEM refuse la connexion (trop de clients ?)", flush=True)
            elif connecte:
                if drapeaux & F_ACK_DEMANDE:
                    pid = int.from_bytes(data[10:12], "big")
                    sock.sendto(bytes(entete(F_ACK, 12, sess, ack_id=pid)), (IP_ATEM, PORT_ATEM))
                fini_avant = atem.dump_fini
                for nom, corps in commandes(data):
                    atem.traiter(nom, corps)
                if atem.dump_fini and not fini_avant:
                    print(f"État reçu : {atem.nb_me} M/E, protocole {atem.version[0]}.{atem.version[1]}", flush=True)
                nouveau = atem.tally()
                if nouveau != tally:
                    tally = nouveau
                    etats = "  ".join(f"{k + 1}:{'PGM' if f & 1 else 'PVW' if f & 2 else '-'}" for k, f in enumerate(tally))
                    print(time.strftime("%H:%M:%S"), "Tally :", etats, flush=True)
                    print("         ", atem.detail(), flush=True)
                    envoyer_esp()

        if connecte and time.time() - dernier_recu > 2.5:
            connecte = False
            tally = [0] * NB_CAMS
            print("ATEM perdu, reconnexion…", flush=True)

        if time.time() - dernier_envoi >= PERIODE_ENVOI:
            envoyer_esp()

        # Messages de l'ESP32 (Moniteur série) : affichés avec le préfixe [ESP32]
        try:
            tampon_esp += os.read(fd, 1024)
        except (BlockingIOError, OSError):
            pass
        while b"\n" in tampon_esp:
            ligne, tampon_esp = tampon_esp.split(b"\n", 1)
            ligne = ligne.decode("utf-8", "replace").strip()
            if ligne:
                print("   [ESP32]", ligne, flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()
