# 🎅 Family Secret Santa

A simple Secret Santa site for the family. No accounts and no email verification: people tap the link, say yes, and pick a 4-number PIN.

## What it does

- **One shareable link.** Anyone can RSVP yes or no and forward the link on WhatsApp.
- **Automatic draw** on the date you set (checked every 15 minutes, Trinidad time). You can also press "Draw names now".
- **Households**: people in the same household never draw each other. Preset families live in `src/worker.js` (`DEFAULT_SETTINGS.households`) and can be edited on the organizer page.
- **Spin the wheel**: each person spins and the wheel lands on the person they were drawn. The result is decided first, so the draw can never get stuck.
- **Wish lists** in plain words (no Amazon needed), plus sizes, favourite things and a "please no…" list.
- **Anonymous messages**: ask your person a question without them knowing it's you, and answer your own Secret Santa.
- **Family Chat** wall and organizer announcements.
- **Notifications**: push notifications (Android; iPhone after "Add to Home Screen") and optional email.
- **Organizer page** at `/#organizer`: dates, budget, households, who's in, who has spun, PIN resets, removing people, late joiners. **It never shows who drew whom.**
- **Fix-ups without peeking**: if someone leaves or joins after the draw, the loop is patched automatically, and only the affected person is told their match changed.
- **Sealed list** (`GET /api/ops/matches` with `Authorization: Bearer <OPS_KEY>`): for a trusted helper (e.g. a Claude session) to check the draw if something goes wrong. Each look is recorded in the organizer's activity log.

## Hosting (free): Cloudflare Workers + D1

1. Create a free Cloudflare account.
2. Deploy:
   ```bash
   npm install
   npx wrangler login
   npx wrangler deploy
   ```
   The D1 database is created on first deploy. If wrangler asks for a database id, run `npx wrangler d1 create secret-santa` and add the `database_id` it prints to `wrangler.jsonc`. Tables are created automatically on first visit.
3. Set the secrets:
   ```bash
   npx wrangler secret put ADMIN_PASSWORD   # organizer password (required)
   npx wrangler secret put OPS_KEY          # helper key for the sealed list (optional)
   ```
4. Optional email alerts (free Brevo account, sender email verified in Brevo):
   ```bash
   npx wrangler secret put BREVO_API_KEY
   npx wrangler secret put EMAIL_FROM
   ```

## Local development

```bash
printf 'ADMIN_PASSWORD=test\nOPS_KEY=test\n' > .dev.vars
npm run dev      # http://localhost:8787
npm test         # draw logic tests
```

## Practice run

Do a practice round with a few people, then on the organizer page open **Practice run tools → Clear everyone out**. Dates and settings are kept.
