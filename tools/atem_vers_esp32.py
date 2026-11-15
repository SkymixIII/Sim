#!/usr/bin/env python3
"""Lit le tally de l'ATEM sur le Mac (RJ45) et l'envoie à l'ESP32 émetteur par USB.

Usage :  python3 atem_vers_esp32.py 192.168.2.20
         python3 atem_vers_esp32.py 192.168.2.20 /dev/cu.usbserial-0001
Sans port indiqué, le script prend le premier /dev/cu.usbserial*, cu.SLAB* ou cu.wchusbserial*.
Le Moniteur série d'Arduino IDE doit être fermé. Aucune installation. Ctrl+C pour arrêter.
"""
import glob, os, random, socket, sys, termios, time

IP_ATEM = sys.argv[1] if len(sys.argv) > 1 else "192.168.10.240"
PORT_ATEM = 9910
NB_CAMS = 8
PERIODE_ENVOI = 0.1
F_ACK_DEMANDE, F_HELLO, F_ACK = 0x08, 0x10, 0x80


def trouver_port():
    if len(sys.argv) > 2:
        return sys.argv[2]
    for motif in ("/dev/cu.usbserial*", "/dev/cu.SLAB*", "/dev/cu.wchusbserial*"):
        ports = sorted(glob.glob(motif))
        if ports:
            return ports[0]
    sys.exit("Aucun ESP32 trouvé en USB. Branchez-le, ou indiquez le port : "
             "python3 atem_vers_esp32.py <ip> /dev/cu.usbserial-XXXX")


def ouvrir_serie(chemin):
    fd = os.open(chemin, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    a = termios.tcgetattr(fd)
    a[0] = 0                                                  # iflag
    a[1] = 0                                                  # oflag
    a[2] = termios.CS8 | termios.CREAD | termios.CLOCAL       # cflag
    a[3] = 0                                                  # lflag
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
    print(f"ESP32 sur {port}, ATEM {IP_ATEM}", flush=True)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("", 0))
    sock.settimeout(0.05)
    tally = [0] * NB_CAMS
    connecte = False
    session = 0
    dernier_recu = dernier_hello = dernier_envoi = 0.0
    tampon_esp = b""

    def envoyer_esp():
        nonlocal dernier_envoi
        try:
            os.write(fd, trame_esp32(connecte, tally))
        except BlockingIOError:
            pass
        dernier_envoi = time.time()

    while True:
        maintenant = time.time()
        if not connecte and maintenant - dernier_hello > 1.0:
            session = 0x5300 | random.randint(0, 255)
            sock.sendto(hello(session), (IP_ATEM, PORT_ATEM))
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
                    print("Connecté à l'ATEM", flush=True)
                elif len(data) > 12 and data[12] == 0x03:
                    print("L'ATEM refuse la connexion (trop de clients ?)", flush=True)
            elif connecte:
                if drapeaux & F_ACK_DEMANDE:
                    pid = int.from_bytes(data[10:12], "big")
                    sock.sendto(bytes(entete(F_ACK, 12, sess, ack_id=pid)), (IP_ATEM, PORT_ATEM))
                for nom, corps in commandes(data):
                    if nom == "TlIn" and len(corps) >= 2:
                        nb = int.from_bytes(corps[0:2], "big")
                        nouveau = [corps[2 + k] & 0x03 if k < nb and 2 + k < len(corps) else 0 for k in range(NB_CAMS)]
                        if nouveau != tally:
                            tally = nouveau
                            etats = "  ".join(f"{k + 1}:{'PGM' if f & 1 else 'PVW' if f & 2 else '-'}" for k, f in enumerate(tally))
                            print(time.strftime("%H:%M:%S"), "Tally :", etats, flush=True)
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
