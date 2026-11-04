"""
Source unique de vérité du boîtier timecode LTC TX/RX.

Chaque composant y est décrit une seule fois : référence, valeur, symbole et
empreinte KiCad, référence fabricant, prix estimé, connexions broche -> net,
et ligne SPICE. Les scripts suivants en sont dérivés :

  kicad/gen/make_kicad.py   -> kicad/boitier-ltc.kicad_sch (+ PDF, netlist)
  sim/gen_spice.py          -> sim/gen/*.inc (sous-circuits inclus par les bancs A-D)
  docs/make_bom.py          -> docs/BOM.csv, docs/BOM.md

Ainsi, le schéma KiCad et les simulations ngspice décrivent le même circuit.
"""

# ----------------------------------------------------------------------------
# Choix des GPIO de l'ESP32-S3-WROOM-1-N8 (sans PSRAM octale)
# Évités : IO0, IO3, IO45, IO46 (straps), IO19/IO20 (USB natif), IO35-37
# (PSRAM sur les variantes R8), IO43/IO44 (UART0 de secours).
# ----------------------------------------------------------------------------
GPIO = {
    "IO1": "VBAT_SENSE",   # ADC1_CH0
    "IO2": "VBUS_SENSE",   # ADC1_CH1 / détection USB
    "IO4": "LTC_RX_GPIO",  # sortie comparateur -> capture MCPWM
    "IO5": "LTC_TX_GPIO",  # LTC logique généré par le RX
    "IO6": "MODE",         # 0 = TX, 1 = RX (pôle B de l'inverseur)
    "IO7": "LED_TX",
    "IO15": "LED_RX",
    "IO16": "LED_SYNC",
    "IO17": "LED_BAT",
}

PARTS = []


def P(ref, lib, sym, value, fp, pins, block, mpn="", desc="", price=0.0,
      spice=None, qty_note="", pos=None, unit=1, dnp=False, rot=0):
    PARTS.append(dict(ref=ref, lib=lib, sym=sym, value=value, fp=fp, pins=pins,
                      block=block, mpn=mpn, desc=desc, price=price, spice=spice,
                      pos=pos, unit=unit, dnp=dnp, rot=rot))


R0603 = "Resistor_SMD:R_0603_1608Metric"
C0603 = "Capacitor_SMD:C_0603_1608Metric"
C0805 = "Capacitor_SMD:C_0805_2012Metric"
C1206 = "Capacitor_SMD:C_1206_3216Metric"
LED0603 = "LED_SMD:LED_0603_1608Metric"


def R(ref, val, a, b, block, pos, desc="", fp=R0603, price=0.004, sval=None):
    P(ref, "Device", "R", val, fp, {"1": a, "2": b}, block,
      mpn=f"{val} 1 % 0603 (série générique)", desc=desc, price=price,
      spice=f"R{ref} {{1}} {{2}} {sval or (val[:-1] + 'Meg' if val.endswith('M') else val)}", pos=pos)


def C(ref, val, a, b, block, pos, desc="", fp=C0603, mpn="", price=0.01, sval=None, esr=None):
    sp = f"C{ref} {{1}} {{2}} {sval or val}"
    if esr:
        sp = f"C{ref} {{1}} {ref}_esr {sval or val}\nR{ref}esr {ref}_esr {{2}} {esr}"
    P(ref, "Device", "C", val, fp, {"1": a, "2": b}, block,
      mpn=mpn or f"{val} céramique", desc=desc, price=price, spice=sp, pos=pos)


# ============================================================================
# 1. ALIMENTATION : USB-C, charge, protection, chemin d'alimentation, LDO
# ============================================================================
B = "alim"
P("J1", "Connector", "USB_C_Receptacle_USB2.0_16P", "USB-C",
  "Connector_USB:USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal",
  {"A4": "VBUS", "A9": "VBUS", "B4": "VBUS", "B9": "VBUS",
   "A1": "GND", "A12": "GND", "B1": "GND", "B12": "GND", "S1": "GND",
   "A5": "CC1", "B5": "CC2", "A6": "USB_DP", "B6": "USB_DP",
   "A7": "USB_DN", "B7": "USB_DN", "A8": "~", "B8": "~"},
  B, mpn="GCT USB4105-GF-A", desc="Embase USB-C 16 broches (charge + programmation USB natif)",
  price=0.45, pos=(30, 70))
R("R20", "5.1k", "CC1", "GND", B, (62, 95), "CC1 : identifie un puits 5 V (obligatoire pour chargeur C-C)")
R("R21", "5.1k", "CC2", "GND", B, (72, 95), "CC2")
P("F1", "Device", "Polyfuse", "0.75A", "Fuse:Fuse_1206_3216Metric",
  {"1": "VBUS", "2": "VBUS_F"}, B, mpn="Littelfuse 1206L075 (ou éq. 0,75 A maintien)",
  desc="Fusible réarmable USB", price=0.08, spice="RF1 {1} {2} 0.2", pos=(80, 45))
C("C20", "10u", "VBUS_F", "GND", B, (95, 75), "Entrée TP4056", fp=C0805, mpn="10 µF 16 V X5R 0805", price=0.03)

P("U5", "boitier_ltc", "TP4056", "TP4056", "Package_SO:SOP-8-1EP_3.9x4.9mm_P1.27mm_EP2.41x3.3mm",
  {"1": "GND", "2": "PROG", "3": "GND", "4": "VBUS_F", "5": "VBAT", "6": "STDBY_N",
   "7": "CHRG_N", "8": "VBUS_F", "9": "GND"},
  B, mpn="NanJing Top Power TP4056 (ESOP-8)", desc="Chargeur Li-ion CC/CV 4,2 V", price=0.12,
  pos=(125, 70))
R("R22", "3.0k", "PROG", "GND", B, (125, 100), "RPROG : 400 mA (table TP4056) ; USB 2.0 : 400 + 106 mA système")
C("C21", "10u", "VBAT", "GND", B, (150, 95), "Sortie BAT du TP4056", fp=C0805, mpn="10 µF 16 V X5R 0805", price=0.03)
R("R23", "1k", "VBUS_F", "CHRG_A", B, (100, 125), "LED charge")
P("D9", "Device", "LED", "rouge", LED0603, {"2": "CHRG_A", "1": "CHRG_N"}, B,
  mpn="LED rouge 0603", desc="En charge", price=0.02, pos=(100, 145))
R("R24", "1k", "VBUS_F", "STDBY_A", B, (115, 125), "LED fin de charge")
P("D10", "Device", "LED", "verte", LED0603, {"2": "STDBY_A", "1": "STDBY_N"}, B,
  mpn="LED verte 0603", desc="Chargé", price=0.02, pos=(115, 145))

P("J2", "Connector_Generic", "Conn_01x02", "LiPo 2000mAh",
  "Connector_JST:JST_PH_B2B-PH-K_1x02_P2.00mm_Vertical",
  {"1": "VBAT", "2": "BAT_N"}, B, mpn="JST B2B-PH-K + cellule LiPo 3,7 V 2000 mAh (ex. 803860)",
  desc="Batterie", price=0.10, pos=(30, 190))
P("U6", "boitier_ltc", "DW01A", "DW01A", "Package_TO_SOT_SMD:SOT-23-6",
  {"1": "DW_OD", "2": "DW_CS", "3": "DW_OC", "4": "~", "5": "DW_VCC", "6": "BAT_N"},
  B, mpn="Fortune DW01A", desc="Protection 1 cellule : 4,28 V / 2,40 V / 0,16 V", price=0.06,
  pos=(80, 190))
R("R25", "470", "VBAT", "DW_VCC", B, (60, 170), "Filtre VCC DW01A (>= 470 ohms)")
C("C22", "100n", "DW_VCC", "BAT_N", B, (60, 205), "Filtre VCC DW01A")
R("R26", "2k", "DW_CS", "GND", B, (105, 215), "CS DW01A (1-3 kohms)")
P("Q2", "boitier_ltc", "FS8205A", "FS8205A", "Package_TO_SOT_SMD:SOT-23-6",
  {"1": "BAT_N", "2": "FS_D", "5": "FS_D", "3": "GND", "4": "DW_OC", "6": "DW_OD"},
  B, mpn="Fortune FS8205A", desc="Double N-MOS 20 V, 22,5 mohms @4,5 V", price=0.07,
  spice="RQ2a {1} {2} 0.025\nRQ2b {2} {3} 0.025", pos=(130, 195))

# Chemin d'alimentation : sur USB, le système est alimenté par VBUS via D3
# et la batterie est déconnectée de la charge par Q1 (le TP4056 charge
# alors une cellule sans courant parasite, la fin de charge C/10 reste juste).
P("D3", "Diode", "SS14", "SS14", "Diode_SMD:D_SMA", {"2": "VBUS_F", "1": "VSYS"}, B,
  mpn="Vishay SS14", desc="Schottky 40 V 1 A, VF 0,5 V @1 A", price=0.04,
  spice="DD3 {2} {1} SS14", pos=(175, 45))
P("Q1", "Transistor_FET", "AO3401A", "AO3401A", "Package_TO_SOT_SMD:SOT-23",
  {"1": "VBUS_F", "2": "VSYS", "3": "VBAT"}, B,
  mpn="Alpha & Omega AO3401A", desc="P-MOS 30 V, 60 mohms @4,5 V : batterie -> VSYS",
  price=0.04, spice="XQ1 {1} {2} {3} AO3401A", pos=(175, 85))
R("R27", "100k", "VBUS_F", "GND", B, (160, 125), "Rappel grille Q1 sans USB")
C("C23", "47u", "VSYS", "GND", B, (195, 125), "Réservoir VSYS (pointes radio)", fp=C1206,
  mpn="47 µF 10 V X5R 1206", price=0.12, sval="35u", esr="5m")

P("SW1", "Switch", "SW_SPDT", "MARCHE/ARRET", "Button_Switch_SMD:SW_SPDT_PCM12",
  {"2": "LDO_EN", "1": "VSYS", "3": "GND"}, B, mpn="C&K PCM12SMTR (ou JS102011SAQN)",
  desc="Interrupteur marche/arrêt sur EN du LDO", price=0.45, spice=None, pos=(215, 85))
R("R28", "1M", "LDO_EN", "GND", B, (230, 115), "EN défini pendant la course de l'inverseur")
P("U1", "Regulator_Linear", "TLV75733PDBV", "TLV75733P", "Package_TO_SOT_SMD:SOT-23-5",
  {"1": "VSYS", "2": "GND", "3": "LDO_EN", "4": "~", "5": "+3V3"}, B,
  mpn="TI TLV75733PDBVR", desc="LDO 3,3 V 1 A, dropout 300 mV typ à 1 A", price=0.25,
  spice="XU1 {1} {2} {3} {5} TLV75733P", pos=(260, 70))
C("C24", "10u", "VSYS", "GND", B, (245, 100), "Entrée LDO", fp=C0805, mpn="10 µF 16 V X5R 0805", price=0.03,
  sval="7u", esr="5m")
C("C25", "22u", "+3V3", "GND", B, (280, 100), "Sortie LDO", fp=C0805, mpn="22 µF 10 V X5R 0805", price=0.05,
  sval="15u", esr="5m")
P("FB1", "Device", "FerriteBead", "220R@100MHz", "Inductor_SMD:L_0603_1608Metric",
  {"1": "+3V3", "2": "+3V3A"}, B, mpn="Murata BLM18PG221SN1D", desc="Isolation rail analogique",
  price=0.03, spice="LFB1 {1} FB1_m 1u\nRFB1 FB1_m {2} 0.1", pos=(300, 55))
C("C26", "10u", "+3V3A", "GND", B, (315, 80), "Rail analogique", fp=C0805, mpn="10 µF 10 V X5R 0805", price=0.03,
  sval="8u")
C("C27", "100n", "+3V3A", "GND", B, (330, 80), "Rail analogique HF")

R("R29", "220k", "VBAT", "VBAT_SENSE", B, (215, 165), "Mesure batterie (diviseur /2)")
R("R30", "220k", "VBAT_SENSE", "GND", B, (215, 195), "Mesure batterie")
C("C28", "100n", "VBAT_SENSE", "GND", B, (232, 195), "Filtre ADC")
R("R31", "100k", "VBUS_F", "VBUS_SENSE", B, (255, 165), "Détection USB (diviseur /2)")
R("R32", "100k", "VBUS_SENSE", "GND", B, (255, 195), "Détection USB")

# ============================================================================
# 2. ESP32-S3
# ============================================================================
B = "mcu"
esp_pins = {"1": "GND", "40": "GND", "41": "GND", "2": "+3V3", "3": "EN",
            "27": "IO0_BOOT", "13": "USB_DN", "14": "USB_DP",
            "36": "UART_RX", "37": "UART_TX"}
SYMPIN = {"IO1": "39", "IO2": "38", "IO4": "4", "IO5": "5", "IO6": "6", "IO7": "7",
          "IO15": "8", "IO16": "9", "IO17": "10"}
for io, net in GPIO.items():
    esp_pins[SYMPIN[io]] = net
for n in ["10", "11", "12", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24",
          "25", "26", "28", "29", "30", "31", "32", "33", "34", "35"]:
    esp_pins.setdefault(n, "~")
P("U2", "RF_Module", "ESP32-S3-WROOM-1", "ESP32-S3-WROOM-1-N8", "RF_Module:ESP32-S3-WROOM-1",
  esp_pins, B, mpn="Espressif ESP32-S3-WROOM-1-N8", desc="Module Wi-Fi/BLE, antenne PCB, 8 Mo flash",
  price=3.60, pos=(450, 110))
C("C30", "22u", "+3V3", "GND", B, (395, 55), "Découplage module (schéma de réf. Espressif)", fp=C0805,
  mpn="22 µF 10 V X5R 0805", price=0.05, sval="15u", esr="5m")
C("C31", "100n", "+3V3", "GND", B, (410, 55), "Découplage module")
R("R40", "10k", "+3V3", "EN", B, (380, 120), "RC EN recommandé : 10 kohms / 1 µF")
C("C32", "1u", "EN", "GND", B, (380, 150), "RC EN")
P("SW2", "Switch", "SW_Push", "RESET", "Button_Switch_SMD:SW_Push_1P1T_NO_CK_KMR2",
  {"1": "EN", "2": "GND"}, B, mpn="C&K KMR221G", desc="Reset", price=0.15, pos=(370, 180))
P("SW3", "Switch", "SW_Push", "BOOT", "Button_Switch_SMD:SW_Push_1P1T_NO_CK_KMR2",
  {"1": "IO0_BOOT", "2": "GND"}, B, mpn="C&K KMR221G", desc="Démarrage en téléchargement", price=0.15,
  pos=(370, 200))
R("R41", "10k", "+3V3", "IO0_BOOT", B, (395, 200), "Rappel IO0")
P("J4", "Connector_Generic", "Conn_01x04", "UART", "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical",
  {"1": "+3V3", "2": "UART_TX", "3": "UART_RX", "4": "GND"}, B, mpn="Barrette 1x4 2,54 mm (non montée)",
  desc="Console série de secours", price=0.03, pos=(540, 60), dnp=True)
R("R42", "10k", "+3V3", "MODE", B, (520, 130), "Rappel MODE (RX si pôle B ouvert)")
C("C33", "100n", "MODE", "GND", B, (535, 130), "Anti-rebond MODE (tau = 1 ms)")
for i, (ref, net, col, desc) in enumerate([
        ("D5", "LED_TX", "rouge", "Mode TX"), ("D6", "LED_RX", "jaune", "Mode RX"),
        ("D7", "LED_SYNC", "verte", "Verrouillé / LTC présent"), ("D8", "LED_BAT", "verte", "Marche / batterie faible (clignote)")]):
    x = 380 + 20 * i
    R(f"R{43 + i}", "1k", net, f"{net}_K", B, (x, 235), f"LED {desc} (~1,3 mA)")
    P(ref, "Device", "LED", col, LED0603, {"2": f"{net}_K", "1": "GND"}, B,
      mpn=f"LED {col} 0603", desc=desc, price=0.02, pos=(x, 262))

# ============================================================================
# 3. BNC + COMMUTATION TX/RX
# ============================================================================
B = "bnc"
P("J3", "Connector", "Conn_Coaxial", "BNC 75R", "Connector_Coaxial:BNC_Amphenol_031-6575_Horizontal",
  {"1": "BNC_C", "2": "GND"}, B, mpn="BNC femelle 75 ohms de panneau (ex. Amphenol RF 031-10-RFXG1)",
  desc="Prise timecode unique", price=3.00, pos=(30, 300))
P("D1", "Diode", "SMAJ15CA", "SMAJ15CA", "Diode_SMD:D_SMA", {"1": "BNC_C", "2": "GND"}, B,
  mpn="Littelfuse SMAJ15CA", desc="TVS bidirectionnelle 15 V (VBR 16,7 V min)", price=0.08,
  spice="XD1 {1} {2} SMAJ15CA", pos=(50, 330))
# Inverseur à glissière 2 circuits / 2 positions. Position TX : B-A ; RX : B-C.
P("SW4", "Switch", "SW_DPDT_x2", "TX/RX", "Button_Switch_THT:SW_Slide_SPDT_Angled_CK_OS102011MA1Q",
  {"2": "BNC_C", "1": "LTC_IN_RAW", "3": "LTC_OUT_BNC"}, B,
  mpn="C&K JS202011JCQN (2P2T, contacts or) ou E-Switch EG2208", desc="Sélecteur TX/RX, pôle A : aiguillage BNC",
  price=0.70, unit=1, pos=(75, 300),
  spice="SSW4a {2} {1} mode_tx 0 SWCONT\nSSW4c {2} {3} mode_rx 0 SWCONT\nCSW4a {2} {1} 1p\nCSW4c {2} {3} 1p")
P("SW4", "Switch", "SW_DPDT_x2", "TX/RX", "", {"5": "MODE", "4": "GND", "6": "~"}, B,
  unit=2, pos=(520, 175), spice=None)

# ============================================================================
# 4. ENTREE LTC (mode TX)
# ============================================================================
B = "entree"
R("R1", "1M", "LTC_IN_RAW", "GND", B, (100, 330), "Fixe le potentiel du contact au repos")
C("C1", "100n", "LTC_IN_RAW", "IN_AC", B, (115, 300), "Liaison : coupe le continu (100 V)", fp=C0805,
  mpn="100 nF 100 V X7R 0805")
R("R2", "10k", "IN_AC", "IN_A", B, (140, 300), "Limite le courant d'écrêtage, Zin >= 10 kohms")
P("D2", "Diode", "BAT54S", "BAT54S", "Package_TO_SOT_SMD:SOT-23",
  {"1": "GND", "2": "+3V3A", "3": "IN_A"}, B, mpn="Nexperia BAT54S", desc="Écrêtage aux rails",
  price=0.03, spice="XD2 {1} {2} {3} BAT54S", pos=(160, 335))
C("C2", "680p", "IN_A", "GND", B, (178, 335), "Passe-bas 25 kHz (antiparasite)", mpn="680 pF C0G 0603")
R("R3", "100k", "IN_A", "VMID", B, (195, 335), "Polarisation à VCC/2")
R("R4", "1k", "IN_A", "CMP_INN", B, (210, 300), "Second étage de limitation")
R("R5", "47k", "+3V3A", "VMID", B, (110, 380), "Diviseur VMID")
R("R6", "47k", "VMID", "GND", B, (125, 395), "Diviseur VMID")
C("C3", "10u", "VMID", "GND", B, (140, 395), "Découplage VMID", fp=C0805, mpn="10 µF 10 V X5R 0805",
  price=0.03, sval="8u")
R("R7", "10k", "VMID", "CMP_INP", B, (165, 380), "Hystérésis (pont R7/R8)")
R("R8", "470k", "CMP_OUT", "CMP_INP", B, (185, 380), "Hystérésis : +/-34 mV")
P("U3", "boitier_ltc", "TLV3201", "TLV3201", "Package_TO_SOT_SMD:SOT-23-5",
  {"1": "CMP_OUT", "2": "GND", "3": "CMP_INP", "4": "CMP_INN", "5": "+3V3A"}, B,
  mpn="TI TLV3201AIDBVR", desc="Comparateur 40 ns push-pull RRI", price=0.55,
  spice="XU3 {1} {2} {3} {4} {5} TLV3201", pos=(240, 320))
C("C4", "100n", "+3V3A", "GND", B, (240, 360), "Découplage U3")
R("R9", "100", "CMP_OUT", "LTC_RX_GPIO", B, (270, 300), "Série vers GPIO (limite courant si GPIO mal configurée)")

# ============================================================================
# 5. SORTIE LTC (mode RX)
# ============================================================================
B = "sortie"
R("R10", "10k", "LTC_TX_GPIO", "OUT_SH", B, (330, 300), "Mise en forme : Rth 6 kohms")
R("R11", "30k", "+3V3A", "OUT_SH", B, (345, 270), "Recentrage à VCC/2")
R("R12", "30k", "OUT_SH", "GND", B, (360, 335), "Recentrage à VCC/2")
C("C5", "1.8n", "OUT_SH", "GND", B, (375, 335), "Front 10-90 % = 2,2 x 6k x 1,8n = 24 µs", mpn="1,8 nF C0G 0603")
P("U4", "Amplifier_Operational", "TLV9061xDBV", "TLV9061", "Package_TO_SOT_SMD:SOT-23-5",
  {"1": "OPA_OUT", "2": "GND", "3": "OUT_SH", "4": "OPA_OUT", "5": "+3V3A"}, B,
  mpn="TI TLV9061IDBVR", desc="AOP RRIO 10 MHz, 50 mA", price=0.35,
  spice="XU4 {1} {2} {3} {4} {5} TLV9061", pos=(405, 315))
C("C6", "100n", "+3V3A", "GND", B, (405, 360), "Découplage U4")
R("R13", "56", "OPA_OUT", "OUT_P", B, (440, 300), "Impédance de sortie (1/2)")
P("D4", "Diode", "BAT54S", "BAT54S", "Package_TO_SOT_SMD:SOT-23",
  {"1": "GND", "2": "+3V3A", "3": "OUT_P"}, B, mpn="Nexperia BAT54S", desc="Protection sortie",
  price=0.03, spice="XD4 {1} {2} {3} BAT54S", pos=(455, 340))
C("C7", "47u", "OUT_P", "OUT_AC", B, (480, 300), "Liaison (2 x 47 µF X5R)", fp=C1206,
  mpn="47 µF 10 V X5R 1206", price=0.12, sval="37u")
C("C8", "47u", "OUT_P", "OUT_AC", B, (480, 330), "Liaison", fp=C1206, mpn="47 µF 10 V X5R 1206", price=0.12,
  sval="37u")
R("R14", "22", "OUT_AC", "LTC_OUT_BNC", B, (510, 300), "Impédance de sortie (2/2) : total 78 ohms")
R("R15", "100k", "LTC_OUT_BNC", "GND", B, (530, 330), "Décharge, BNC à 0 V continu")


# ============================================================================
# Mise en page du schéma KiCad (mm, rotation en degrés) : n'influe que sur le dessin
# ============================================================================
LAYOUT = {
    # 1. alimentation
    "J1": (35, 75, 0), "R20": (60, 112, 0), "R21": (72, 112, 0), "F1": (72, 42, 90), "C20": (90, 62, 0),
    "U5": (125, 65, 0), "R22": (112, 98, 0), "C21": (152, 92, 0), "R23": (95, 112, 0), "D9": (95, 135, 90),
    "R24": (125, 112, 0), "D10": (125, 135, 90),
    "J2": (30, 168, 0), "R25": (55, 158, 0), "C22": (55, 180, 0), "U6": (88, 170, 0), "R26": (110, 185, 0),
    "Q2": (140, 170, 0),
    "D3": (180, 42, 0), "Q1": (180, 72, 0), "R27": (165, 100, 0), "C23": (195, 100, 0),
    "SW1": (220, 72, 0), "R28": (235, 100, 0), "U1": (265, 55, 0), "C24": (250, 95, 0), "C25": (285, 95, 0),
    "FB1": (305, 50, 90), "C26": (318, 75, 0), "C27": (332, 75, 0),
    "R29": (220, 148, 0), "R30": (220, 172, 0), "C28": (236, 172, 0), "R31": (262, 148, 0), "R32": (262, 172, 0),
    # 2. ESP32
    "U2": (455, 110, 0), "C30": (395, 45, 0), "C31": (410, 45, 0), "R40": (385, 100, 0), "C32": (385, 125, 0),
    "SW2": (382, 150, 0), "SW3": (382, 172, 0), "R41": (405, 172, 0), "J4": (550, 45, 0),
    "R42": (525, 110, 0), "C33": (540, 110, 0), "SW4.2": (530, 150, 0),
    "R43": (385, 195, 0), "D5": (385, 218, 90), "R44": (405, 195, 0), "D6": (405, 218, 90),
    "R45": (425, 195, 0), "D7": (425, 218, 90), "R46": (445, 195, 0), "D8": (445, 218, 90),
    # 3. BNC + entrée
    "J3": (30, 232, 0), "D1": (45, 262, 270), "SW4": (75, 232, 0), "R1": (95, 262, 0), "C1": (112, 232, 90),
    "R2": (137, 232, 90), "D2": (158, 262, 0), "C2": (176, 262, 0), "R3": (190, 262, 0), "R4": (207, 232, 90),
    "U3": (245, 248, 0), "C4": (245, 285, 0), "R9": (275, 232, 90),
    "R5": (112, 300, 0), "R6": (112, 322, 0), "C3": (127, 322, 0), "R7": (165, 305, 90), "R8": (195, 305, 90),
    # 4. sortie
    "R10": (330, 275, 90), "R11": (348, 272, 0), "R12": (348, 305, 0), "C5": (362, 305, 0),
    "U4": (392, 287, 0), "C6": (392, 322, 0), "R13": (425, 275, 90), "D4": (440, 305, 0),
    "C7": (462, 275, 90), "C8": (462, 292, 90), "R14": (495, 275, 90), "R15": (515, 302, 0),
}
for _p in PARTS:
    _k = _p["ref"] + (f".{_p['unit']}" if _p["unit"] > 1 else "")
    if _k in LAYOUT:
        x, y, r = LAYOUT[_k]
        _p["pos"], _p["rot"] = (x, y), r


def nets():
    out = {}
    for p in PARTS:
        for pin, n in p["pins"].items():
            if n != "~":
                out.setdefault(n, []).append((p["ref"], pin))
    return out


if __name__ == "__main__":
    for n, conns in sorted(nets().items()):
        print(f"{n:14s} {' '.join(r + '.' + p for r, p in conns)}")
    singles = [n for n, c in nets().items() if len(c) < 2]
    print("nets à une seule connexion :", singles)
