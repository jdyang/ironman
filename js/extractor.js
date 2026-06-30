/* extractor.js — 从对话记录里提炼 Checklist(议题/要点/决议)和 To-Do(待办)。
 * 纯规则、无需联网。针对"手机语音识别几乎没有标点、口语连读"做了专门处理:
 *   1) 先做软切分:在连接词/时间词/承诺词前插入边界,把长串拆成小句;
 *   2) 去口语填充词(那个/这个/呃…);
 *   3) 用更贴近口语的线索词识别"待办 / 议题 / 决议",并抽取时间和主题。
 */
(function (global) {
  'use strict';

  // —— 线索词 ——
  const COMMIT = ['我来', '我去', '我负责', '我处理', '我搞定', '我先', '我会', '回头我', '待会我', '稍后我', '你负责', '你来', '帮我', '帮你', '帮忙'];
  const MEETING = ['开会', '开个会', '碰一下', '碰个头', '碰头', '对一下', '约一下', '约个', '聊一下', '聊聊', '讨论', '过一下', '复盘', '评审', '面试', '拉个会', '电话会', '沟通一下'];
  const ACTION = ['测试', '试一下', '看一下', '查一下', '算一下', '想一下', '准备', '安排', '整理', '确认', '核对', '检查', '更新', '修改', '补充', '联系', '跟进', '推进', '落实', '提交', '上线', '上传', '下单', '报名', '报价', '发给', '发一下', '发我', '发你', '出个', '做个', '写个', '出方案', '排期', 'todo', 'follow up'];
  const NEED = ['需要', '记得', '别忘', '务必', '一定要', '千万', '下一步', '待办', '要做'];
  const DECISION = ['决定', '确定', '定了', '定下来', '敲定', '通过', '同意', '达成一致', '达成共识', '结论', '共识', '方案是', '我们就', '那就这么', '确认是', '拍板', '最终'];

  // 名词性"事项"线索(有这些说明在谈具体事)
  const OBJ_HINT = /的事情?|的问题|名单|方案|文案|报价|预算|资料|材料|链接|文档|表格|时间|地点|流程|计划|安排|夏令营|活动|项目|需求|功能|bug|上线/i;

  // 时间/截止表达
  const TIME_WORDS = [
    '今天', '今晚', '今早', '明天', '明早', '明晚', '后天', '大后天',
    '周一', '周二', '周三', '周四', '周五', '周六', '周日', '周末',
    '下周', '这周', '本周', '月底', '月初', '下个月', '年底',
  ];
  const DUE_RE = new RegExp(
    [
      // 更具体的放前面,保证"下周一"不被"下周"截断
      '下(个)?周[一二三四五六日天]', '这周[一二三四五六日天]', '本周[一二三四五六日天]',
      '星期[一二三四五六日天]', '周[一二三四五六日](?=之前|前|早|晚|上午|下午|$|[^一二三四五六日天])',
      '\\d+月\\d+[日号]', '\\d+[日号](?![a-zA-Z])', '\\d+点', '\\d+\\s*(天|小时|周|个月)内?',
      TIME_WORDS.join('|'),
      '之前', '之内', '截止', 'ddl', 'deadline', '尽快', '马上', '立刻', '回头', '待会', '稍后',
    ].join('|'),
    'i'
  );

  // 软切分的"边界词":在它们前面断开。
  // 注意:时间断点只用较长/无歧义的词,避免把"下周一"切成"下"+"周一"。
  const TIME_BREAK = ['今天', '今晚', '明天', '明早', '明晚', '后天', '大后天', '下周', '这周', '本周', '下个月', '月底', '月初', '年底', '周末'];
  const BREAK_BEFORE = []
    .concat(['然后', '接下来', '另外', '还有', '再就是', '其次', '首先', '所以', '不过', '但是', '而且', '第二', '第三', '另一个'])
    .concat(COMMIT)
    .concat(['需要', '记得', '别忘'])
    .concat(TIME_BREAK);

  // 填充词(整体抹掉,降低噪声)
  const FILLERS = ['那个', '这个', '就是说', '你看', '我跟你说', '我跟你讲', '呃', '嗯', '啊', '唉', '哈', '哦', '那么'];

  const SEP = '';

  function clean(text) {
    let t = text.replace(/\s+/g, '');
    FILLERS.forEach((f) => { t = t.split(f).join(''); });
    return t;
  }

  function segment(text) {
    let t = clean(text);
    // 已有标点 → 直接作为边界
    t = t.replace(/[。！？!?；;，,、]+/g, SEP);
    // 连接词/时间/承诺词前插入边界
    BREAK_BEFORE.forEach((w) => { t = t.split(w).join(SEP + w); });
    return t.split(SEP).map((s) => s.trim()).filter((s) => s.length >= 3);
  }

  function hasAny(text, list) {
    const low = text.toLowerCase();
    for (let i = 0; i < list.length; i++) {
      if (low.indexOf(list[i].toLowerCase()) >= 0) return list[i];
    }
    return null;
  }

  function findDue(text) {
    const m = text.match(DUE_RE);
    return m ? m[0] : null;
  }

  // 抽取"主题":聊一下/讨论/说一下 X 的事 → X(必须以"的事/的问题"收尾,避免抓进无关字)
  function findTopic(text) {
    const m = text.match(/(?:讨论|聊一下|聊聊|说一下|谈一下|过一下)(.{2,16}?)的(?:事情?|问题)/);
    if (m && m[1] && m[1].length >= 2) return trimEnds(m[1]);
    return null;
  }

  // 去掉小句开头/结尾的弱词,让待办读起来更干净
  function trimLead(s) {
    return trimEnds(s.replace(/^(我们|你们|咱们|大家|我|你|他|她|那|就|再|还|也|先|要|得|去|想|帮|把|给|让|这|个|的)+/, ''));
  }
  function trimEnds(s) {
    s = s.replace(/(你们|咱们|我们|你|我|他|她|的|了|吧|啊|呢|嘛|哈)+$/, '').trim();
    return s || '';
  }

  function norm(s) { return s.replace(/\s+/g, '').toLowerCase(); }

  function extract(segments) {
    const todo = [];
    const checklist = [];
    const seenTodo = new Set();
    const seenCheck = new Set();
    const topics = [];
    const seenTopic = new Set();

    segments.forEach((seg) => {
      segment(seg.text).forEach((s) => {
        const due = findDue(s);
        const commit = hasAny(s, COMMIT);
        const meeting = hasAny(s, MEETING);
        const action = hasAny(s, ACTION);
        const need = hasAny(s, NEED);
        const decision = hasAny(s, DECISION);
        const hasObj = OBJ_HINT.test(s);
        const topic = findTopic(s);

        // —— 议题:谁谈了什么(进 checklist) ——
        if (topic) {
          const k = norm(topic);
          if (!seenTopic.has(k)) {
            seenTopic.add(k);
            topics.push({ text: '讨论:' + topic, speaker: seg.speaker });
          }
        }

        // —— 决议(进 checklist) ——
        if (decision) {
          const k = norm(s);
          if (!seenCheck.has(k)) {
            seenCheck.add(k);
            checklist.push({ text: trimLead(s), speaker: seg.speaker });
          }
        }

        // —— 待办判定 ——
        const isTodo =
          commit ||
          meeting ||
          need ||
          (action && (due || hasObj));
        if (isTodo) {
          const k = norm(s);
          if (!seenTodo.has(k)) {
            seenTodo.add(k);
            todo.push({ text: trimLead(s), speaker: seg.speaker, due: due });
          }
        }
      });
    });

    // checklist = 决议优先,其次议题
    topics.forEach((t) => {
      const k = norm(t.text);
      if (!seenCheck.has(k)) { seenCheck.add(k); checklist.push(t); }
    });

    return { checklist: checklist, todo: todo };
  }

  global.Extractor = { extract: extract };
})(window);
