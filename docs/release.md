# リリース手順

masuda-sandboxのリリースは、タグ`vX.Y.Z`をpushすると`.github/workflows/release.yml`が行う。

**masudaとの順序は、masudaリポジトリのリリース手順書（`docs/design/release.md`）に従う。** 概略は「sandbox→masudaの順にタグを打ち、masudaのリリースノートに対応するsandboxのバージョンを書く」。ここに書くのはmasuda-sandbox側の手順だけ。

## タグを打つ前に（手元で）

CIは単体テストしか回さない（契約テストは実VMを起動するのでKVMが要り、GitHubのホストランナーには無い）。タグを打つコミットで、手元で次を確認する。

```sh
git switch main && git pull
pnpm install --frozen-lockfile
pnpm build
pnpm test
node dist/cli.js serve --socket "$XDG_RUNTIME_DIR/masuda-sandbox.sock" &
MASUDA_SANDBOX_SOCKET="$XDG_RUNTIME_DIR/masuda-sandbox.sock" pnpm test:contract
kill %1
pgrep -af qemu-system   # 孤児が無いこと
```

tarballをインストールして動くことも見ておく（リリースと同じ手順）。

```sh
cp package.json /tmp/package.json.bak
MASUDA_SANDBOX_VERSION=vX.Y.Z pnpm build
npm pkg set version=X.Y.Z && npm pack
cp /tmp/package.json.bak package.json   # git checkoutで戻さない（未コミットの変更ごと消える）
npm install -g ./masuda-sandbox-X.Y.Z.tgz
masuda-sandbox --version                # X.Y.Z
masuda-sandbox serve --socket /tmp/x.sock   # listeningが出たらCtrl-C
npm uninstall -g masuda-sandbox
pnpm build                              # dist/をdevに戻す
```

## タグを打つ

```sh
git tag -a vX.Y.Z -m "masuda-sandbox vX.Y.Z"
git push origin vX.Y.Z
```

- バージョンはタグにしか書かない。`package.json`の`version`は`0.0.0`のままで、ワークフローがタグから書き込んでから`npm pack`する
- ワークフローは`MASUDA_SANDBOX_VERSION`にタグ名を渡す。`scripts/gen-version.mjs`が先頭の`v`を落として`src/version.ts`に埋め、`masuda-sandbox --version`と`GetServerInfo.version`がそれを返す。同時に`sandbox.proto`のSHA-256を`GetServerInfo.contract_sha256`に埋める
- Releaseには`masuda-sandbox-X.Y.Z.tgz`と`SHA256SUMS`が添付される

## リリース後

- Releaseの添付物で[`README.md`](../README.md)のインストール手順を1回なぞる
- `masuda-sandbox --version`と、masudaの`masuda version`（`GetServerInfo`を表示する）で、バージョンとcontract_sha256がmasuda側の期待と合うことを見る
