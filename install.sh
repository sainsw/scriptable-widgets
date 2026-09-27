#!/bin/bash
# Copies the widget scripts into Scriptable's iCloud Drive folder, so they
# reach the phone without copying and pasting. Run on a Mac signed in to the
# same iCloud account as the phone: ./install.sh
#
# bin-day.js becomes "Bin Day.js", toyota.js "Toyota.js", and so on,
# unless the script names itself with a "// Scriptable name: …" line: for a
# name a filename can't give, or a script already in use under another name.
# Scriptable keeps each script's icon in a few comment lines at the top of
# its copy; those are kept, so the icons don't change.
set -euo pipefail
cd "$(dirname "$0")"

dest="$HOME/Library/Mobile Documents/iCloud~dk~simonbs~Scriptable/Documents"
if [ ! -d "$dest" ]; then
	echo "No Scriptable folder in iCloud Drive at $dest" >&2
	echo "Open Scriptable on the phone with iCloud Drive turned on for it, then try again." >&2
	exit 1
fi

for src in *.js; do
	name=$(sed -n 's|^// Scriptable name: *||p' "$src" | head -1)
	if [ -n "$name" ]; then
		name="$name.js"
	else
		for word in $(tr '-' ' ' <<<"$src"); do
			name+="${name:+ }$(tr '[:lower:]' '[:upper:]' <<<"${word:0:1}")${word:1}"
		done
	fi
	target="$dest/$name"
	{
		if [ -f "$target" ]; then
			sed -n '/^\/\/ Variables used by Scriptable\./,/^\/\/ icon-/p' "$target"
		fi
		cat "$src"
	} >"$target.tmp"
	mv "$target.tmp" "$target"
	echo "Installed $name"
done
