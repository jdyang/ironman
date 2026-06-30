/* storage.js — 用 localStorage 保存历史会议 */
(function (global) {
  'use strict';

  const KEY = 'meetings.v1';

  function load() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function saveAll(list) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch (e) {
      /* 容量满等情况静默失败 */
    }
  }

  const Storage = {
    list() {
      return load().sort((a, b) => b.createdAt - a.createdAt);
    },
    get(id) {
      return load().find((m) => m.id === id) || null;
    },
    save(meeting) {
      const list = load();
      const idx = list.findIndex((m) => m.id === meeting.id);
      if (idx >= 0) list[idx] = meeting;
      else list.push(meeting);
      saveAll(list);
      return meeting;
    },
    remove(id) {
      saveAll(load().filter((m) => m.id !== id));
    },
  };

  global.Storage = Storage;
})(window);
