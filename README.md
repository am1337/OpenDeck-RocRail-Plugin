# Rocrail Loco Control – OpenDeck Plugin

OpenAction API plugin for OpenDeck that connects to Rocrail to control model trains using a Stream Deck (for example AJAZZ AKP03 with OLED buttons, simple buttons, and dials).

This is the initial version of the plugin, mainly created with Cursor AI and tested with an Ajazz AKP03E (rev. 2) on Linux (Flatpak).

## Requirements

- [OpenDeck](https://github.com/nekename/OpenDeck)
- [Rocrail](https://wiki.rocrail.net) running with client access (**RCP over TCP**, default control port **8051**)
- Rocrail’s **web / HTTP service enabled** where you host locomotive images (often port **8080**; depends on Rocview/Rocweb settings)
- Node.js 20 or newer (bundled invocation by OpenDeck / OpenAction)

## Installation

1. Install dependencies:
   ```bash
   cd com.rocrail.lococontrol.sdPlugin
   npm install
   ```

2. Copy the `com.rocrail.lococontrol.sdPlugin` folder to your OpenDeck plugins directory  
   Open OpenDeck → Settings → “Open config directory” → drop the folder into `plugins`.

3. Restart OpenDeck.

## Configuration (global vs per OLED key)

Rocrail’s **RCP client/server** channel (TCP control port), **HTTP image service**, scrolling behaviour, default font size on OLED tiles (composite image text and OLED button titles), etc. live in **global plugin settings**.

Global options (Rocrail TCP, HTTP image service, font size, scroll step) are edited from **any** Rocrail Property Inspector instance—**you only need to open the inspector once for those shared fields**; they apply to the whole plugin/profile.

**Throttle view** (Functions / Loco / Speed) is **stored per OLED button**: open the inspector on each OLED key you want to change and choose its mode.
   - **Rocrail TCP host / port**: must match where Rocrail accepts **client protocol** commands (Rocview/OpenDecoder‑style TCP, commonly **8051** per [Rocrail protocol](https://wiki.rocrail.net/doku.php?id=develop:cs-protocol-en)).
   - **HTTP port / base path** and optional **local image directory**: locomotive composites are fetched from  
     `http://<TCP host>:<http port>/<path>/<image filename>` (see Rocview image / web‑service docs). Matching host is usually the same PC as Rocrail; use your real HTTP listener port.
   - **OLED composite / labelled text font size** (pixels, optional): empty keeps automatic sizing; non‑zero values propagate to composites and OLED titles (when the host honours `setTitleParameters`).
   - **Scroll …**: default mode is **one page per encoder step** (visible OLED count).

**Throttle view (Rocview terminology)** is **only for OLED keys** while a locomotive is selected:

Open the Property Inspector on **any** placed Rocrail action to reach the shared server / image / scroll / font fields. **Throttle view** requires opening the inspector **on that specific OLED slot** (stored per action instance).

## Button suggestions

| Hardware | Action | Typical use |
|---------|--------|-------------|
| OLED | Rocrail OLED Button | Loco list tiles; throttle functions/loco/speed (per‑key inspector option) |
| Simple | Direction Fwd / Rev | Toggle direction (`lc.direction`) |
| Simple | Stop loco / Speed +5% / −5% | Convenience speed keys |
| Encoder | Rocrail Speed Dial | Speed steps in throttle (`lc.velocity`); press stop when throttle screen active |
| Encoder | List scroll dial | Scroll locos or function page |
| Simple | Scroll up / down | Same scrolling with buttons |
| Simple | Back | Release loco, return to loco list, stop |

## Usage

### Loco list (default)

Each OLED tile shows either a **loco composite** (narrow/wide artwork is **cropped on the left** so the locomotive stays right‑aligned) or name‑only fallback. Busy locos locked on another desk show `[busy]` as text.

Encoder, OLED dial rotate, or dedicated scroll hardware moves through the roster (wrap). Default scroll advances **by one page** per step count of OLEDs.

### Throttle mode (after selecting a loco)

- **Functions** OLEDs (default): monochrome keys with wrapped function labels (`fn` replay); presses toggle decoder functions only. Direction and velocity are not sent separately on each toggle; the `<fn/>` snapshot mirrors **live throttle state** (`V`, `dir`, and all relevant `f0`–`fn` bits). At startup their on/off hints are seeded from **`lclist` + `<model cmd="plan"/>` snippets** merged into an internal cache, then kept up to date from RCP pushes while you browse the roster.
- **Loco portrait** OLED: Tap returns to **loco list** (releases the locomotive like **Back**).
- **Speed & direction** OLED: Solid **black** key with light text; while **moving** (percent throttle &gt; 0 **or** `V_realkmh` &gt; 0), tap sends **speed 0**. When stopped, tap **toggles direction** (forward ⇄ reverse).

Dedicated **Fwd/Rev**, **speed dial**, **±5 %**, and **hard stop** keys still issue separate `direction` / `velocity` commands.

### Back

Stops velocity, sends `release`, and returns to loco selection.

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
