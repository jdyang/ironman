/* recognition.js — 封装浏览器内置语音识别(Web Speech API),中文实时转写 */
(function (global) {
  'use strict';

  function getSR() {
    return global.SpeechRecognition || global.webkitSpeechRecognition || null;
  }

  function Recognition(opts) {
    opts = opts || {};
    this.lang = opts.lang || 'zh-CN';
    this.onInterim = opts.onInterim || function () {};
    this.onFinal = opts.onFinal || function () {};   // (text)
    this.onError = opts.onError || function () {};
    this.onSegmentStart = opts.onSegmentStart || function () {}; // 一段新语音开始
    this.rec = null;
    this.active = false;     // 期望运行
    this.paused = false;
    this._segOpen = false;
    this._restartTimer = null;
  }

  Recognition.supported = function () { return !!getSR(); };

  Recognition.prototype.start = function () {
    const SR = getSR();
    if (!SR) { this.onError('unsupported'); return; }
    this.active = true;
    this.paused = false;
    this._spinUp();
  };

  Recognition.prototype._spinUp = function () {
    const SR = getSR();
    const rec = new SR();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    const self = this;

    rec.onresult = function (e) {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const txt = res[0].transcript;
        if (!self._segOpen) { self._segOpen = true; self.onSegmentStart(); }
        if (res.isFinal) {
          const clean = (txt || '').trim();
          self._segOpen = false;
          if (clean) self.onFinal(clean);
        } else {
          interim += txt;
        }
      }
      self.onInterim(interim);
    };

    rec.onerror = function (e) {
      const err = e.error || 'error';
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        self.active = false;
        self.onError('not-allowed');
      } else if (err === 'no-speech' || err === 'aborted' || err === 'network') {
        // 可恢复:让 onend 负责重启
      } else {
        self.onError(err);
      }
    };

    rec.onend = function () {
      self._segOpen = false;
      if (self.active && !self.paused) {
        // Web Speech 会因静默/超时自动结束,这里持续重启保持"连续"录音
        clearTimeout(self._restartTimer);
        self._restartTimer = setTimeout(function () {
          try { rec.start(); } catch (e) { self._spinUp(); }
        }, 250);
      }
    };

    this.rec = rec;
    try { rec.start(); } catch (e) { /* 已在运行 */ }
  };

  Recognition.prototype.pause = function () {
    this.paused = true;
    if (this.rec) try { this.rec.stop(); } catch (e) {}
  };

  Recognition.prototype.resume = function () {
    if (!this.active) return;
    this.paused = false;
    this._spinUp();
  };

  Recognition.prototype.stop = function () {
    this.active = false;
    this.paused = false;
    clearTimeout(this._restartTimer);
    if (this.rec) {
      this.rec.onend = null;
      try { this.rec.stop(); } catch (e) {}
      try { this.rec.abort(); } catch (e) {}
    }
    this.rec = null;
  };

  global.Recognition = Recognition;
})(window);
