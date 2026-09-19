#!/bin/bash
set -e


cd com.marikar.rocrailcontrol.sdPlugin
npm ci

# sharp loads its native binaries from optional @img/* packages, but npm only
# installs the ones matching the host OS/CPU. Download the missing desktop
# platforms at the versions pinned in package-lock.json so the packaged plugin
# runs on Windows and macOS without a user-side npm install.
SPECS=$(node -e '
  const lock = require("./package-lock.json");
  const wanted = [
    "@img/sharp-win32-x64",
    "@img/sharp-darwin-x64", "@img/sharp-libvips-darwin-x64",
    "@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64",
    "@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64",
    "@img/sharp-linuxmusl-x64", "@img/sharp-libvips-linuxmusl-x64",
    "@img/sharp-linux-arm64", "@img/sharp-libvips-linux-arm64",
    "@img/sharp-linuxmusl-arm64", "@img/sharp-libvips-linuxmusl-arm64",
  ];
  for (const [k, v] of Object.entries(lock.packages)) {
    const name = k.replace(/^node_modules\//, "");
    if (wanted.includes(name)) console.log(`${name}@${v.version}`);
  }
')

for spec in $SPECS; do
  name="${spec%@*}"
  dest="node_modules/$name"
  if [ -d "$dest" ]; then continue; fi
  echo "adding $spec"
  mkdir -p "$dest"
  tgz=$(npm pack "$spec" --silent)
  tar -xzf "$tgz" -C "$dest" --strip-components=1
  rm -f "$tgz"
done
cd -

rm -f com.marikar.rocrailcontrol.streamDeckPlugin && zip -r com.marikar.rocrailcontrol.streamDeckPlugin com.marikar.rocrailcontrol.sdPlugin
