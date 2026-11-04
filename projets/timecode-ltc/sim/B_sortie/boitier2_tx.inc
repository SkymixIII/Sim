* Généré par sim/gen_spice.py depuis design.py - blocs bnc
* D1 SMAJ15CA - TVS bidirectionnelle 15 V (VBR 16,7 V min)
Xb2_D1 b2_bnc_c 0 SMAJ15CA
* SW4 TX/RX - Sélecteur TX/RX, pôle A : aiguillage BNC
Sb2_SW4a b2_bnc_c b2_ltc_in_raw mode_rx 0 SWCONT
Sb2_SW4c b2_bnc_c b2_ltc_out_bnc mode_tx 0 SWCONT
Cb2_SW4a b2_bnc_c b2_ltc_in_raw 1p
Cb2_SW4c b2_bnc_c b2_ltc_out_bnc 1p
* Généré par sim/gen_spice.py depuis design.py - blocs entree
* R1 1M - Fixe le potentiel du contact au repos
Rb2_R1 b2_ltc_in_raw 0 1Meg
* C1 100n - Liaison : coupe le continu (100 V)
Cb2_C1 b2_ltc_in_raw b2_in_ac 100n
* R2 10k - Limite le courant d'écrêtage, Zin >= 10 kohms
Rb2_R2 b2_in_ac b2_in_a 10k
* D2 BAT54S - Écrêtage aux rails
Xb2_D2 0 v3v3a b2_in_a BAT54S
* C2 680p - Passe-bas 25 kHz (antiparasite)
Cb2_C2 b2_in_a 0 680p
* R3 100k - Polarisation à VCC/2
Rb2_R3 b2_in_a b2_vmid 100k
* R4 1k - Second étage de limitation
Rb2_R4 b2_in_a b2_cmp_inn 1k
* R5 47k - Diviseur VMID
Rb2_R5 v3v3a b2_vmid 47k
* R6 47k - Diviseur VMID
Rb2_R6 b2_vmid 0 47k
* C3 10u - Découplage VMID
Cb2_C3 b2_vmid 0 8u
* R7 10k - Hystérésis (pont R7/R8)
Rb2_R7 b2_vmid b2_cmp_inp 10k
* R8 470k - Hystérésis : +/-34 mV
Rb2_R8 b2_cmp_out b2_cmp_inp 470k
* U3 TLV3201 - Comparateur 40 ns push-pull RRI
Xb2_U3 b2_cmp_out 0 b2_cmp_inp b2_cmp_inn v3v3a TLV3201
* C4 100n - Découplage U3
Cb2_C4 v3v3a 0 100n
* R9 100 - Série vers GPIO (limite courant si GPIO mal configurée)
Rb2_R9 b2_cmp_out b2_ltc_rx_gpio 100
