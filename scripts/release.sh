#!/bin/sh
# Prepares a release of herdr-app-remote. It builds the single bridge bundle, proves the build is
# reproducible, installs it into a THROWAWAY app home to read the sha256 that `app-install` records in
# install.json, checks the two hashes agree, writes release/herdr-app-remote-<version>.manifest.txt and
# prints the remaining steps.
#
#   scripts/release.sh <version>        e.g. scripts/release.sh 0.1.0
#
# It does NOT tag, push, create a GitHub release or publish a package, and it never touches your real
# herdr-app app home: the install goes into a temp directory made here (fixtures/app-home copy) and
# herdr-app is never run. Those last steps are printed for a person to run.
set -eu

version=${1:-}
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "usage: scripts/release.sh <version>   (for example 0.1.0)" >&2; exit 2 ;;
esac
root=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$root"

for t in node pnpm git sha256sum; do
  command -v "$t" >/dev/null 2>&1 || { echo "ABORT: missing tool: $t" >&2; exit 2; }
done
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "ABORT: node >= 22 is required" >&2; exit 2; }
[ -z "$(git status --porcelain)" ] || { echo "ABORT: the working tree is not clean; commit or remove changes first" >&2; exit 1; }
grep -q "^## \[\{0,1\}$version" CHANGELOG.md || { echo "ABORT: CHANGELOG.md has no section for $version" >&2; exit 1; }
commit=$(git rev-parse HEAD)

# Two workspace jobs at a time and low priority, like every other build here.
export npm_config_workspace_concurrency=2

echo "== install, verify and build ($commit)"
nice -n 10 pnpm install --frozen-lockfile
nice -n 10 pnpm verify

bundle=packages/bridge/dist/bridge.mjs
[ -f "$bundle" ] || { echo "ABORT: $bundle was not built" >&2; exit 1; }
first=$(sha256sum "$bundle" | cut -d' ' -f1)

echo "== rebuild the bundle: the bytes must not change"
nice -n 10 pnpm --filter @herdr-remote/bridge build
second=$(sha256sum "$bundle" | cut -d' ' -f1)
[ "$first" = "$second" ] || { echo "ABORT: the bundle is not reproducible ($first vs $second)" >&2; exit 1; }

echo "== install into a throwaway app home and read the recorded hash"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/herdr-remote-release.XXXXXX")
home="$tmp/h"
mkdir -p "$home/layouts"
cp fixtures/app-home/main.json "$home/layouts/main.json"
cp fixtures/app-home/settings.json "$home/settings.json"
scripts/app-install install --app-home "$home" --node "$(command -v node)" >/dev/null
recorded=$(node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1] + "/data/herdr-app-remote/install.json", "utf8"));
  process.stdout.write(r.files["data/herdr-app-remote/bin/bridge.mjs"].sha256);
' "$home")
rm -rf -- "$tmp"
[ "$recorded" = "$first" ] || { echo "ABORT: install.json records $recorded but the bundle is $first" >&2; exit 1; }

echo "== write the manifest"
mkdir -p release
manifest="release/herdr-app-remote-$version.manifest.txt"
{
  echo "herdr-app-remote $version"
  echo "commit $commit"
  echo "node-min 22"
  echo "$first  data/herdr-app-remote/bin/bridge.mjs"
} > "$manifest"
echo "bundle sha256 $first (matches install.json)"
echo "wrote $manifest"

cat <<EOT

Done. Nothing was tagged, pushed or published. To release, a person runs, in order:

  1. Review release/herdr-app-remote-$version.manifest.txt and CHANGELOG.md.
  2. Check the manual list in RECIPE.md ("Open checks") and that CI is green on $commit:
       gh run list --commit $commit
  3. Tag and push (only when you mean it):
       git tag -a v$version -m "herdr-app-remote $version" $commit
       git push origin v$version
  4. Create the release with the manifest attached:
       gh release create v$version release/herdr-app-remote-$version.manifest.txt --title "herdr-app-remote $version" --notes "See CHANGELOG.md"
  5. Users install from a checkout of the tag: pnpm install && pnpm build && scripts/app-install install --app-home ~/.config/herdr-app
     Their install.json will record the same bundle hash as the manifest.
EOT
