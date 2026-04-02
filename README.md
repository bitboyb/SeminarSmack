# SeminarSmack

SeminarSmack is a minimal, open-source realtime audience interaction tool for live teaching, talks, and workshops.

It is designed around one simple idea:

> The app is static. The sessions are data.

The site deploys once to GitHub Pages. Individual sessions live in JSON files under [`/docs/sessions`](./docs/sessions), and realtime sync happens through Supabase Realtime Broadcast with no backend server and no database tables.

## What it does

- Live polls
- Short text responses
- Simple quizzes with optional answer reveal
- Presenter controls for moving between activities, resetting, and locking submissions
- Read-only embed output for Marp slides

## Stack

- HTML
- CSS
- Vanilla JavaScript
- Supabase Realtime Broadcast
- GitHub Pages
- GitHub Actions for config injection

## Repository layout

```text
/docs
  index.html
  join.html
  present.html
  embed.html
  styles.css
  app.js
  supabase.js
  config.template.js
  sessions/
    sample-session.json
    example-session.json

/.github/workflows/pages.yml
README.md
LICENSE
```

## Setup

### 1. Fork the repo

Fork this repository to your own GitHub account.

### 2. Create a Supabase project

Create a Supabase project and collect:

- Project URL
- Publishable key (also called the anon key in many Supabase dashboards)

Do not use a `service_role` key.

### 3. Add GitHub repository variables or secrets

In your fork, add these repository variables or secrets:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`

The Pages workflow will use them to generate `docs/config.js` during deployment.

### 4. Enable GitHub Pages

In your fork:

1. Open `Settings -> Pages`
2. Set the source to `GitHub Actions`

### 5. Push to `main`

Push to `main` or trigger the Pages workflow manually. The site will deploy from the `docs/` directory artifact produced by the workflow.

## Forking and distribution

Forks include:

- All source code
- The GitHub Actions workflow

Forks do not include:

- Your GitHub Actions secrets
- Your GitHub variables
- Your Pages environment settings
- Your Supabase project

That means the workflow will run in a fork only after the fork owner adds their own `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` values and enables GitHub Pages.

## Local preview

For local browser testing, create a local config file from the template:

```bash
cp docs/config.template.js docs/config.js
```

Then fill in:

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "YOUR_PUBLISHABLE_KEY"
};
```

The generated `docs/config.js` file is ignored by git.

## Session authoring

Put session files in [`/docs/sessions`](./docs/sessions) and load them with `?session=filename`.

Example:

```json
{
  "title": "Session Title",
  "description": "Optional",
  "activities": [
    {
      "id": "poll-1",
      "type": "poll",
      "question": "Question text",
      "options": ["A", "B", "C"]
    },
    {
      "id": "text-1",
      "type": "text",
      "question": "Short response",
      "maxLength": 180
    },
    {
      "id": "quiz-1",
      "type": "quiz",
      "question": "Which is correct?",
      "options": ["A", "B", "C"],
      "correctIndex": 1
    }
  ]
}
```

Rules:

- `title` is required
- `activities` is required
- Every activity must include `id`, `type`, and `question`
- `poll` and `quiz` activities require at least two `options`

## Usage

### Presenter URL

```text
present.html?room=abc123&session=sample-session&host=secret-token
```

### Participant URL

```text
join.html?room=abc123&session=sample-session
```

### Embed URL

```text
embed.html?room=abc123&session=sample-session
```

If you want the embed page to verify presenter-signed control events, use:

```text
embed.html?room=abc123&session=sample-session&host=secret-token
```

Typical flow:

1. Create or edit a session JSON file.
2. Open the presenter URL.
3. Share the participant URL.
4. Drop the embed URL into Marp iframes or a projector view.

## Marp embed example

```html
<iframe
  src="https://your-site.example/embed.html?room=abc123&session=sample-session"
  width="100%"
  height="500">
</iframe>
```

## Security notes

- The frontend must use the Supabase publishable key only.
- The publishable key is visible in the browser and that is expected.
- Never use a `service_role` key in this project.
- The host token is a lightweight browser-side control guard, not a full authentication system.

## Realtime model

- Participants submit answers over Supabase Broadcast.
- The presenter page is the source of truth for results.
- Presenter state is rebroadcast as signed snapshots so audience and embed pages can stay in sync without a backend or database persistence.
- Anti-spam rules are enforced in the presenter page using device IDs and cooldowns.

## License

MIT
