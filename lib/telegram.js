'use strict';

/** The few Telegram Bot API calls the bot makes. */

const LIMITS = {
  message: 4096,
  pollQuestion: 300,
  pollOption: 100,
  pollExplanation: 200,
};

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

class Telegram {
  /** [dryRun] prints what would be sent instead of sending it. */
  constructor(token, { dryRun = false, log = console.log } = {}) {
    this.token = token;
    this.dryRun = dryRun;
    this.log = log;
  }

  async call(method, body) {
    if (this.dryRun) {
      this.log(`---- ${method} → ${body.chat_id}\n${JSON.stringify(body, null, 2)}\n`);
      return {};
    }
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      throw new Error(`Telegram refused ${method} to ${body.chat_id}: ${result.description ?? response.status}`);
    }
    return result.result;
  }

  /** Plain text, sent exactly as given. */
  sendText(chat, text) {
    return this.call('sendMessage', {
      chat_id: chat,
      text,
      link_preview_options: { is_disabled: true },
    });
  }

  /** HTML-formatted text; callers escape their own content with escapeHtml. */
  sendHtml(chat, html) {
    return this.call('sendMessage', {
      chat_id: chat,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  }

  sendQuiz(chat, { question, options, correct, explanation }) {
    return this.call('sendPoll', {
      chat_id: chat,
      question,
      options: options.map((text) => ({ text })),
      type: 'quiz',
      is_anonymous: true,
      correct_option_id: correct,
      ...(explanation ? { explanation } : {}),
    });
  }
}

module.exports = { Telegram, LIMITS, escapeHtml };
