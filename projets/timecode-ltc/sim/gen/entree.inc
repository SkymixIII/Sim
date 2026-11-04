* Généré par sim/gen_spice.py depuis design.py - blocs entree
* R1 1M - Fixe le potentiel du contact au repos
RR1 ltc_in_raw 0 1Meg
* C1 100n - Liaison : coupe le continu (100 V)
CC1 ltc_in_raw in_ac 100n
* R2 10k - Limite le courant d'écrêtage, Zin >= 10 kohms
RR2 in_ac in_a 10k
* D2 BAT54S - Écrêtage aux rails
XD2 0 v3v3a in_a BAT54S
* C2 680p - Passe-bas 25 kHz (antiparasite)
CC2 in_a 0 680p
* R3 100k - Polarisation à VCC/2
RR3 in_a vmid 100k
* R4 1k - Second étage de limitation
RR4 in_a cmp_inn 1k
* R5 47k - Diviseur VMID
RR5 v3v3a vmid 47k
* R6 47k - Diviseur VMID
RR6 vmid 0 47k
* C3 10u - Découplage VMID
CC3 vmid 0 8u
* R7 10k - Hystérésis (pont R7/R8)
RR7 vmid cmp_inp 10k
* R8 470k - Hystérésis : +/-34 mV
RR8 cmp_out cmp_inp 470k
* U3 TLV3201 - Comparateur 40 ns push-pull RRI
XU3 cmp_out 0 cmp_inp cmp_inn v3v3a TLV3201
* C4 100n - Découplage U3
CC4 v3v3a 0 100n
* R9 100 - Série vers GPIO (limite courant si GPIO mal configurée)
RR9 cmp_out ltc_rx_gpio 100
