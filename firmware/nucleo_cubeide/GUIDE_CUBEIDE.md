# NUCLEO-H753ZI sous STM32CubeIDE : client tally ATEM

Le RJ45 du H753ZI ne fonctionne pas avec Arduino IDE : la bibliothèque STM32Ethernet ne gère pas l'Ethernet du H7. On passe donc par **STM32CubeIDE**, l'outil officiel de ST. Il génère le pilote Ethernet et la pile réseau LwIP ; on y ajoute deux fichiers : `atem_client.c` et `atem_client.h`.

Le câblage vers l'ESP32 ne change pas : **D1 (PB6) → RX2 (GPIO16)**, D0 (PB7) ← TX2 (GPIO17), GND ↔ GND. Le code de l'ESP32 émetteur et des tallys reste le même.

Ce code est vérifié en syntaxe, mais il n'a pas encore tourné sur la carte. Les réglages mémoire de l'étape 4 sont ceux qu'ST recommande pour l'Ethernet du H7 ; c'est l'étape où une erreur empêche le réseau de démarrer.

---

## 1. Installer STM32CubeIDE

Sur st.com, cherchez **STM32CubeIDE**, prenez la version **macOS**, créez un compte si besoin, puis installez-le. Il contient son propre programmateur : pas besoin de STM32CubeProgrammer ni d'OpenOCD.

## 2. Créer le projet

1. **File → New → STM32 Project**.
2. Onglet **Board Selector**, cherchez **NUCLEO-H753ZI**, sélectionnez-la, **Next**.
3. Nom du projet : `tally_nucleo`. Laissez **C** et **Executable**, **Finish**.
4. À la question « Initialize all peripherals with their default Mode? », répondez **Yes**.

La vue du microcontrôleur s'ouvre (fichier `tally_nucleo.ioc`). Tous les réglages des étapes 3 et 4 se font là.

## 3. Réglages des périphériques

### Ethernet
**Connectivity → ETH** :
- Mode : **RMII** (normalement déjà réglé).
- Onglet **Parameter Settings** :
  - Tx Descriptor Address : `0x30040060`
  - Rx Descriptor Address : `0x30040000`
  - Rx Buffers Address (si le champ existe) : `0x30040200`
  - Rx Buffers Length : `1536`

### Liaison vers l'ESP32 (USART1 sur D1/D0)
1. **Connectivity → USART1** : Mode **Asynchronous**. Parameter Settings : **115200** bauds, 8 bits, None, 1 stop.
2. Sur le dessin de la puce, cliquez sur la broche **PB6** et choisissez **USART1_TX**, puis sur **PB7** et choisissez **USART1_RX**. Si CubeIDE signale que PB7 servait à une LED, acceptez.

### Port série du ST-Link (messages)
**Connectivity → USART3** : déjà en Asynchronous. Vérifiez **115200** bauds.

### Pile réseau LwIP
**Middleware and Software Packs → LWIP** : cochez **Enabled**.
- Onglet **General Settings** :
  - LWIP_DHCP : **Disabled**
  - IP_ADDRESS : `192.168.2.51`
  - NETMASK_ADDRESS : `255.255.255.0`
  - GATEWAY_ADDRESS : `192.168.2.1`
- Onglet **Platform Settings** : **LAN8742** dans les deux colonnes (Driver_PHY).

### Cache et MPU
**System Core → CORTEX_M7** : laissez **CPU ICache** et **CPU DCache** sur **Disabled**. Ainsi, pas besoin de régler la MPU.

Enregistrez (Cmd + S) et acceptez **la génération du code**.

## 4. Placer les tampons Ethernet en mémoire D2

Le contrôleur Ethernet du H7 ne peut lire que certaines zones de RAM. Ouvrez **`STM32H753ZITX_FLASH.ld`** à la racine du projet. Juste avant la ligne `.ARM.attributes 0 : { *(.ARM.attributes) }` (vers la fin), ajoutez :

```
  .lwip_sec (NOLOAD) :
  {
    . = ABSOLUTE(0x30040000);
    *(.RxDecripSection)
    . = ABSOLUTE(0x30040060);
    *(.TxDecripSection)
    . = ABSOLUTE(0x30040200);
    *(.Rx_PoolSection)
  } >RAM_D2
```

## 5. Ajouter le client ATEM

1. Copiez `atem_client.c` dans **Core/Src** et `atem_client.h` dans **Core/Inc**. Vous pouvez les glisser dans l'arborescence du projet à gauche, en choisissant « Copy files ».
2. Si l'ATEM n'est pas en 192.168.2.20, changez `ATEM_IP0` à `ATEM_IP3` dans `atem_client.h`.
3. Ouvrez **Core/Src/main.c** et ajoutez ces lignes **entre les commentaires USER CODE** déjà présents. Ce qui est écrit entre ces commentaires est conservé quand CubeIDE régénère le code.

```c
/* USER CODE BEGIN Includes */
#include "atem_client.h"
#include "lwip.h"
/* USER CODE END Includes */
```

```c
  /* USER CODE BEGIN SysInit */
  __HAL_RCC_D2SRAM1_CLK_ENABLE();
  __HAL_RCC_D2SRAM2_CLK_ENABLE();
  __HAL_RCC_D2SRAM3_CLK_ENABLE();
  /* USER CODE END SysInit */
```

```c
  /* USER CODE BEGIN 2 */
  atem_init(&huart1, &huart3);
  /* USER CODE END 2 */
```

```c
    /* USER CODE BEGIN 3 */
    MX_LWIP_Process();
    atem_tick();
  }
  /* USER CODE END 3 */
```

Pour le dernier bloc, les deux lignes vont **à l'intérieur** de la boucle `while (1)`, juste après `/* USER CODE BEGIN 3 */`.

## 6. Compiler et téléverser

1. Cliquez sur le **marteau** (Build). La console doit finir par `Build Finished. 0 errors`.
2. Branchez le Nucleo (USB du ST-Link) et cliquez sur la **flèche verte** (Run). À la première fois, validez la fenêtre de configuration avec **OK**.
3. Si CubeIDE propose de **mettre à jour le firmware du ST-Link**, acceptez : cela fera aussi apparaître le port série `/dev/cu.usbmodem…` sur le Mac.
4. Si la connexion échoue (« No target connected » ou « Could not connect »), ouvrez **Run → Run Configurations… → Debugger** et réglez **Reset behaviour** sur **Connect under reset**, puis relancez.

## 7. Vérifier

Branchez le RJ45 du Nucleo à l'ATEM. Dans le Terminal du Mac :

```
screen /dev/cu.usbmodem* 115200
```

Vous devez voir :

```
Nucleo pret, ATEM 192.168.2.20
Cable RJ45 branche
Connecte a l'ATEM
Tally ATEM : 1:PGM 2:PVW 3:- 4:- 5:- 6:- 7:- 8:-
```

La LED verte LD1 s'allume quand l'ATEM est connecté, la rouge LD3 sinon. Pour quitter `screen` : Ctrl + A, puis K, puis Y.

Ensuite, l'ESP32 émetteur reçoit le tally sur RX2 et le diffuse aux tallys, sans rien changer à son code.

## En cas de problème

| Ce que vous voyez | Cause probable |
|---|---|
| Rien dans `screen` | Mauvais port, ou firmware ST-Link sans port série : faites la mise à jour proposée par CubeIDE. |
| « Cable RJ45 debranche » en continu | Câble, ou PHY mal réglé : vérifiez LAN8742 dans Platform Settings. |
| Câble branché, mais jamais « Connecte » | Adresse de l'ATEM ou du Nucleo, ou tampons Ethernet mal placés (étape 4). Vérifiez avec `ping 192.168.2.51` depuis le Mac. |
| La carte plante au démarrage (HardFault) | Section `.lwip_sec` de l'étape 4 absente ou mal placée. |
