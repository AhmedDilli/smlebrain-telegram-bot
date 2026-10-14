# SMLE Brain Telegram bot

Posts 5 SMLE questions from one month to a Telegram channel once a day, at a random time between 10 AM and 5 PM, as plain text: just the case, then options A–D. No month label, no answer. It runs on GitHub Actions, so there's no server to keep alive.

Each day it posts 5 questions from the current month (October 2026 in October, November 2026 from 1 November, by Riyadh time) that haven't been posted before. If the current month isn't uploaded yet, or every question in it has already been posted, it uses the newest month that still has questions left. Image questions are skipped. The IDs it has posted are saved in `posted.json`, so no question goes out twice.

## Setup (about 15 minutes)

1. **Create the bot.** In Telegram, open @BotFather, send `/newbot` and follow the prompts. Copy the token it gives you.
2. **Let it post.** Open your channel → Administrators → Add admin → search for the bot. Give it "Post messages".
3. **Get a Firebase key.** Firebase Console → Project settings → Service accounts → Generate new private key. A `.json` file downloads. Never commit this file or share it.
4. **The code is in the repo** `AhmedDilli/smlebrain-telegram-bot`, with the workflow already at `.github/workflows/post.yml`.
5. **Add three secrets.** In the repo, go to Settings → Secrets and variables → Actions → New repository secret:
   - `TELEGRAM_BOT_TOKEN`: the token from step 1
   - `TELEGRAM_CHANNEL`: `@yourchannelname`, or the numeric `-100…` id for a private channel
   - `FIREBASE_SERVICE_ACCOUNT`: the whole contents of the `.json` file from step 3
6. **Test it.** Actions tab → "Post SMLE questions" → Run workflow. Five messages should appear in the channel.

After that it posts on its own once a day, at a random minute between 10:00 AM and 5:00 PM Riyadh time. The bot wakes every 30 minutes; the run just before the picked time waits until that minute and posts, and the others stop after a few seconds (their log says "Skipping"). `last-post.txt` records the day's post so it never posts twice. If GitHub starts a run late, the post goes out late by the same amount. Runs started by hand always post and don't count as the day's post.

## Changing it

The settings are in `.github/workflows/post.yml`. The 10 AM to 5 PM range is `FIRST` and `LAST` in `slot.js`; if you widen it, extend the `cron` lines so a run comes up every 30 minutes across the new range.

| Setting | Default | What it does |
|---|---|---|
| `QUESTIONS_PER_POST` | `5` | How many questions per day |
| `MONTH` | empty | Empty means the current month. Set e.g. `Sep-26` to post from a specific month instead. |

## Preview without posting

```
npm install
FIREBASE_SERVICE_ACCOUNT="$(cat path/to/key.json)" npm run preview
```

This prints the messages it would send. It doesn't post anything and doesn't change `posted.json`.

## Notes

- GitHub Actions is free for public repos; a private repo gets 2,000 minutes a month on the Free plan. The 14 short wake-ups plus the wait before posting come to about 30 minutes a day, roughly 900 a month.
- It finds each month's questions by querying `bankQuestions` on the `Month` field, so a new month is picked up as soon as it's uploaded.
- Each run reads one month's questions, a few hundred Firestore reads at most, well inside the free 50,000 a day. The bot only reads; it never writes to Firestore.
- When it falls back to another month, the run log on the Actions tab says why (for example "Oct-26 is not in the bank yet; using Sep-26").
- At 5 a day, a month needs about 155 text questions to last the whole month. A smaller month runs out early, and the bot moves on to the previous month.
