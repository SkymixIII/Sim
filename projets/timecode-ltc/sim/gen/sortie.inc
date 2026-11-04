* Généré par sim/gen_spice.py depuis design.py - blocs sortie
* R10 10k - Mise en forme : Rth 6 kohms
RR10 ltc_tx_gpio out_sh 10k
* R11 30k - Recentrage à VCC/2
RR11 v3v3a out_sh 30k
* R12 30k - Recentrage à VCC/2
RR12 out_sh 0 30k
* C5 1.8n - Front 10-90 % = 2,2 x 6k x 1,8n = 24 µs
CC5 out_sh 0 1.8n
* U4 TLV9061 - AOP RRIO 10 MHz, 50 mA
XU4 opa_out 0 out_sh opa_out v3v3a TLV9061
* C6 100n - Découplage U4
CC6 v3v3a 0 100n
* R13 56 - Impédance de sortie (1/2)
RR13 opa_out out_p 56
* D4 BAT54S - Protection sortie
XD4 0 v3v3a out_p BAT54S
* C7 47u - Liaison (2 x 47 µF X5R)
CC7 out_p out_ac 37u
* C8 47u - Liaison
CC8 out_p out_ac 37u
* R14 22 - Impédance de sortie (2/2) : total 78 ohms
RR14 out_ac ltc_out_bnc 22
* R15 100k - Décharge, BNC à 0 V continu
RR15 ltc_out_bnc 0 100k
