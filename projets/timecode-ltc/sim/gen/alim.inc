* Généré par sim/gen_spice.py depuis design.py - blocs alim
* R20 5.1k - CC1 : identifie un puits 5 V (obligatoire pour chargeur C-C)
RR20 cc1 0 5.1k
* R21 5.1k - CC2
RR21 cc2 0 5.1k
* F1 0.75A - Fusible réarmable USB
RF1 vbus vbus_f 0.2
* C20 10u - Entrée TP4056
CC20 vbus_f 0 10u
* R22 3.0k - RPROG : 400 mA (table TP4056) ; USB 2.0 : 400 + 106 mA système
RR22 prog 0 3.0k
* C21 10u - Sortie BAT du TP4056
CC21 vbat 0 10u
* R23 1k - LED charge
RR23 vbus_f chrg_a 1k
* R24 1k - LED fin de charge
RR24 vbus_f stdby_a 1k
* R25 470 - Filtre VCC DW01A (>= 470 ohms)
RR25 vbat dw_vcc 470
* C22 100n - Filtre VCC DW01A
CC22 dw_vcc bat_n 100n
* R26 2k - CS DW01A (1-3 kohms)
RR26 dw_cs 0 2k
* Q2 FS8205A - Double N-MOS 20 V, 22,5 mohms @4,5 V
RQ2a bat_n fs_d 0.025
RQ2b fs_d 0 0.025
* D3 SS14 - Schottky 40 V 1 A, VF 0,5 V @1 A
DD3 vbus_f vsys SS14
* Q1 AO3401A - P-MOS 30 V, 60 mohms @4,5 V : batterie -> VSYS
XQ1 vbus_f vsys vbat AO3401A
* R27 100k - Rappel grille Q1 sans USB
RR27 vbus_f 0 100k
* C23 47u - Réservoir VSYS (pointes radio)
CC23 vsys C23_esr 35u
RC23esr C23_esr 0 5m
* R28 1M - EN défini pendant la course de l'inverseur
RR28 ldo_en 0 1Meg
* U1 TLV75733P - LDO 3,3 V 1 A, dropout 300 mV typ à 1 A
XU1 vsys 0 ldo_en v3v3 TLV75733P
* C24 10u - Entrée LDO
CC24 vsys C24_esr 7u
RC24esr C24_esr 0 5m
* C25 22u - Sortie LDO
CC25 v3v3 C25_esr 15u
RC25esr C25_esr 0 5m
* FB1 220R@100MHz - Isolation rail analogique
LFB1 v3v3 FB1_m 1u
RFB1 FB1_m v3v3a 0.1
* C26 10u - Rail analogique
CC26 v3v3a 0 8u
* C27 100n - Rail analogique HF
CC27 v3v3a 0 100n
* R29 220k - Mesure batterie (diviseur /2)
RR29 vbat vbat_sense 220k
* R30 220k - Mesure batterie
RR30 vbat_sense 0 220k
* C28 100n - Filtre ADC
CC28 vbat_sense 0 100n
* R31 100k - Détection USB (diviseur /2)
RR31 vbus_f vbus_sense 100k
* R32 100k - Détection USB
RR32 vbus_sense 0 100k
