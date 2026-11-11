#!/usr/bin/env bash
# Build "apps/mac/build/MAS Office.app" (and with --dmg a disk image) from this repository. Run from anywhere.
#
#   apps/mac/scripts/build-app.sh [--dmg]
#
# The app bundles the daemon's JavaScript (mas-office with its panel, schemas and kit; mas-office-runtime;
# the Claude Agent SDK without its platform-specific CLI binary packages) and runs it with the Node.js the
# user has installed. The runtime starts the user's own installed `claude`; nothing here is a login.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mac="$(cd "$here/.." && pwd)"
repo="$(cd "$mac/../.." && pwd)"
dmg=0
for a in "$@"; do
  case "$a" in
    --dmg) dmg=1 ;;
    *) echo "usage: $0 [--dmg]" >&2; exit 2 ;;
  esac
done

version="$(node -p "require('$repo/packages/node/package.json').version")"
build="$mac/build"
app="$build/MAS Office.app"
work="$(mktemp -d "${TMPDIR:-/tmp}/mas-office-build.XXXXXX")"
cleanup() {
  # npm pack's postpack removes the copies prepack made in packages/node; make sure, even after a failure.
  node "$repo/packages/node/scripts/bundle.js" --clean > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

echo "▸ swift build -c release (MAS Office $version)"
swift build -c release --package-path "$mac" 2>&1 | grep -v "ld: warning: search path" || true
bin="$(swift build -c release --package-path "$mac" --show-bin-path)/MASOffice"
[[ -x "$bin" ]] || { echo "✗ release build failed" >&2; exit 1; }

echo "▸ assembling $app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/MASOffice"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>MAS Office</string>
  <key>CFBundleExecutable</key><string>MASOffice</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>com.xijiawei.masoffice</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>MAS Office</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Copyright © 2026 Xijia Wei. MIT License.</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>NSSupportsSuddenTermination</key><false/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST
printf 'APPL????' > "$app/Contents/PkgInfo"

echo "▸ app icon from docs/assets/logo.svg"
swiftc -O -o "$work/make-icon" "$here/make-icon.swift" 2>&1 | grep -v "ld: warning: search path" || true
"$work/make-icon" "$repo/docs/assets/logo.svg" "$work/AppIcon.iconset"
iconutil -c icns -o "$app/Contents/Resources/AppIcon.icns" "$work/AppIcon.iconset"

echo "▸ example team design (Setup Check ▸ Create from Example)"
mkdir -p "$app/Contents/Resources/examples/price-compare"
cp "$repo/examples/price-compare/mas/structure.js" "$app/Contents/Resources/examples/price-compare/structure.js"

echo "▸ daemon: mas-office, mas-office-runtime, @anthropic-ai/claude-agent-sdk"
daemon="$app/Contents/Resources/daemon"
mods="$daemon/node_modules"
mkdir -p "$mods"
pack() { # npm pack runs the package's prepack (bundling panel/, schemas/, kit/) and postpack (cleaning up);
          # the scripts' own lines come before npm's JSON on stdout
  (cd "$repo" && npm pack --workspace "$1" --pack-destination "$work" --json --silent) \
    | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write(JSON.parse(s.slice(s.search(/^\\[/m)))[0].filename))"
}
for pkg in mas-office mas-office-runtime; do
  tgz="$work/$(pack "$pkg")"
  mkdir -p "$mods/$pkg"
  tar -xzf "$tgz" -C "$mods/$pkg" --strip-components 1
done
sdk="$repo/node_modules/@anthropic-ai/claude-agent-sdk"
[[ -f "$sdk/package.json" ]] || { echo "✗ $sdk is missing: run npm install at the repository root" >&2; exit 1; }
mkdir -p "$mods/@anthropic-ai"
rsync -a --exclude node_modules "$sdk/" "$mods/@anthropic-ai/claude-agent-sdk/"
cat > "$daemon/package.json" <<JSON
{"private": true, "name": "mas-office-app-daemon", "version": "$version", "description": "The JavaScript MAS Office for macOS runs with the user's Node.js."}
JSON

echo "▸ checking the bundled daemon with the installed node ($(node --version))"
[[ ! -e "$mods/@anthropic-ai/claude-agent-sdk-darwin-arm64" && ! -e "$mods/@anthropic-ai/claude-agent-sdk-darwin-x64" ]] \
  || { echo "✗ a platform CLI binary package was bundled" >&2; exit 1; }
for d in panel schemas kit; do [[ -d "$mods/mas-office/$d" ]] || { echo "✗ mas-office/$d missing in the bundle" >&2; exit 1; }; done
(cd "$daemon" && node --input-type=module -e "
  const rt = await import('mas-office-runtime');
  await import('mas-office');
  await import('mas-office/server');
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  if (typeof rt.up !== 'function' || typeof sdk.query !== 'function') throw new Error('unexpected exports');
  console.log('  import(\"mas-office-runtime\") resolves inside the bundle: ok');
")
bundled="$(node "$mods/mas-office/bin/mas-office.js" --version)"
[[ "$bundled" == "$version" ]] || { echo "✗ bundled mas-office reports $bundled, expected $version" >&2; exit 1; }
echo "  mas-office --version from the bundle: $bundled"
[[ -z "$(git -C "$repo" status --porcelain -- packages/node/panel packages/node/schemas packages/node/kit packages/node/LICENSE)" ]] \
  || { echo "✗ npm pack left copies in packages/node" >&2; exit 1; }

echo "▸ ad-hoc signing"
codesign --force --deep -s - "$app"
codesign --verify --deep --strict "$app"

out_dmg=""
if [[ $dmg -eq 1 ]]; then
  echo "▸ disk image"
  stage="$work/dmg"
  mkdir -p "$stage"
  cp -R "$app" "$stage/"
  ln -s /Applications "$stage/Applications"
  out_dmg="$build/MAS-Office-$version.dmg"
  rm -f "$out_dmg"
  hdiutil create -volname "MAS Office" -srcfolder "$stage" -ov -format UDZO "$out_dmg" > /dev/null
fi

echo
echo "✓ $app  ($(du -sh "$app" | cut -f1); daemon $(du -sh "$daemon" | cut -f1))"
[[ -n "$out_dmg" ]] && echo "✓ $out_dmg  ($(du -sh "$out_dmg" | cut -f1))"
exit 0
