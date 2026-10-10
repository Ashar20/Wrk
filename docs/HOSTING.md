# Hosting the validator

The app reads its server address from `API_BASE` at build time. For a build anyone can install, point it at a public HTTPS validator.

## Fly.io (about 10 minutes)

```sh
brew install flyctl
fly auth login
cd server
fly launch --no-deploy --copy-config --name wrk-validator   # pick another name if taken; update app in fly.toml
fly volumes create wrk_data --size 1 --region sin
fly secrets set WRK_MINT=<mint> WRK_TREASURY_KEYPAIR=/data/treasury.json \
  WRK_APP_CERT_SHA256=<release cert digest> WRK_CLUSTER=devnet
fly deploy
```

Copy the existing devnet state (treasury key, account key, tasks and their open escrows) onto the volume, then restart:

```sh
fly ssh sftp shell   # then: put data/treasury.json /data/treasury.json  (repeat for account.key, accounts.json, bounties.json, devices.json)
fly machine restart
```

Without those files the server starts empty and opens fresh escrows with a new treasury, which then needs devnet SOL and the test token.

Check it: `curl https://wrk-validator.fly.dev/bounties`.

## Sign-in codes

With no `RESEND_API_KEY` and `WRK_MAIL_FROM`, email codes are printed to the server log (`fly logs`) instead of sent. A judge can't read your logs, so either set both for a real email, or tell judges to sign in with a wallet.

## Build the APK against it

```sh
./gradlew assembleRelease -Pwrk.apiBase=https://wrk-validator.fly.dev
```

`WRK_APP_CERT_SHA256` must include the digest of the keystore that signs this release, or phones won't count as running the genuine app.
