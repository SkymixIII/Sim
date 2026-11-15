#!/usr/bin/env python3
"""Lit le tally d'un ATEM depuis le Mac (protocole ATEM, UDP 9910). Aucune installation.

Usage :  python3 lire_atem.py            (ATEM en 192.168.10.240)
         python3 lire_atem.py 192.168.1.240
Ctrl+C pour arrêter.
"""
import random, socket, sys, time

IP_ATEM = sys.argv[1] if len(sys.argv) > 1 else "192.168.10.240"
PORT = 9910
NB_CAMS = 8

F_ACK_DEMANDE, F_HELLO, F_RENVOI, F_ACK = 0x08, 0x10, 0x20, 0x80


def entete(drapeaux, longueur, session, ack_id=0, paquet_id=0):
    h = bytearray(12)
    h[0] = drapeaux | ((longueur >> 8) & 0x07)
    h[1] = longueur & 0xFF
    h[2:4] = session.to_bytes(2, "big")
    h[4:6] = ack_id.to_bytes(2, "big")
    h[10:12] = paquet_id.to_bytes(2, "big")
    return h


def hello(session):
    p = entete(F_HELLO, 20, session) + bytearray(8)
    p[9] = 0x3A
    p[12] = 0x01  # demande de connexion
    return bytes(p)


def afficher_tally(flags):
    morceaux = []
    for k, f in enumerate(flags[:NB_CAMS]):
        etat = "PGM" if f & 1 else ("PVW" if f & 2 else "-")
        morceaux.append(f"{k + 1}:{etat}")
    print(time.strftime("%H:%M:%S"), "Tally global (toutes M/E) :", "  ".join(morceaux), flush=True)


def afficher_me(prg, prv):
    morceaux = []
    for me in sorted(set(prg) | set(prv)):
        morceaux.append(f"M/E {me + 1} : PGM {prg.get(me, '?')} / PVW {prv.get(me, '?')}")
    print(time.strftime("%H:%M:%S"), "   |   ".join(morceaux), flush=True)


def lire_commandes(data):
    i = 12
    while i + 8 <= len(data):
        l = int.from_bytes(data[i:i + 2], "big")
        if l < 8 or i + l > len(data):
            break
        nom = data[i + 4:i + 8].decode("latin-1")
        corps = data[i + 8:i + l]
        yield nom, corps
        i += l


def main():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("", 0))
    sock.settimeout(0.5)
    dernier_tally = None
    prg, prv = {}, {}
    while True:
        session = 0x5300 | random.randint(0, 255)
        print(f"Connexion à l'ATEM {IP_ATEM}…", flush=True)
        sock.sendto(hello(session), (IP_ATEM, PORT))
        connecte = False
        dernier_recu = time.time()
        while time.time() - dernier_recu < 3:
            try:
                data, adr = sock.recvfrom(2048)
            except socket.timeout:
                if not connecte:
                    sock.sendto(hello(session), (IP_ATEM, PORT))
                continue
            if adr[0] != IP_ATEM or len(data) < 12:
                continue
            dernier_recu = time.time()
            drapeaux = data[0] & 0xF8
            sess = int.from_bytes(data[2:4], "big")
            if drapeaux & F_HELLO:
                if len(data) > 12 and data[12] == 0x02:
                    sock.sendto(bytes(entete(F_ACK, 12, sess)), (IP_ATEM, PORT))
                    connecte = True
                    print("Connecté à l'ATEM", flush=True)
                elif len(data) > 12 and data[12] == 0x03:
                    print("L'ATEM refuse la connexion (trop de clients ?)", flush=True)
                continue
            if not connecte:
                continue
            if drapeaux & F_ACK_DEMANDE:
                paquet_id = int.from_bytes(data[10:12], "big")
                sock.sendto(bytes(entete(F_ACK, 12, sess, ack_id=paquet_id)), (IP_ATEM, PORT))
            for nom, corps in lire_commandes(data):
                if nom == "TlIn" and len(corps) >= 2:
                    nb = int.from_bytes(corps[0:2], "big")
                    flags = list(corps[2:2 + nb])
                    if flags != dernier_tally:
                        dernier_tally = flags
                        afficher_tally(flags)
                elif nom == "_pin":
                    print("Modèle :", corps.split(b"\0")[0].decode("latin-1", "replace"), flush=True)
                elif nom in ("PrgI", "PrvI") and len(corps) >= 4:
                    me, src = corps[0], int.from_bytes(corps[2:4], "big")
                    table = prg if nom == "PrgI" else prv
                    if table.get(me) != src:
                        table[me] = src
                        afficher_me(prg, prv)
        print("Plus de nouvelles de l'ATEM, reconnexion…", flush=True)
        dernier_tally = None


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()
