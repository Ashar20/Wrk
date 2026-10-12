const REPO = "https://github.com/Ashar20/Wrk";
const APK = "https://github.com/Ashar20/Wrk/releases/download/v0.1.0/Wrk.apk";
const RELEASE = "https://github.com/Ashar20/Wrk/releases/tag/v0.1.0";
const API = "https://wrk-validator.onrender.com";
const PROGRAM = "8swdg4fKWMoqhcNLW4CS9hLdararEUKbjA8yB5Z3n9Qd";
const DEMO = process.env.NEXT_PUBLIC_DEMO_URL || "";

type Task = { bounty_id: string; title: string; per_episode_usdc: number; min_episodes: number; review_policy?: string; liveness?: string };

// The validator sleeps when idle, so ask politely and fall back to the demo tasks it normally serves.
const FALLBACK: Task[] = [
  { bounty_id: "bounty_007", title: "Cup pick-and-place, reviewed", per_episode_usdc: 60, min_episodes: 100, review_policy: "always" },
  { bounty_id: "bounty_004", title: "Cup pick-and-place, indoor", per_episode_usdc: 40, min_episodes: 100 },
  { bounty_id: "bounty_005", title: "Open a door and walk through", per_episode_usdc: 55, min_episodes: 100 },
  { bounty_id: "bounty_006", title: "Fold a towel", per_episode_usdc: 30, min_episodes: 100 },
  { bounty_id: "bounty_008", title: "Cup pick-and-place, live check", per_episode_usdc: 75, min_episodes: 100, liveness: "require" },
];

async function loadTasks(): Promise<{ tasks: Task[]; live: boolean }> {
  try {
    const res = await fetch(`${API}/bounties`, { next: { revalidate: 600 }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(String(res.status));
    const j = (await res.json()) as { bounties: Task[] };
    if (j.bounties?.length) return { tasks: j.bounties.slice(0, 6), live: true };
  } catch {
    /* sleeping or unreachable: show the usual demo tasks */
  }
  return { tasks: FALLBACK, live: false };
}

const skr = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export default async function Home() {
  const { tasks, live } = await loadTasks();
  return (
    <>
      <header className="nav">
        <div className="wrap nav-in">
          <a className="brand" href="#top">
            <img src="/icon.svg" alt="" />
            Wrk
          </a>
          <nav className="links">
            <a className="hide-sm" href="#how">How it works</a>
            <a className="hide-sm" href="#trust">Trust</a>
            <a className="hide-sm" href="#money">Money</a>
            <a className="hide-sm" href="#faq">FAQ</a>
            <a className="btn ink sm" href={APK}>Get the APK</a>
          </nav>
        </div>
      </header>

      <main id="top">
        {/* hero */}
        <section className="hero">
          <div className="wrap hero-grid">
            <div className="reveal">
              <span className="pill"><span className="dot" style={{ background: "#1f6b55" }} /> Live on Solana devnet</span>
              <h1>Pocket money for <em>first-person</em> data.</h1>
              <p className="lead">
                Wrk pays people in SKR for short video and motion clips recorded on their Android phone, for robotics teams
                that need real data. The pay sits in escrow and moves only when the take is proven real.
              </p>
              <div className="cta">
                <a className="btn ink" href={APK}>Download for Android</a>
                {DEMO ? <a className="btn paper" href={DEMO}>Watch the demo</a> : null}
                <a className="btn paper" href={REPO}>View the code</a>
              </div>
              <p className="fine">Android 8+. Devnet only: SKR is a free test token there, because the real one lives on mainnet.</p>
            </div>

            <div className="phone-wrap reveal" style={{ animationDelay: "0.12s" }}>
              <div className="phone" aria-hidden="true">
                <div className="screen">
                  <div className="cam">
                    <div className="rec"><b /> REC 0:08</div>
                    <div className="hand">
                      {[[10, 80], [24, 60], [36, 38], [50, 20], [62, 38], [76, 58], [88, 80], [50, 62], [50, 42], [30, 78], [70, 78]].map(([x, y], i) => (
                        <i key={i} style={{ left: `${x}%`, top: `${y}%`, animationDelay: `${i * 0.18}s` }} />
                      ))}
                    </div>
                    <div className="prompt">Turn your head left, then right</div>
                  </div>
                  <div className="meter"><div><b>Hands in view</b><b>82%</b></div><span><i style={{ width: "82%" }} /></span></div>
                  <div className="meter"><div><b>Motion matches video</b><b>71%</b></div><span><i style={{ width: "71%" }} /></span></div>
                  <div className="earn">
                    <small>You earned</small>
                    <strong>40<sub>SKR</sub></strong>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* roles */}
        <section id="how">
          <div className="wrap">
            <span className="tag">One app, three roles</span>
            <h2>Record it, review it, or buy it.</h2>
            <p className="sub">Sign in with an email or a Solana wallet. Pick a role, and switch whenever you like.</p>
            <div className="grid3">
              <div className="card mint">
                <h3>Contributor</h3>
                <p>Pick a task, record a short clip with your phone, and get paid in SKR the moment it is verified. No CV, no bank account.</p>
                <ul><li>Hand skeleton and framing coach while you record</li><li>A trust score that raises your daily allowance</li><li>Receipts on Solana for every payment</li></ul>
              </div>
              <div className="card lilac">
                <h3>Verifier</h3>
                <p>Close calls go to a person. Watch the take, see the scores and motion traces, then approve or reject. You earn a fee for every decision.</p>
                <ul><li>A queue of takes waiting for a person</li><li>Scores and traces beside the video</li><li>3 SKR per decision, paid on-chain</li></ul>
              </div>
              <div className="card butter">
                <h3>Buyer</h3>
                <p>Post a task and lock its pay in an escrow. Watch takes arrive, then download the accepted ones with a manifest you can check against Solana.</p>
                <ul><li>Video, motion data and a sealed manifest</li><li>Only accepted takes, never refused ones</li><li>Pay only for what passes</li></ul>
              </div>
            </div>
          </div>
        </section>

        {/* trust */}
        <section id="trust">
          <div className="wrap">
            <span className="tag">Why the data can be trusted</span>
            <h2>Four ways a take has to prove it is real.</h2>
            <p className="sub">Faking first-person data is easy online. A phone in someone&apos;s hand is much harder to fake, so Wrk checks the phone as well as the video.</p>
            <div className="steps">
              <div className="step"><div className="n">1</div><div><h3>The video and the motion must agree</h3><p>Optical flow from the video is compared with the phone&apos;s gyroscope. A screen replay of someone else&apos;s clip does not move the way your phone did. <em>A replay scores about 4% against about 70% for a genuine take.</em></p></div></div>
              <div className="step"><div className="n">2</div><div><h3>The phone&apos;s key comes from secure hardware</h3><p>Android Key Attestation proves the signing key lives in the phone&apos;s secure hardware and the app is the genuine Wrk build. One phone, one account.</p></div></div>
              <div className="step"><div className="n">3</div><div><h3>A live head-movement check</h3><p>The app asks for random movements at random moments (&ldquo;turn left, then right&rdquo;). Nobody can pre-record a sequence they have not seen yet. <em>None of 6,000 random challenges passed against real recordings.</em></p></div></div>
              <div className="step"><div className="n">4</div><div><h3>Sybil and duplicate defences</h3><p>Duplicate clips are caught, new accounts clustered in one small area are pooled, and a trust score sets how many takes you can earn from each day.</p></div></div>
            </div>
          </div>
        </section>

        {/* money */}
        <section id="money">
          <div className="wrap">
            <span className="tag">How the money is held</span>
            <h2>Pay is locked first and released only on a verified take.</h2>
            <p className="sub">
              Every task has its own vault in an Anchor program on Solana. Only the task&apos;s validator can accept a take, and a
              take can be paid exactly once.
            </p>
            <div className="flow">
              <div className="fl"><b>1. Lock</b><p>The buyer posts a task. Its pay is locked in a vault.</p></div>
              <div className="fl"><b>2. Reserve</b><p>A take is recorded on-chain with its hash. One payment is set aside.</p></div>
              <div className="fl"><b>3. Verify</b><p>Automatic checks run. Close calls go to a person.</p></div>
              <div className="fl mint"><b>4. Pay</b><p>Accepted: the contributor gets exactly the task&apos;s rate, in SKR.</p></div>
              <div className="fl ink"><b>or Refuse</b><p>Rejected: the reserve is released. Nothing is paid.</p></div>
            </div>
            <div className="split" aria-label="Budget split">
              <i style={{ width: "60%", background: "#1d5b49" }} />
              <i style={{ width: "30%", background: "#5b3d8c" }} />
              <i style={{ width: "5%", background: "#7a5013" }} />
              <i style={{ width: "5%", background: "#0d0d0f" }} />
            </div>
            <div className="legend">
              <span style={{ ["--c" as string]: "#1d5b49" }}>60% takes</span>
              <span style={{ ["--c" as string]: "#5b3d8c" }}>30% contributor bonus pool (reserved)</span>
              <span style={{ ["--c" as string]: "#7a5013" }}>5% reviewers</span>
              <span style={{ ["--c" as string]: "#0d0d0f" }}>5% Wrk</span>
            </div>
          </div>
        </section>

        {/* live tasks */}
        <section id="tasks">
          <div className="wrap">
            <span className="tag">{live ? "Live from the validator" : "The usual demo tasks"}</span>
            <h2>Tasks open right now.</h2>
            <p className="sub">Each one is funded in an on-chain vault before anyone can record it.</p>
            <div className="tasks">
              {tasks.map((t) => (
                <div className="task" key={t.bounty_id}>
                  <div>
                    <b>{t.title}</b>
                    <small>{t.min_episodes} takes</small>
                    <div>
                      {t.review_policy && t.review_policy !== "none" ? <span className="badge">A person reviews it</span> : null}
                      {t.liveness === "require" ? <span className="badge m">Live check</span> : null}
                    </div>
                  </div>
                  <div className="price">{skr(t.per_episode_usdc)}<sub>SKR</sub></div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* solana mobile */}
        <section>
          <div className="wrap">
            <span className="tag">Built for Solana Mobile</span>
            <h2>Native Android, Mobile Wallet Adapter, SKR.</h2>
            <div className="grid3">
              <div className="card paper"><h3>Mobile Wallet Adapter</h3><p>Sign in with any wallet app on the phone. After one sign-in message, takes are recorded on-chain for you: nothing to approve per take, and no SOL needed.</p></div>
              <div className="card paper"><h3>SKR payouts</h3><p>Contributors, verifiers and buyers all deal in SKR. The escrow works with any SPL token and reads its decimals, so pointing at mainnet SKR is one setting.</p></div>
              <div className="card ink"><h3>Real on-chain receipts</h3><p>Every take and payment links to a public explorer receipt. The escrow program is <a className="mono" style={{ textDecoration: "underline" }} href={`https://explorer.solana.com/address/${PROGRAM}?cluster=devnet`}>{PROGRAM.slice(0, 8)}…</a> on devnet.</p></div>
            </div>
          </div>
        </section>

        {/* honest */}
        <section>
          <div className="wrap">
            <span className="tag">Straight talk</span>
            <h2>What is real, and what is not yet.</h2>
            <div className="two">
              <div className="card mint">
                <h3>Working today</h3>
                <ul>
                  <li>Record, score, escrow, verifier and payout, end to end on devnet</li>
                  <li>Wallet and email sign-in, three roles</li>
                  <li>Hardware attestation and the live check</li>
                  <li>Buyer download of accepted takes</li>
                  <li>A hosted validator and a public APK</li>
                </ul>
              </div>
              <div className="card butter">
                <h3>Not yet</h3>
                <ul>
                  <li>Devnet only, with a test token standing in for SKR</li>
                  <li>No face or text blurring: the app tells you before you record</li>
                  <li>No paying buyers yet. A pilot is the next step</li>
                  <li>One validator, run by us</li>
                  <li>The world-model chart is trained on only 5 takes</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* faq */}
        <section id="faq">
          <div className="wrap">
            <span className="tag">Questions</span>
            <h2>Good questions.</h2>
            <details><summary>Who can see my recording?</summary><p>Wrk&apos;s automatic checks, a reviewer if the task asks for one, and the buyer who posted the task once your take is accepted. Buyers also see your payment address and the approximate area you recorded in (about 1 km). Refused takes are never shared. Keep faces, screens and documents out of frame.</p></details>
            <details><summary>Do I need a Seeker?</summary><p>No. Wrk runs on any Android phone. A Seeker is not required, though the wallet and SKR flow suits it well.</p></details>
            <details><summary>Is the money real?</summary><p>Not yet. Everything runs on Solana devnet with a free test token. Real SKR exists only on mainnet, and moving there is a configuration change plus deploying the escrow program on mainnet.</p></details>
            <details><summary>How do I try it?</summary><p>Install the APK, choose a role and sign in with email or a wallet. The first request can take up to a minute while the free-tier server wakes up. Email codes appear only in the server log, so a wallet is the easy route.</p></details>
            <details><summary>What stops someone gaming it?</summary><p>The video must match the phone&apos;s own motion, the signing key must come from secure hardware, random head-movement prompts defeat replays, duplicates are caught, and new accounts clustered in one place are pooled. It raises the cost of faking a lot; it is not a guarantee.</p></details>
          </div>
        </section>
      </main>

      <footer>
        <div className="wrap">
          <div className="foot">
            <h2>Ready to try it?</h2>
            <div className="cta" style={{ marginTop: 0 }}>
              <a className="btn paper" href={APK}>Download the APK</a>
              <a className="btn paper" href={REPO}>Read the code</a>
            </div>
            <div className="row links">
              <a href={RELEASE}>Release notes</a>
              <a href={`${API}/bounties`}>Live validator</a>
              <a href={`https://explorer.solana.com/address/${PROGRAM}?cluster=devnet`}>Escrow program</a>
            </div>
            <small>Wrk. Built for the Crypto World&apos;s Fair hackathon. Devnet demo, not financial advice.</small>
          </div>
        </div>
      </footer>
    </>
  );
}
