#!/usr/bin/env bash
# Build the GitHub Pages tree: index + each static demo as a subfolder.
# A demo is published when it has index.html and no vercel.json.
# If package.json is present, run `npm ci && npm run build` and publish dist/.
set -euo pipefail

demos="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$demos/.." && pwd)"
out="${1:-"$repo/_site"}"

if [ -z "$out" ] || [ "$out" = "." ] || [ "$out" = ".." ] || [ "$out" = "/" ]; then
    echo "assemble-pages: refusing to write to '${out:-<empty>}'" >&2
    exit 1
fi
case "$out" in
    -*)
        echo "assemble-pages: output path must not start with -" >&2
        exit 1
        ;;
esac
if [ "${out#/}" = "$out" ]; then
    out="$(pwd)/$out"
fi
out="${out%/}"
if [ "$out" = "$repo" ] || [ "$out" = "$demos" ]; then
    echo "assemble-pages: refusing to delete the repo or demos directory" >&2
    exit 1
fi
case "$repo" in
    "$out"|"$out"/*)
        echo "assemble-pages: refusing to delete a path that contains the repo" >&2
        exit 1
        ;;
esac

rm -rf -- "$out"
mkdir -p -- "$out"
touch -- "$out/.nojekyll"

{
    cat <<'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>temi OpenAPI demos</title>
    <style>
        body { background: #fff; color: #111; }
    </style>
</head>
<body>
    <h1>temi OpenAPI demos</h1>
    <p>
        Static, client-only demos. The Organization Access Token stays in the
        browser and is sent only to temi APIs.
        <a href="https://openapi-docs.robotemi.com">API reference</a>
    </p>
    <ul>
EOF
    for dir in "$demos"/*/; do
        [ -d "$dir" ] || continue
        [ -f "${dir}index.html" ] || continue
        [ -f "${dir}vercel.json" ] && continue
        name="$(basename "$dir")"
        case "$name" in
            '' | .* | *[!A-Za-z0-9._-]* )
                echo "assemble-pages: skipping unsafe demo name '$name'" >&2
                continue
                ;;
        esac
        if [ -f "${dir}package.json" ]; then
            echo "assemble-pages: building $name"
            (cd "$dir" && npm ci && npm run build)
            if [ ! -f "${dir}dist/index.html" ]; then
                echo "assemble-pages: $name build produced no dist/index.html" >&2
                exit 1
            fi
            mkdir -p -- "$out/$name"
            cp -R -- "${dir}dist/." "$out/$name/"
            touch -- "$out/$name/.nojekyll"
        else
            cp -R -- "$dir" "$out/$name"
        fi
        printf '        <li><a href="./%s/">%s</a></li>\n' "$name" "$name"
    done
    cat <<'EOF'
    </ul>
</body>
</html>
EOF
} > "$out/index.html"
