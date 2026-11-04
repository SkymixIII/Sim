* Généré par sim/gen_spice.py depuis design.py - blocs bnc
* D1 SMAJ15CA - TVS bidirectionnelle 15 V (VBR 16,7 V min)
XD1 bnc_c 0 SMAJ15CA
* SW4 TX/RX - Sélecteur TX/RX, pôle A : aiguillage BNC
SSW4a bnc_c ltc_in_raw mode_tx 0 SWCONT
SSW4c bnc_c ltc_out_bnc mode_rx 0 SWCONT
CSW4a bnc_c ltc_in_raw 1p
CSW4c bnc_c ltc_out_bnc 1p
