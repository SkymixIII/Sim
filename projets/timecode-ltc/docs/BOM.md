# Nomenclature du boîtier timecode LTC (1 boîtier)

Générée par `docs/make_bom.py` depuis `design.py`. Prix unitaires : estimations pour 10 boîtiers chez LCSC / Mouser / AliExpress (novembre 2026), hors frais de port et TVA : **à vérifier avant commande**.

| Références | Qté | Valeur | Référence fabricant / type | Empreinte | Fonction | PU estimé (EUR) | Total (EUR) |
|---|---|---|---|---|---|---|---|
| J1 | 1 | USB-C | GCT USB4105-GF-A | USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal | Embase USB-C 16 broches (charge + programmation USB natif) | 0.450 | 0.45 |
| R20, R21 | 2 | 5.1k | 5.1k 1 % 0603 (série générique) | R_0603_1608Metric | CC1 : identifie un puits 5 V (obligatoire pour chargeur C-C) | 0.004 | 0.01 |
| F1 | 1 | 0.75A | Littelfuse 1206L075 (ou éq. 0,75 A maintien) | Fuse_1206_3216Metric | Fusible réarmable USB | 0.080 | 0.08 |
| C20, C21, C24 | 3 | 10u | 10 µF 16 V X5R 0805 | C_0805_2012Metric | Entrée TP4056 | 0.030 | 0.09 |
| U5 | 1 | TP4056 | NanJing Top Power TP4056 (ESOP-8) | SOP-8-1EP_3.9x4.9mm_P1.27mm_EP2.41x3.3mm | Chargeur Li-ion CC/CV 4,2 V | 0.120 | 0.12 |
| R22 | 1 | 3.0k | 3.0k 1 % 0603 (série générique) | R_0603_1608Metric | RPROG : 400 mA (table TP4056) ; USB 2.0 : 400 + 106 mA système | 0.004 | 0.00 |
| R23, R24, R43, R44, R45, R46, R4 | 7 | 1k | 1k 1 % 0603 (série générique) | R_0603_1608Metric | LED charge | 0.004 | 0.03 |
| D9, D5 | 2 | rouge | LED rouge 0603 | LED_0603_1608Metric | En charge | 0.020 | 0.04 |
| D10, D7, D8 | 3 | verte | LED verte 0603 | LED_0603_1608Metric | Chargé | 0.020 | 0.06 |
| J2 | 1 | LiPo 2000mAh | JST B2B-PH-K + cellule LiPo 3,7 V 2000 mAh (ex. 803860) | JST_PH_B2B-PH-K_1x02_P2.00mm_Vertical | Batterie | 0.100 | 0.10 |
| U6 | 1 | DW01A | Fortune DW01A | SOT-23-6 | Protection 1 cellule : 4,28 V / 2,40 V / 0,16 V | 0.060 | 0.06 |
| R25 | 1 | 470 | 470 1 % 0603 (série générique) | R_0603_1608Metric | Filtre VCC DW01A (>= 470 ohms) | 0.004 | 0.00 |
| C22, C27, C28, C31, C33, C4, C6 | 7 | 100n | 100n céramique | C_0603_1608Metric | Filtre VCC DW01A | 0.010 | 0.07 |
| R26 | 1 | 2k | 2k 1 % 0603 (série générique) | R_0603_1608Metric | CS DW01A (1-3 kohms) | 0.004 | 0.00 |
| Q2 | 1 | FS8205A | Fortune FS8205A | SOT-23-6 | Double N-MOS 20 V, 22,5 mohms @4,5 V | 0.070 | 0.07 |
| D3 | 1 | SS14 | Vishay SS14 | D_SMA | Schottky 40 V 1 A, VF 0,5 V @1 A | 0.040 | 0.04 |
| Q1 | 1 | AO3401A | Alpha & Omega AO3401A | SOT-23 | P-MOS 30 V, 60 mohms @4,5 V : batterie -> VSYS | 0.040 | 0.04 |
| R27, R31, R32, R3, R15 | 5 | 100k | 100k 1 % 0603 (série générique) | R_0603_1608Metric | Rappel grille Q1 sans USB | 0.004 | 0.02 |
| C23, C7, C8 | 3 | 47u | 47 µF 10 V X5R 1206 | C_1206_3216Metric | Réservoir VSYS (pointes radio) | 0.120 | 0.36 |
| SW1 | 1 | MARCHE/ARRET | C&K PCM12SMTR (ou JS102011SAQN) | SW_SPDT_PCM12 | Interrupteur marche/arrêt sur EN du LDO | 0.450 | 0.45 |
| R28, R1 | 2 | 1M | 1M 1 % 0603 (série générique) | R_0603_1608Metric | EN défini pendant la course de l'inverseur | 0.004 | 0.01 |
| U1 | 1 | TLV75733P | TI TLV75733PDBVR | SOT-23-5 | LDO 3,3 V 1 A, dropout 300 mV typ à 1 A | 0.250 | 0.25 |
| C25, C30 | 2 | 22u | 22 µF 10 V X5R 0805 | C_0805_2012Metric | Sortie LDO | 0.050 | 0.10 |
| FB1 | 1 | 220R@100MHz | Murata BLM18PG221SN1D | L_0603_1608Metric | Isolation rail analogique | 0.030 | 0.03 |
| C26, C3 | 2 | 10u | 10 µF 10 V X5R 0805 | C_0805_2012Metric | Rail analogique | 0.030 | 0.06 |
| R29, R30 | 2 | 220k | 220k 1 % 0603 (série générique) | R_0603_1608Metric | Mesure batterie (diviseur /2) | 0.004 | 0.01 |
| U2 | 1 | ESP32-S3-WROOM-1-N8 | Espressif ESP32-S3-WROOM-1-N8 | ESP32-S3-WROOM-1 | Module Wi-Fi/BLE, antenne PCB, 8 Mo flash | 3.600 | 3.60 |
| R40, R41, R42, R2, R7, R10 | 6 | 10k | 10k 1 % 0603 (série générique) | R_0603_1608Metric | RC EN recommandé : 10 kohms / 1 µF | 0.004 | 0.02 |
| C32 | 1 | 1u | 1u céramique | C_0603_1608Metric | RC EN | 0.010 | 0.01 |
| SW2 | 1 | RESET | C&K KMR221G | SW_Push_1P1T_NO_CK_KMR2 | Reset | 0.150 | 0.15 |
| SW3 | 1 | BOOT | C&K KMR221G | SW_Push_1P1T_NO_CK_KMR2 | Démarrage en téléchargement | 0.150 | 0.15 |
| J4 | 1 | UART | Barrette 1x4 2,54 mm (non montée) | PinHeader_1x04_P2.54mm_Vertical | Console série de secours (non monté) | 0.030 | 0.00 |
| D6 | 1 | jaune | LED jaune 0603 | LED_0603_1608Metric | Mode RX | 0.020 | 0.02 |
| J3 | 1 | BNC 75R | BNC femelle 75 ohms de panneau (ex. Amphenol RF 031-10-RFXG1) | BNC_Amphenol_031-6575_Horizontal | Prise timecode unique | 3.000 | 3.00 |
| D1 | 1 | SMAJ15CA | Littelfuse SMAJ15CA | D_SMA | TVS bidirectionnelle 15 V (VBR 16,7 V min) | 0.080 | 0.08 |
| SW4 | 1 | TX/RX | C&K JS202011JCQN (2P2T, contacts or) ou E-Switch EG2208 | SW_Slide_SPDT_Angled_CK_OS102011MA1Q | Sélecteur TX/RX, pôle A : aiguillage BNC | 0.700 | 0.70 |
| C1 | 1 | 100n | 100 nF 100 V X7R 0805 | C_0805_2012Metric | Liaison : coupe le continu (100 V) | 0.010 | 0.01 |
| D2, D4 | 2 | BAT54S | Nexperia BAT54S | SOT-23 | Écrêtage aux rails | 0.030 | 0.06 |
| C2 | 1 | 680p | 680 pF C0G 0603 | C_0603_1608Metric | Passe-bas 25 kHz (antiparasite) | 0.010 | 0.01 |
| R5, R6 | 2 | 47k | 47k 1 % 0603 (série générique) | R_0603_1608Metric | Diviseur VMID | 0.004 | 0.01 |
| R8 | 1 | 470k | 470k 1 % 0603 (série générique) | R_0603_1608Metric | Hystérésis : +/-34 mV | 0.004 | 0.00 |
| U3 | 1 | TLV3201 | TI TLV3201AIDBVR | SOT-23-5 | Comparateur 40 ns push-pull RRI | 0.550 | 0.55 |
| R9 | 1 | 100 | 100 1 % 0603 (série générique) | R_0603_1608Metric | Série vers GPIO (limite courant si GPIO mal configurée) | 0.004 | 0.00 |
| R11, R12 | 2 | 30k | 30k 1 % 0603 (série générique) | R_0603_1608Metric | Recentrage à VCC/2 | 0.004 | 0.01 |
| C5 | 1 | 1.8n | 1,8 nF C0G 0603 | C_0603_1608Metric | Front 10-90 % = 2,2 x 6k x 1,8n = 24 µs | 0.010 | 0.01 |
| U4 | 1 | TLV9061 | TI TLV9061IDBVR | SOT-23-5 | AOP RRIO 10 MHz, 50 mA | 0.350 | 0.35 |
| R13 | 1 | 56 | 56 1 % 0603 (série générique) | R_0603_1608Metric | Impédance de sortie (1/2) | 0.004 | 0.00 |
| R14 | 1 | 22 | 22 1 % 0603 (série générique) | R_0603_1608Metric | Impédance de sortie (2/2) : total 78 ohms | 0.004 | 0.00 |
| BT1 | 1 |  | LiPo 803860 (ou 804060) - à choisir avec protection intégrée |  | Cellule LiPo 3,7 V 2000 mAh 8 x 38 x 60 mm max, avec PCM et fils JST-PH | 7.000 | 7.00 |
| PCB | 1 |  | JLCPCB / PCBWay |  | Circuit imprimé 2 couches ~62 x 36 mm, 1,6 mm (lot de 5) | 3.000 | 3.00 |
| BOITE | 1 |  | impression école |  | Boîtier imprimé 3D PETG ~72 x 42 x 26 mm + capuchon de glissière | 1.500 | 1.50 |
| VIS | 4 |  | - |  | Vis M2 x 6 et inserts | 0.100 | 0.40 |
| PATCH | 1 |  | - |  | Fenêtres LED (PETG transparent) / guides de lumière | 0.200 | 0.20 |
| | | | | | **Total par boîtier (hors port)** | | **23.41** |
