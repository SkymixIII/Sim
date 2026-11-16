#!/usr/bin/env python3
"""Pont USB <-> réseau pour l'émetteur ESP32 : relaie les paquets UDP tels quels.

Le script ne connaît pas le protocole ATEM. Il se contente de :
  - envoyer sur le réseau chaque paquet que l'ESP32 lui confie par l'USB (vers l'IP et le port indiqués) ;
  - renvoyer à l'ESP32, par l'USB, chaque paquet reçu en réponse.
C'est l'ESP32 qui parle à l'ATEM et lit le tally.

Usage :  python3 pont_usb_atem.py                         (trouve l'ESP32 tout seul)
         python3 pont_usb_atem.py /dev/cu.usbserial-0001
Le Moniteur série d'Arduino IDE doit être fermé. Aucune installation. Ctrl+C pour arrêter.

Trame USB (dans les deux sens) : 0xA5 0x5A | IP (4) | port (2) | longueur (2) | paquet | XOR des octets 2 à la fin
"""
import fcntl, glob, os, select, socket, struct, sys, termios, time

VITESSE = 921600


def trouver_port():
    if len(sys.argv) > 1:
        return sys.argv[1]
    ports = []
    for motif in ("/dev/cu.usbserial*", "/dev/cu.SLAB*", "/dev/cu.wchusbserial*", "/dev/ttyUSB*"):
        ports += sorted(glob.glob(motif))
    if not ports:
        sys.exit("Aucun ESP32 trouvé en USB. Branchez-le, ou indiquez le port : python3 pont_usb_atem.py /dev/cu.usbserial-XXXX")
    if len(ports) > 1:
        print("Plusieurs ports trouvés :", ", ".join(ports), "-> j'utilise", ports[0], "(indiquez le bon port sinon)")
    return ports[0]


def ouvrir_serie(chemin):
    fd = os.open(chemin, os.O_RDWR | os.O_NOCTTY)
    a = termios.tcgetattr(fd)
    a[0] = 0
    a[1] = 0
    a[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
    a[3] = 0
    vitesse = getattr(termios, "B%d" % VITESSE, None)
    a[4] = a[5] = vitesse if vitesse is not None else termios.B115200
    a[6][termios.VMIN] = 0
    a[6][termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, a)
    if vitesse is None and sys.platform == "darwin":
        fcntl.ioctl(fd, 0x80045402, struct.pack("L", VITESSE))   # IOSSIOSPEED : vitesse libre sur macOS
    return fd


def trame(ip, port, paquet):
    corps = socket.inet_aton(ip) + struct.pack(">HH", port, len(paquet)) + paquet
    x = 0
    for b in corps:
        x ^= b
    return b"\xA5\x5A" + corps + bytes([x])


def main():
    chemin = trouver_port()
    fd = ouvrir_serie(chemin)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("", 0))
    print(f"Pont actif : ESP32 sur {chemin} ({VITESSE} bauds) <-> réseau (port UDP {sock.getsockname()[1]})", flush=True)

    tampon = bytearray()
    texte = bytearray()
    vers_reseau = vers_esp = 0
    destinations = set()
    dernier_bilan = time.time()

    while True:
        prets, _, _ = select.select([fd, sock], [], [], 0.5)
        if sock in prets:
            paquet, (ip, port) = sock.recvfrom(2048)
            os.write(fd, trame(ip, port, paquet))
            vers_esp += 1
        if fd in prets:
            tampon += os.read(fd, 4096)
            while tampon:
                if tampon[0] != 0xA5:
                    # Texte du Moniteur série de l'ESP32
                    c = tampon.pop(0)
                    if c == 0x0A:
                        ligne = texte.decode("utf-8", "replace").strip()
                        if ligne:
                            print("[ESP32]", ligne, flush=True)
                        texte.clear()
                    elif c != 0x0D:
                        texte.append(c)
                    continue
                if len(tampon) < 2:
                    break
                if tampon[1] != 0x5A:
                    texte.append(tampon.pop(0))
                    continue
                if len(tampon) < 10:
                    break
                longueur = (tampon[8] << 8) | tampon[9]
                if len(tampon) < 11 + longueur:
                    break
                bloc = bytes(tampon[:11 + longueur])
                del tampon[:11 + longueur]
                x = 0
                for b in bloc[2:-1]:
                    x ^= b
                if x != bloc[-1]:
                    continue
                ip = socket.inet_ntoa(bloc[2:6])
                port = (bloc[6] << 8) | bloc[7]
                sock.sendto(bloc[10:-1], (ip, port))
                vers_reseau += 1
                if (ip, port) not in destinations:
                    destinations.add((ip, port))
                    print(f"L'ESP32 parle à {ip}:{port}", flush=True)
        if time.time() - dernier_bilan >= 10:
            print(f"   {vers_reseau} paquets ESP32 -> réseau, {vers_esp} paquets réseau -> ESP32 en 10 s", flush=True)
            vers_reseau = vers_esp = 0
            dernier_bilan = time.time()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()
