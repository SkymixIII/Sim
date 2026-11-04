"""Simulation E (comportementale) : synchronisation radio TX -> RX et horloge
locale du RX.

Ce n'est PAS une simulation électrique : la radio ESP-NOW et le logiciel ne se
simulent pas dans SPICE. On modélise ici, image par image, ce que fera le
firmware, avec des hypothèses explicites sur la radio (à mesurer sur le vrai
matériel) :

- le TX décode le LTC de la caméra et envoie, juste après le mot de synchro de
  chaque image, un paquet ESP-NOW {numéro d'image, cadence, drapeaux} ;
- latence radio = L0 + gigue positive (exponentielle) + rares retards longs
  (reprises, accès au canal), pertes aléatoires, plus une coupure totale de 30 s ;
- le RX a son propre quartz (+18 ppm) qui dérive de 1 ppm pendant la coupure ;
- le RX génère son LTC en continu à partir d'un accumulateur de phase cadencé à
  1 MHz (pas de 1 µs) et corrige fréquence et phase par une boucle PI alimentée
  par l'enveloppe basse des retards (le minimum sur 1 s rejette la gigue, qui
  ne peut qu'ajouter du retard) ; la correction est bornée à +/-200 ppm pour
  que le timecode ne saute jamais.
"""
import json
import os
import sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
from common import FIG  # noqa: E402

rng = np.random.default_rng(12)

FPS = 25.0
T = 1 / FPS
DUR = 240.0                    # s
N = int(DUR * FPS)
# --- hypothèses radio (HYPOTHESES, à mesurer) ---
L0_TRUE = 1.20e-3              # latence fixe : temps d'antenne 1 Mbit/s + pile Wi-Fi
L0_CAL = 1.10e-3               # valeur étalonnée en usine (erreur de 100 µs)
JIT_MEAN = 0.4e-3              # gigue exponentielle moyenne
P_LONG, LONG_MAX = 0.05, 4e-3  # 5 % de paquets retardés jusqu'à 4 ms
P_LOSS = 0.10                  # 10 % de pertes
OUTAGE = (100.0, 130.0)        # coupure radio totale
# --- quartz du RX ---
EPS_RX = 18e-6                 # erreur de fréquence initiale
EPS_DRIFT = 1e-6               # dérive supplémentaire pendant la coupure (échauffement)
TICK = 1e-6                    # pas de l'accumulateur de phase
F_LIM = 200e-6                 # correction maximale


def eps_at(t):
    a, b = OUTAGE
    return EPS_RX + EPS_DRIFT * np.clip((t - a) / (b - a), 0, 1)


def simulate():
    # instants vrais des débuts d'image de la caméra maîtresse
    master = np.arange(N) * T + 0.5
    lost = rng.random(N) < P_LOSS
    lost |= (master > OUTAGE[0]) & (master < OUTAGE[1])
    jit = rng.exponential(JIT_MEAN, N) + np.where(rng.random(N) < P_LONG, rng.uniform(0, LONG_MAX, N), 0)
    # le paquet de l'image n part à la fin de l'image (mot de synchro reçu) : + T
    arrive_true = master + T + L0_TRUE + jit

    # Horloge locale du RX : local = intégrale de (1 + eps) dt
    def local(t):
        # eps quasi constant : intégration analytique par morceaux
        a, b = OUTAGE
        base = t * (1 + EPS_RX)
        extra = np.where(t < a, 0, np.where(t < b, EPS_DRIFT * (t - a) ** 2 / (2 * (b - a)),
                                            EPS_DRIFT * ((b - a) / 2 + (t - b))))
        return base + extra

    arrive_loc = local(arrive_true)

    # Générateur du RX : frame k démarre à l'heure locale g[k]
    g = np.full(N, np.nan)
    f_corr = 0.0          # correction de fréquence (sans unité)
    integ = 0.0
    started = False
    window = []
    k_gen = 0
    t_next = None         # heure locale du prochain début d'image généré
    phase_slew = 0.0      # correction de phase restant à répartir
    log = []
    period_loc = T
    last_update = None
    hist = []
    holdover = False
    f_hold = 0.0
    last_rx_true = 0.0
    for n in range(N):
        if not lost[n]:
            if not started:
                # premier paquet : on cale l'image n+1 sur l'arrivée corrigée de la latence
                t_next = arrive_loc[n] - L0_CAL      # = début de l'image n+1 (paquet envoyé à la fin de n)
                k_gen = n + 1
                started = True
                last_update = arrive_loc[n]
            else:
                # erreur mesurée pour ce paquet : début théorique de l'image n+1 selon la radio
                window.append((arrive_loc[n] - L0_CAL, n + 1))
        if not started:
            continue
        # le générateur avance jusqu'à l'image n+1 (une image par pas de boucle)
        while k_gen <= n + 1 and k_gen < N:
            # quantification de l'accumulateur à 1 µs
            g[k_gen] = np.round(t_next / TICK) * TICK
            step = T * (1 - f_corr)  # période demandée, en heure locale
            # répartition de la correction de phase, bornée
            dphi = np.clip(phase_slew, -F_LIM * T, F_LIM * T)
            phase_slew -= dphi
            t_next = t_next + step + dphi
            k_gen += 1
        # mise à jour de la boucle chaque seconde, si au moins 5 paquets
        if window and arrive_loc[n] - last_update >= 1.0 and len(window) >= 5:
            # erreur de phase = enveloppe basse de (arrivée corrigée - début généré)
            errs = [a - g[k] for a, k in window if k < N and not np.isnan(g[k])]
            if errs:
                e = min(errs)
                # PI : fréquence (intégrale) + phase (proportionnelle, répartie)
                if holdover:
                    # retour de la radio : on repart de la fréquence moyenne mémorisée
                    integ = -f_hold
                    holdover = False
                integ += 0.15 * e / 1.0
                f_corr = float(np.clip(-integ, -F_LIM, F_LIM))
                phase_slew += 0.5 * e
                hist.append(f_corr)
                log.append((arrive_loc[n], e, f_corr))
            window = []
            last_update = arrive_loc[n]
        elif started and arrive_true[n] - last_rx_true > 2.0 and not holdover:
            # plus de paquet depuis 2 s : maintien sur la fréquence moyenne des 60 dernières s
            f_hold = float(np.mean(hist[-60:])) if hist else f_corr
            f_corr = f_hold
            holdover = True
            log.append((arrive_loc[n], np.nan, f_corr))
        if not lost[n]:
            last_rx_true = arrive_true[n]

    # erreur vraie : instant vrai où le RX commence l'image k - instant vrai maître
    # inversion local -> vrai (eps très petit : une itération suffit)
    tg = g / (1 + EPS_RX)
    for _ in range(3):
        tg = tg - (local(tg) - g) / (1 + eps_at(tg))
    err = tg - master
    return master, err, lost, log


if __name__ == "__main__":
    master, err, lost, log = simulate()
    ok = ~np.isnan(err)
    t = master[ok]
    e = err[ok] * 1e6
    # régimes
    lock = (t > 30) & (t < OUTAGE[0])
    hold = (t > OUTAGE[0]) & (t < OUTAGE[1])
    after = t > OUTAGE[1] + 30
    # continuité : périodes générées toutes proches de T (pas de saut d'image)
    gen_periods = np.diff(t + err[ok])
    res = dict(
        hypotheses=dict(L0_true_ms=L0_TRUE * 1e3, L0_cal_ms=L0_CAL * 1e3, jitter_mean_ms=JIT_MEAN * 1e3,
                        p_long=P_LONG, long_max_ms=LONG_MAX * 1e3, p_loss=P_LOSS, outage_s=list(OUTAGE),
                        eps_rx_ppm=EPS_RX * 1e6, drift_ppm=EPS_DRIFT * 1e6, f_lim_ppm=F_LIM * 1e6),
        acquisition_err_us=float(e[0]),
        verrouille_moy_us=float(e[lock].mean()), verrouille_ecart_type_us=float(e[lock].std()),
        verrouille_max_abs_us=float(np.abs(e[lock]).max()),
        coupure_max_abs_us=float(np.abs(e[hold]).max()),
        apres_max_abs_us=float(np.abs(e[after]).max()),
        periode_min_ms=float(gen_periods.min() * 1e3), periode_max_ms=float(gen_periods.max() * 1e3),
        sauts_image=int(np.sum(np.abs(gen_periods - T) > 0.1 * T)),
        temps_verrouillage_s=float(t[np.argmax((np.abs(e) < 300) & (t > t[0] + 1))] - t[0]),
    )
    json.dump(res, open(os.path.join(HERE, "resultats.json"), "w"), indent=1, ensure_ascii=False)
    print(json.dumps(res, indent=1, ensure_ascii=False))
    fig, ax = plt.subplots(2, 1, figsize=(10, 6))
    ax[0].plot(t, e, lw=0.6, color="#3b6ea8")
    ax[0].axvspan(*OUTAGE, color="#e74c3c", alpha=0.15, label="coupure radio 30 s")
    ax[0].axhline(0, color="k", lw=0.5)
    ax[0].set_ylabel("écart RX - maître (µs)")
    ax[0].set_title("E : écart entre le LTC généré par le RX et celui de la caméra maîtresse", fontsize=10)
    ax[0].legend(fontsize=8)
    ax[0].set_ylim(-1500, 1500)
    lg = np.array(log)
    ax[1].plot(lg[:, 0], lg[:, 2] * 1e6, lw=0.8, color="#8e44ad")
    ax[1].axhline(-EPS_RX * 1e6, ls="--", color="k", lw=0.6, label="-18 ppm (erreur du quartz RX)")
    ax[1].axvspan(*OUTAGE, color="#e74c3c", alpha=0.15)
    ax[1].set_ylabel("correction (ppm)")
    ax[1].set_xlabel("temps (s)")
    ax[1].legend(fontsize=8)
    for a in ax:
        a.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(os.path.join(FIG, "simE_synchro.png"), dpi=110)
    plt.close(fig)
