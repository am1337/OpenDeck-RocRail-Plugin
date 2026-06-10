# Rocrail Loco Control – OpenDeck Plugin

OpenAction API plugin for OpenDeck that connects to Rocrail to control model trains using a Stream Deck (for example AJAZZ AKP03 with OLED buttons, simple buttons, and dials).

This is the initial version of the plugin, mainly created with Cursor AI and tested with an Ajazz AKP03E (rev. 2) on Linux (Flatpak).

## Requirements

- [OpenDeck](https://github.com/nekename/OpenDeck)
- [Rocrail](https://wiki.rocrail.net) running with client access (**RCP over TCP**, default control port **8051**)
- Rocrail’s **web / HTTP service enabled** where you host locomotive images and function icons (often port **8080**; depends on Rocview/Rocweb settings)
- Node.js **20 or newer** installed natively (OpenDeck itself runs `node --version` and refuses to start any JS plugin below v20.0.0, so Node 18 cannot be used)

## Build

1. Install dependencies:
   ```bash
   cd com.rocrail.lococontrol.sdPlugin
   npm install
   ```
2. Create archive
   zip -r com.rocrail.lococontrol.streamDeckPlugin com.rocrail.lococontrol.sdPlugin

## Installation

1. Build or download `com.rocrail.lococontrol.streamDeckPlugin` from github

2. On OpenDeck go to `Plugins` choose `Install from file` and select the built or downloaded file.

3. Restart OpenDeck.

## Configuration (global vs per OLED key)

Rocrail’s **RCP client/server** channel (TCP control port), **HTTP image service**, scrolling behaviour, default font size on OLED tiles (composite image text and OLED button titles), etc. live in **global plugin settings**.

Global options (Rocrail TCP, HTTP image service, font size, scroll step) are edited from **any** Rocrail Property Inspector instance—**you only need to open the inspector once for those shared fields**; they apply to the whole plugin/profile.

**Throttle view** (Functions / Loco / Speed &amp; direction / Speed only / Direction only) is **stored per OLED button**: open the inspector on each OLED key you want to change and choose its mode.
   - **Rocrail TCP host / port**: must match where Rocrail accepts **client protocol** commands (Rocview/OpenDecoder‑style TCP, commonly **8051** per [Rocrail protocol](https://wiki.rocrail.net/doku.php?id=develop:cs-protocol-en)).
   - **HTTP port / base path**: locomotive composites are fetched from  
     `http://<TCP host>:<http port>/<image base path>/<image filename>` (see Rocview image / web‑service docs). Matching host is usually the same PC as Rocrail; use your real HTTP listener port.
   - **HTTP base path for function icons** (optional): when a function defines an `icon`, it is fetched from `http://<TCP host>:<http port>/<icon base path>/<icon filename>` and shown instead of the function label. Leave empty to reuse the loco image base path. Icons are cached (in memory and on disk) like loco images.
   - **OLED composite / labelled text font size** (pixels, optional, up to **48**): empty keeps automatic sizing; non‑zero values apply to loco composites, the speed tile, and function labels. Function labels are rendered **into the key image** (OpenDeck does not support `setTitleParameters`, so plain titles always use the host's fixed font).
   - **Displayed locos**: which locomotives appear in the list — **All locos** (default), **No locos in auto mode** (hides locos with `mode_auto="auto"`), or **No locos in auto or half-auto mode** (also hides locos with `mode_halfauto="halfauto"`).
   - **Scroll …**: default mode is **one page per encoder step** (visible OLED count).

**Throttle view (Rocview terminology)** is **only for OLED keys** while a locomotive is selected:

Open the Property Inspector on **any** placed Rocrail action to reach the shared server / image / scroll / font fields. **Throttle view** requires opening the inspector **on that specific OLED slot** (stored per action instance).

## Button suggestions

| Hardware | Action | Typical use |
|---------|--------|-------------|
| OLED | Rocrail OLED Button | Loco list tiles; throttle functions/loco/speed (per‑key inspector option) |
| OLED / Simple | Rocrail Accessory | Switch one turnout / signal / output, or watch a sensor / block (independent of loco control) |
| Simple | Direction Fwd / Rev | Toggle direction (`lc.direction`) |
| Simple | Stop loco / Speed +5% / −5% | Convenience speed keys |
| Encoder | Rocrail Speed Dial | Speed steps in throttle (`lc.velocity`); press stop when throttle screen active |
| Encoder | List scroll dial | Scroll locos or function page |
| Simple | Scroll up / down | Same scrolling with buttons |
| Simple | Back | Release loco, return to loco list, stop |

## Usage

### Loco list (default)

Each OLED tile shows either a **loco composite** (narrow/wide artwork is **cropped on the left** so the locomotive stays right‑aligned) or name‑only fallback. Busy locos locked on another desk show `[busy]` as text.

Encoder, OLED dial rotate, or dedicated scroll hardware moves through the roster (wrap). Default scroll advances **by one page** per step count of OLEDs, including the **final partial page** (extra tiles stay blank). Simple **scroll up/down** buttons still move **one loco row** at a time regardless of encoder page mode.

### Throttle mode (after selecting a loco)

- **Functions** OLEDs (default): monochrome keys with wrapped function labels (`fn` replay); presses toggle decoder functions only. When a function defines an `icon`, the fetched icon image is shown (centered on the on/off background) instead of the `F0`/name label. **Monochrome** (single‑colour) icons are automatically recoloured to contrast with the key background — black on the white *on* key, white on the black *off* key — so they never blend in; multi‑colour icons are shown unchanged. Direction and velocity are not sent separately on each toggle; the `<fn/>` snapshot mirrors **live throttle state** (`V`, `dir`, and all relevant `f0`–`fn` bits). At startup their on/off hints are seeded from **`lclist` + `<model cmd="plan"/>` snippets** merged into an internal cache, then kept up to date from RCP pushes while you browse the roster.
- **Loco portrait** OLED: Tap returns to **loco list** (releases the locomotive like **Back**).
- **Speed & direction** OLED: Solid **black** key with light speed text and a **forward/reverse arrow icon** (`icons/forward.svg` / `icons/reverse.svg`, recoloured to the key foreground); while **moving** (percent throttle &gt; 0 **or** `V_realkmh` &gt; 0), tap sends **speed 0**. When stopped, tap **toggles direction** (forward ⇄ reverse).
- **Speed only** OLED: shows just the speed on a black key; tap sends **speed 0** while moving.
- **Direction only** OLED: shows just the **forward/reverse arrow icon** on a black key; tap **toggles direction** (forward ⇄ reverse).

Dedicated **Fwd/Rev**, **speed dial**, **±5 %**, and **hard stop** keys still issue separate `direction` / `velocity` commands.

### Back

Stops velocity, sends `release`, and returns to loco selection.

### Accessory keys (track-diagram elements)

The **Rocrail Accessory** action binds one key to one element of the Rocrail plan ([track diagram elements](https://www.rocrail.online/doku.php?id=track-diagram-elements-en)) — completely **independent of loco selection**; a deck can also consist of accessory keys only.

- **Per-key settings** (inspector on that key): **Item ID** as named in the Rocrail plan, plus the **item type** — *Auto-detect* searches the plan by ID; explicit choices are turnout (`sw`, incl. crossings, three-way, decoupler), signal (`sg`), output/button (`co`), turntable (`tt`), and the status-only kinds sensor (`fb`), block (`bk`), track (`tk`).
- **Press**: turnouts, signals and outputs send `cmd="flip"`; turntables send `cmd="next"`. Status-only kinds ignore presses.
- **Display**: the tile shows the element name and a symbol reflecting the **live state** (turnout straight/thrown incl. three-way & double-slip positions, signal aspect colour, output on/off, sensor on/off, block free/reserved/occupied/closed, turntable bridge position). Initial states come from the plan loaded at startup; every Rocrail broadcast (`<sw/>`, `<sg/>`, `<co/>`, `<fb/>`, `<bk/>`, `<tt/>`, …) updates the affected tiles immediately.
- **Icons from the Rocrail server**: set the global **accessory SVG theme base path** (e.g. `/svg/themes/SpDrS60` when the HTTP service serves the Rocrail `svg` folder). The plugin then fetches the official theme symbols by their standard names (`turnoutleft-t.svg`, `signalmain-g.svg`, `sensor-on.svg`, `block-occ.svg`, `button-0-on.svg`, …) and caches them. When the path is empty or a file is missing, clear **built-in symbols** are drawn instead.

## Rocrail protocol (summary)

| Direction | Typical XML flavour |
|-----------|---------------------|
| List / props | `<model cmd="lclist"/>`, `<model cmd="lcprops" …/>` |
| Speed | `<lc … cmd="velocity"/>` |
| Dir | `<lc … cmd="direction"/>` |
| Functions | Rocview‑style merged `<fn …/>` snapshots (`V` / `dir` taken from updated UI props, so toggling functions does not reset unrelated throttle fields) |

Defaults: TCP control port **8051**, images often HTTP **8080**—adjust in the inspector.

## License

Apache License Version 2.0
