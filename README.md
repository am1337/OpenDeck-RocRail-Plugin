# Rocrail Loco Control - OpenDeck Plugin

OpenAction API plugin for OpenDeck that connects to Rocrail to control model trains using a Stream Deck (e.g. AJAZZ AKP03 with OLED buttons, simple buttons, and dials).

This is the initial version of the plugin mainly created with Cursor AI and tested with an Ajazz AKP03E (rev. 2) on linux (flatpak version).

## Requirements

- [OpenDeck](https://github.com/nekename/OpenDeck)
- [Rocrail](https://wiki.rocrail.net) (server running, default port 8051)
- Node.js 20+ (for running the plugin)
- Stream Deck or compatible device (e.g. AJAZZ AKP03)

## Installation

1. Install dependencies:
   ```bash
   cd com.rocrail.lococontrol.sdPlugin
   npm install
   ```

2. Copy the `com.rocrail.lococontrol.sdPlugin` folder to your OpenDeck plugins directory:
   - Open OpenDeck → Settings → "Open config directory"
   - Copy the plugin folder into the `plugins` subfolder

3. Restart OpenDeck

## Configuration

1. Add any Rocrail action to a button
2. In the Property Inspector, configure:
   - **Host**: Rocrail server address (default: 127.0.0.1)
   - **Port**: Rocrail RCP port (default: 8051)

## Button Layout

Suggested layout for your AJAZZ AKP03:

| Button Type | Action | Usage |
|-------------|--------|-------|
| OLED 1-6 | Rocrail OLED Button | Loco list, functions, or speed display |
| Simple | Rocrail Direction Fwd | Forward direction |
| Simple | Rocrail Direction Rev | Reverse direction |
| Dial | Rocrail Speed Dial | Rotate: speed, Press: stop |
| Simple | Rocrail Back | Return to loco list (stops loco) |
| Simple | Rocrail Scroll Up | Scroll list up |
| Simple | Rocrail Scroll Down | Scroll list down |

## Usage

### 1. Loco List View (default)
- **OLED buttons**: Show one loco per button
- **Dial/Scroll**: Scroll through loco list if more locos than buttons
- **Press OLED**: Select loco → switches to Function View

### 2. Function View
- **OLED buttons**: Show one function per button (description or F0, F1, …)
- **Press OLED**: Toggle function on/off
- **Dial/Scroll**: Scroll through function list
- **Direction buttons**: Switch to Throttle View and set direction
- **Back**: Return to Loco List (stops loco)

### 3. Throttle View
- **OLED**: Shows direction (→/←) and speed (% or km/h as provided by Rocrail)
- **Direction buttons**: Change direction
- **Dial clockwise**: Increase speed
- **Dial counterclockwise**: Decrease speed
- **Dial press**: Stop (V=0)
- **Back**: Return to Loco List (stops loco)

## Rocrail Protocol

The plugin uses the Rocrail Client Protocol (RCP) over TCP:
- `model cmd="lclist"` – fetch loco list
- `model cmd="lcprops" val="locoID"` – fetch loco details and functions
- `lc cmd="velocity"` – set speed
- `lc cmd="direction"` – set direction
- `fn cmd="on"/"off"` – toggle functions

Default port: **8051**

## License

Apache License Version 2.0
