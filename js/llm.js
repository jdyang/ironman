/* llm.js — 可选:用 Claude API 从对话记录生成高质量 checklist / todo。
 * API key 只保存在本机 localStorage,直接从浏览器调用(加 dangerous-direct-browser-access 头)。
 * 没配置 key 时,app 会自动回退到本地规则版(extractor.js)。
 */
(function (global) {
  'use strict';

  const CFG_KEY = 'llm.config.v1';
  const API_URL = 'https://api.anthropic.com/v1/messages';
  const SPK = { me: '我', other: '对方' };

  const SYSTEM = [
    '你是中文会议纪要助手。下面是"我"和"对方"两个人的一段对话记录,',
    '可能没有标点、是口语连读,请合理理解上下文。请提炼为两部分:',
    '1) checklist:关键要点 / 决议 / 达成的共识(陈述性信息);',
    '2) todo:具体的待办行动项(谁要去做某事),尽量判断负责人是"我(me)"还是"对方(other)",并抽取截止时间(如"明天""下周一""周三之前")。',
    '只输出与会议内容相关的条目,不要编造;闲聊和寒暄忽略。speaker 不确定时填空字符串,due 没有时填空字符串。',
  ].join('');

  const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['checklist', 'todo'],
    properties: {
      checklist: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'speaker'],
          properties: {
            text: { type: 'string' },
            speaker: { type: 'string', enum: ['me', 'other', ''] },
          },
        },
      },
      todo: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'speaker', 'due'],
          properties: {
            text: { type: 'string' },
            speaker: { type: 'string', enum: ['me', 'other', ''] },
            due: { type: 'string' },
          },
        },
      },
    },
  };

  function loadCfg() {
    try {
      return JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }
  function saveCfg(cfg) {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg || {}));
  }

  const LLM = {
    getConfig: loadCfg,
    setConfig: saveCfg,
    enabled() {
      const c = loadCfg();
      return !!(c.enabled && c.key);
    },
    model() {
      return loadCfg().model || 'claude-opus-4-8';
    },

    async summarize(segments) {
      const c = loadCfg();
      if (!c.key) throw new Error('未配置 API key');

      const transcript = segments
        .map((s) => (SPK[s.speaker] || '某人') + '：' + s.text)
        .join('\n');

      const body = {
        model: c.model || 'claude-opus-4-8',
        max_tokens: 2000,
        system: SYSTEM,
        messages: [{ role: 'user', content: '对话记录:\n' + transcript }],
        output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      };

      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': c.key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try {
          const e = await res.json();
          if (e && e.error && e.error.message) msg = e.error.message;
        } catch (_) {}
        if (res.status === 401) msg = 'API key 无效或已失效';
        throw new Error(msg);
      }

      const data = await res.json();
      const block = (data.content || []).find((b) => b.type === 'text');
      if (!block) throw new Error('返回内容为空');
      const parsed = JSON.parse(block.text);
      return {
        checklist: (parsed.checklist || []).map((c2) => ({ text: c2.text, speaker: c2.speaker || '' })),
        todo: (parsed.todo || []).map((t) => ({ text: t.text, speaker: t.speaker || '', due: t.due || '' })),
      };
    },
  };

  global.LLM = LLM;
})(window);
