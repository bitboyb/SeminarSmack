<div align="center">
  <img src="docs/logo.png" alt="SeminarSmack Logo" width="120" style="border-radius: 20%; margin-bottom: 20px;" />
  <h1>SeminarSmack</h1>
  <p><strong>A free, open-source classroom interaction tool.</strong></p>
  
  <a href="https://bitboyb.github.io/SeminarSmack/">
    <img src="https://img.shields.io/badge/Live_Demo-Try_it_now!-ee9ad5?style=for-the-badge" alt="Live Demo" />
  </a>
  <img src="https://img.shields.io/badge/Architecture-Zero_Backend-5fd9d7?style=for-the-badge" alt="Zero Backend" />
  <img src="https://img.shields.io/badge/License-MIT-gray?style=for-the-badge" alt="License MIT" />

  <p>Create live polls, quizzes, and short text questions — students join with a QR code from any device.<br/>No login required. No install. Free to use.</p>

  <br />
  <video src="seminar-smack-preview.webm" autoplay loop muted playsinline width="80%" style="border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.2);"></video>
</div>

---

## Quick start

1. **Open the site** — visit the [live SeminarSmack app](https://bitboyb.github.io/SeminarSmack/).
2. **Create a session** — click "Create a session", add your questions.
3. **Start hosting** — click "Start session". A room code and QR code are generated automatically.
4. **Share with students** — show the QR code on screen or share the join link.
5. **Present live** — step through activities, see answers update in realtime, reveal correct answers when ready.

## What it does

- **Live polls** — multiple-choice questions with realtime results
- **Quizzes** — mark a correct answer and reveal it when ready
- **Short text responses** — collect open-ended answers from students
- **QR code join** — students scan and answer from their phones
- **Session export/import** — save your session as JSON and reuse it later

## How it works

- Sessions created in the browser are stored in your browser's `localStorage`.
- The presenter page is the **source of truth** — it broadcasts state to all connected students via Supabase Realtime Broadcast.
- The **QR code** on the presenter page is generated locally in the browser using a vendored copy of [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator). No QR API, CDN, or backend service is used.
- There is **no database** and **no backend server**. Everything runs in the browser.
- Sessions are temporary and local to the browser that created them, unless you export them as JSON.

## Ethos

SeminarSmack is built on the belief that simple educational tools should be accessible to everyone.

Many classroom interaction tools are useful because they make teaching more engaging: they help students respond, vote, reflect, and take part. But tools like this are often placed behind subscriptions, usage limits, account systems, or institutional licences. In practice, that can leave individual educators paying out of pocket just to make their sessions more interactive.

SeminarSmack takes a different approach.

The app is intentionally small, static, and low-cost to run. It does not need a complex backend, paid hosting, a database, or expensive infrastructure. Because the technical costs are minimal, the tool should remain free to use, easy to self-host, and open to adaptation.

This project is not against paid educational software. Complex platforms need funding, support, maintenance, and long-term sustainability. But when a tool can be delivered simply, cheaply, and openly, it should not create unnecessary barriers for teachers or learners.

SeminarSmack aims to be:

* **Free for educators and students** — no paywall for basic classroom participation.
* **Open source** — so the tool can be inspected, adapted, improved, and self-hosted.
* **Low infrastructure** — designed to avoid unnecessary hosting costs.
* **Privacy-conscious** — no login, no database by default, and no student accounts required.
* **Practical** — focused on the classroom features teachers actually need during live sessions.
* **Reusable** — sessions can be exported, imported, shared, and adapted.

The goal is simple: make it easier for educators to create active, engaging lessons without adding another cost, account, or platform dependency.

## Self-hosting / development

### 1. Fork the repo

Fork this repository to your own GitHub account.

### 2. Create a Supabase project

Create a free Supabase project and collect:

- Project URL
- Publishable key (anon key)

Do **not** use a `service_role` key.

### 3. Add GitHub repository variables

In your fork, add these repository variables (or secrets):

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`

The GitHub Actions workflow generates `docs/config.js` during deployment.

### 4. Enable GitHub Pages

In your fork: Settings → Pages → Source → GitHub Actions.

### 5. Push to main

Push to `main` or trigger the workflow manually. The site deploys from `docs/`.

### Local preview

```bash
cp docs/config.template.js docs/config.js
```

Edit `docs/config.js` with your Supabase credentials, then serve `docs/` locally.

## Repository layout

```text
/docs
  index.html          — Landing page
  create.html         — Session builder
  join.html           — Student join page
  present.html        — Presenter controls
  styles.css          — Design system
  app.js              — Shared utilities + router
  session-builder.js  — Create page logic
  presenter.js        — Presenter logic
  participant.js      — Student join logic
  landing.js          — Landing page module
  supabase.js         — Supabase client
  config.template.js  — Config placeholder
  vendor/
    qrcode.min.js       — QR code generator (vendored, no CDN)
  sessions/
    sample-session.json
    example-session.json

/.github/workflows/pages.yml
README.md
LICENSE
```

## URL reference

### New flow (recommended)

```
create.html                                    — Build a session
present.html?room=SPARK-4821&host=<token>      — Host the session
join.html?room=SPARK-4821                      — Student join
```

### Legacy flow (still supported)

```
present.html?room=abc&session=sample-session&host=token
join.html?room=abc&session=sample-session
```

## Security notes

- Uses the Supabase **publishable key** only — visible in the browser, which is expected.
- Never use a `service_role` key.
- The host token is a lightweight browser-side control guard, **not** a full authentication system.
- This is a lightweight teaching tool, not a secure exam platform.

## License

MIT
