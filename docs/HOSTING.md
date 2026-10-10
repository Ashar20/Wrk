# Hosting the validator

The app reads its server address from `API_BASE` at build time. For a build anyone can install, point it at a public HTTPS validator.

## Render (free, no card)

Free web services have no disk and sleep after about 15 minutes idle (the first request then takes ~30 s). The validator copes: demo tasks reattach to their on-chain vaults at startup. Tasks posted by buyers and email sign-ins are kept only until the next restart.

1. Push the repo to GitHub.
2. On render.com: New, Blueprint, pick the repo. It reads `render.yaml`.
3. Fill the four secrets from `server/hosted.env` (made by `cd server && npx tsx scripts/hosted-env.ts`; never commit it): `WRK_MINT`, `WRK_TREASURY_JSON`, `WRK_ACCOUNT_KEY`, `WRK_APP_CERT_SHA256`.
4. When it's live, `curl https://<name>.onrender.com/bounties` should list five tasks.
5. Build the APK: `./gradlew assembleRelease -Pwrk.apiBase=https://<name>.onrender.com`.

The Fly steps below work too if you'd rather have a persistent disk.

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
