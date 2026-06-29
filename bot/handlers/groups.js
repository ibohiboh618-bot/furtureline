// bot/handlers/groups.js
//
// Handles the bot being added to a group/channel, and lets an admin
// configure what gets broadcast there. Deliberately does NOT require
// disabling Telegram privacy mode -- we only ever push messages out, we
// never need to read group chatter, so the default privacy-mode-on
// behavior (bot only sees explicit commands) is exactly right here.

const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function registerGroupHandlers(bot) {
  // Fired when the bot's own membership status changes in a chat --
  // covers both "added to group" and "promoted to admin in channel".
  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.myChatMember;
    const chat = update.chat;
    const newStatus = update.new_chat_member.status;

    if (chat.type === 'private') return;

    const isActive = ['member', 'administrator'].includes(newStatus);
    const isAdmin = newStatus === 'administrator';

    if (isActive) {
      await upsertBroadcastTarget({
        chatId: chat.id,
        chatType: chat.type,
        title: chat.title,
        isAdminBot: isAdmin,
      });

      if (chat.type !== 'channel') {
        // Channels are one-way; posting a guide message there would just
        // be noise to subscribers. Groups can see this immediately.
        await ctx.api.sendMessage(
          chat.id,
          "Thanks for adding FixtureLine! I'll post goal alerts and match updates here.\n\n" +
          "Admins can run /alertlevel to choose how much detail gets posted " +
          "(goals only, goals and cards, or everything)."
        ).catch(() => {}); // best-effort, don't crash if perms are odd
      }
    } else {
      await deactivateBroadcastTarget(chat.id);
    }
  });

  // Privacy-mode-safe: this only fires because it's an explicit command
  // addressed to the bot (/alertlevel or /alertlevel@FixtureLineBot),
  // which Telegram always delivers regardless of privacy mode.
  bot.command('alertlevel', async (ctx) => {
    if (ctx.chat.type === 'private') {
      return ctx.reply('This command is for groups and channels, not DMs.');
    }

    const isAdmin = await isUserChatAdmin(ctx);
    if (!isAdmin) {
      return ctx.reply('Only group admins can change the alert level.');
    }

    const level = ctx.match?.trim();
    const valid = ['goals_only', 'goals_and_cards', 'all_events'];

    if (!valid.includes(level)) {
      return ctx.reply(
        'Usage: /alertlevel goals_only | goals_and_cards | all_events'
      );
    }

    await pool.query(
      `update broadcast_targets set alert_level = $1 where chat_id = $2`,
      [level, ctx.chat.id]
    );

    await ctx.reply(`Alert level set to ${level}.`);
  });
}

async function upsertBroadcastTarget({ chatId, chatType, title, isAdminBot }) {
  await pool.query(
    `insert into broadcast_targets (chat_id, chat_type, title, is_admin_bot, active)
     values ($1, $2, $3, $4, true)
     on conflict (chat_id) do update set
       title = excluded.title,
       is_admin_bot = excluded.is_admin_bot,
       active = true`,
    [chatId, chatType, title, isAdminBot]
  );
}

async function deactivateBroadcastTarget(chatId) {
  await pool.query(`update broadcast_targets set active = false where chat_id = $1`, [chatId]);
}

async function isUserChatAdmin(ctx) {
  try {
    const member = await ctx.getAuthor(); // grammy helper, falls back below if unavailable
    return ['administrator', 'creator'].includes(member.status);
  } catch {
    const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    return ['administrator', 'creator'].includes(member.status);
  }
}

module.exports = { registerGroupHandlers };
