# Question bot for Telegram

One bot (@Smlebrainbot) posts questions to several Telegram channels every day. It runs on GitHub Actions, so there's no server to keep alive.

| Channel | Questions from | Each day |
|---|---|---|
| SMLE (`TELEGRAM_CHANNEL` secret) | SMLE Brain, current month | 5 questions together, at one random time |
| @fm_part1 | Residency Brain `fm_p1` | 1 question at a random time |
| @im_part1 | Residency Brain `im_p1` | 1 question at a random time |
| @peds_part1 | Residency Brain `peds_p1` | 1 question at a random time |
| @GS_part1 | Residency Brain `gs_p1` | 1 question at a random time |
| @ER_part1 | Residency Brain `er_p1` | 1 question at a random time |
| @oby_part1 | Residency Brain `obgyn_p1` | 1 question at a random time |
| @derm_part1 | Residency Brain `derm_p1` | 1 question at a random time |

All times are random between 10:00 AM and 5:00 PM Riyadh time, different every day. A channel with several posts a day has them spread across the day, at least 20 minutes apart. No question is ever posted twice to the same channel.

## What a post looks like

**SMLE:** plain text, just the case and options A–D. No month, no answer. If the current month isn't uploaded yet or is used up, the bot uses the previous month.

**Part 1 channels:** a Telegram quiz. Members tap an answer, and Telegram shows right or wrong.

- If the header and the case fit in a quiz (300 characters), the whole thing is one quiz: "Part 1 year 2024 question ⭐", the case, then the options.
- If the case is longer, the header and case go out as a message, with the quiz of options right underneath.
- After the quiz comes a "💡 Explanation" message with the answer and full explanation, hidden behind a spoiler that members tap to reveal.

A question asked in several years is labelled with all of them, for example "Part 1 year 2023 & 2024 question ⭐". Questions with images, a disputed answer or no recalled answer are skipped, because a quiz needs one sure correct answer.

## Secrets

Repo → Settings → Secrets and variables → Actions:

| Secret | What it is |
|---|---|
| `TELEGRAM_BOT_TOKEN` | The bot's token from @BotFather |
| `TELEGRAM_CHANNEL` | The SMLE channel's @username |
| `FIREBASE_SERVICE_ACCOUNT` | Key file contents for the **smlebrain** Firebase project |
| `RESIDENCY_FIREBASE_SERVICE_ACCOUNT` | Key file contents for the **residency-brain** Firebase project |

The bot needs to be an admin with "Post messages" in every channel.

## Adding a channel

Add an entry to `channels.json`, and add the same name to the `channel` options in `.github/workflows/post.yml`:

```json
"derm_part1": {
  "chat": "@derm_part1",
  "source": "residency",
  "bank": "derm_p1",
  "postsPerDay": 5,
  "questionsPerPost": 1
}
```

`bank` is the bank id in Residency Brain (`derm_p1`, `gs_p1`, `er_p1`, …). `postsPerDay` × `questionsPerPost` is the number of questions a day. The 10 AM–5 PM window is `window` at the top of the file.

## Posting by hand

Actions tab → "Post questions" → Run workflow. Pick a channel and how many posts to send. These go out right away, use up questions like any other post, and don't replace the day's scheduled posts.

## How it works

- GitHub's timed schedule skips many runs on busy days, so it's only used to start the day. A run starts early (the schedule tries every hour from 3:05 AM to 4:05 PM, and one success is enough), then stays awake through 10 AM–5 PM and sends each post at its exact minute. A run can last 6 hours at most, so before that it starts its own replacement through GitHub's API, and those runs aren't skipped. If GitHub starts the day late anyway, the posts already missed are spread over the rest of the day, so each channel still gets its full count.
- While the day's run is going, a run started by hand waits in line until it finishes, around 5 PM.
- `state/<channel>.json` records each channel's posted question ids and which of today's posts are done. The workflow commits it after every run.
- SMLE questions come from Firestore `bankQuestions`, queried by `Month`. Residency Brain banks are read from the `banks` catalog, then downloaded from Storage.
- If a post fails, the others still go out, and the failed one is retried twice, 5 minutes apart. Errors appear on the run's page on the Actions tab.
- The bot only reads from Firebase. It never writes to it.

## Preview without posting

```
npm install
DRY_RUN=true MANUAL_CHANNEL=fm_part1 RESIDENCY_FIREBASE_SERVICE_ACCOUNT="$(cat residency-key.json)" node run.js
```

This prints the Telegram calls instead of making them, and doesn't change `state/`.
