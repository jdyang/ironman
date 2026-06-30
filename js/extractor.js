/* extractor.js — 从对话记录里提炼 Checklist(要点/决议)和 To-Do(行动项)。
 * 纯规则,无需联网。中文为主,兼顾少量英文动词。
 */
(function (global) {
  'use strict';

  // 行动/承诺类关键词 → 待办
  const ACTION = [
    '我来', '我去', '我会', '我先', '我负责', '你负责', '他负责', '负责',
    '跟进', '落实', '安排', '对接', '推进', '处理', '准备', '整理',
    '发给', '发一下', '发我', '发你', '提交', '上传', '下载', '完成', '搞定',
    '记得', '别忘', '需要', '要做', '待办', '下一步', '回头', '回去',
    '预约', '约一下', '联系', '沟通', '反馈', '汇报', '出个', '做个', '写个',
    '出方案', '排期', '确认一下', '核对', '检查', '更新', '修改', '补充',
    'todo', 'follow up', 'followup',
  ];

  // 决议/结论类关键词 → checklist
  const DECISION = [
    '决定', '确定', '定了', '定下来', '敲定', '通过', '同意', '达成一致',
    '达成共识', '结论', '共识', '方案是', '我们就', '那就', '确认是',
    '一致认为', '最终', '拍板',
  ];

  // 时间/截止表达
  const DUE_RE = new RegExp(
    [
      '今天', '今晚', '今早', '明天', '明早', '明晚', '后天', '大后天',
      '周一', '周二', '周三', '周四', '周五', '周六', '周日', '周末',
      '星期[一二三四五六日天]', '下周[一二三四五六日]?', '这周', '本周',
      '月底', '月初', '下个?月', '年底',
      '\\d+月\\d+[日号]', '\\d+[日号]', '\\d+点', '\\d+\\s*(天|小时|周|个月)内?',
      '之前', '之内', '截止', 'ddl', 'deadline', '尽快', '马上', '立刻',
    ].join('|'),
    'i'
  );

  const SPLIT_RE = /[。！？!?；;\n]+|[，,](?=.{6,})/;

  function splitSentences(text) {
    return text
      .split(SPLIT_RE)
      .map((s) => s.trim())
      .filter((s) => s && s.length >= 4);
  }

  function hasAny(text, list) {
    for (let i = 0; i < list.length; i++) {
      if (text.toLowerCase().indexOf(list[i].toLowerCase()) >= 0) return list[i];
    }
    return null;
  }

  function findDue(text) {
    const m = text.match(DUE_RE);
    return m ? m[0] : null;
  }

  function norm(s) {
    return s.replace(/\s+/g, '').toLowerCase();
  }

  // 主函数:segments = [{speaker, text}]
  function extract(segments) {
    const todo = [];
    const checklist = [];
    const seenTodo = new Set();
    const seenCheck = new Set();
    const keyCandidates = [];

    segments.forEach((seg) => {
      const sents = splitSentences(seg.text);
      sents.forEach((s) => {
        const isAction = hasAny(s, ACTION);
        const isDecision = hasAny(s, DECISION);
        const due = findDue(s);

        if (isAction) {
          const k = norm(s);
          if (!seenTodo.has(k)) {
            seenTodo.add(k);
            todo.push({ text: s, speaker: seg.speaker, due: due });
          }
        }
        if (isDecision) {
          const k = norm(s);
          if (!seenCheck.has(k)) {
            seenCheck.add(k);
            checklist.push({ text: s, speaker: seg.speaker });
          }
        }
        // 候选要点:含数字/金额/确认且较长的句子
        if (!isAction && !isDecision && s.length >= 8 && /\d|确认|重要|关键|问题|风险/.test(s)) {
          keyCandidates.push({ text: s, speaker: seg.speaker, len: s.length });
        }
      });
    });

    // checklist 兜底:没有明确决议时,挑选信息量高的句子作为要点
    if (checklist.length === 0 && keyCandidates.length) {
      keyCandidates.sort((a, b) => b.len - a.len);
      keyCandidates.slice(0, 4).forEach((c) => {
        checklist.push({ text: c.text, speaker: c.speaker });
      });
    }

    return { checklist: checklist, todo: todo };
  }

  global.Extractor = { extract: extract };
})(window);
