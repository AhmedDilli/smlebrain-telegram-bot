'use strict';
// Read-only: can the bot post in @sdlebrain? Sends nothing to the channel.
const token = process.env.TELEGRAM_BOT_TOKEN;
const api = async (m, body) => (await fetch(`https://api.telegram.org/bot${token}/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
(async () => {
  const me = await api('getMe');
  const chat = await api('getChat', { chat_id: '@sdlebrain' });
  const member = chat.ok ? await api('getChatMember', { chat_id: '@sdlebrain', user_id: me.result.id }) : null;
  const say = (m) => console.log(`::notice title=Telegram::${m}`);
  say(`bot @${me.result?.username}; chat: ${chat.ok ? `${chat.result.title} (${chat.result.type})` : `ERROR ${chat.description}`}`);
  if (member) say(`bot status in channel: ${member.ok ? `${member.result.status}, can post: ${member.result.can_post_messages ?? 'n/a'}` : `ERROR ${member.description}`}`);
})().catch((e) => { console.log(`::error::${String(e.message).slice(0, 200)}`); process.exit(1); });
