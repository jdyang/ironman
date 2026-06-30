/* voiceprint.js — 纯浏览器声纹:用 Web Audio 提取音高/频谱特征,自动区分两个说话人。
 *
 * 原理(无需任何云服务/模型):
 *  - 用 AnalyserNode 不断取时域+频域数据;
 *  - 每帧算: 基频 f0(自相关) / 频谱质心 / 三个频带能量比;
 *  - 登记阶段为"我"和"对方"各算一个特征中心(centroid);
 *  - 识别阶段把一段话的平均特征,按 z-normalize 后比谁更近。
 * 注:这是轻量启发式,音色差别大时较准,差别小时会有误判。
 */
(function (global) {
  'use strict';

  const MIN_F0 = 70;   // Hz,成人语音基频下限
  const MAX_F0 = 350;  // Hz,上限
  const SAMPLE_MS = 70; // 取帧间隔
  const BUFFER_KEEP_MS = 40000; // 滚动缓存时长

  function VoicePrint() {
    this.ctx = null;
    this.analyser = null;
    this.source = null;
    this.stream = null;
    this.timeBuf = null;
    this.freqBuf = null;
    this.running = false;
    this.frames = [];          // 滚动缓存 {t, f:[f0,centroid,lo,mid,hi], voiced}
    this.profiles = { me: null, other: null }; // {mean:[], n}
    this.norm = null;          // 归一化用的 std 向量
    this._enroll = null;       // 进行中的登记 {speaker, frames:[]}
    this._tick = this._tick.bind(this);
    this.onLevel = null;       // 音量回调(0..1)
  }

  VoicePrint.prototype.start = async function () {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const AC = global.AudioContext || global.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.2;
    this.source.connect(this.analyser);
    this.timeBuf = new Float32Array(this.analyser.fftSize);
    this.freqBuf = new Uint8Array(this.analyser.frequencyBinCount);
    this.running = true;
    this._loop();
  };

  VoicePrint.prototype.stop = function () {
    this.running = false;
    if (this._timer) clearTimeout(this._timer);
    try { this.source && this.source.disconnect(); } catch (e) {}
    try { this.ctx && this.ctx.close(); } catch (e) {}
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  };

  VoicePrint.prototype._loop = function () {
    if (!this.running) return;
    this._tick();
    this._timer = setTimeout(() => this._loop(), SAMPLE_MS);
  };

  VoicePrint.prototype._now = function () {
    // 用 AudioContext 时钟做帧时间戳,和识别事件统一参照系
    return this.ctx ? this.ctx.currentTime * 1000 : 0;
  };
  VoicePrint.prototype.now = function () { return this._now(); };

  VoicePrint.prototype._tick = function () {
    const a = this.analyser;
    if (!a) return;
    a.getFloatTimeDomainData(this.timeBuf);
    a.getByteFrequencyData(this.freqBuf);

    const rms = computeRMS(this.timeBuf);
    if (this.onLevel) this.onLevel(Math.min(1, rms * 6));

    const voiced = rms > 0.012;
    let feat = null;
    if (voiced) {
      const f0 = autoCorrelate(this.timeBuf, this.ctx.sampleRate);
      const spec = spectralFeatures(this.freqBuf, this.ctx.sampleRate, a.fftSize);
      if (f0 > 0) {
        feat = [f0, spec.centroid, spec.lo, spec.mid, spec.hi];
      }
    }

    const t = this._now();
    if (feat) {
      this.frames.push({ t, f: feat });
      // 滚动裁剪
      const cutoff = t - BUFFER_KEEP_MS;
      while (this.frames.length && this.frames[0].t < cutoff) this.frames.shift();
      if (this._enroll) this._enroll.frames.push(feat);
    }
  };

  /* ---------- 登记 ---------- */
  VoicePrint.prototype.beginEnroll = function (speaker) {
    this._enroll = { speaker, frames: [] };
  };

  VoicePrint.prototype.endEnroll = function () {
    if (!this._enroll) return { ok: false, frames: 0 };
    const { speaker, frames } = this._enroll;
    this._enroll = null;
    if (frames.length < 6) return { ok: false, frames: frames.length };
    this.profiles[speaker] = { mean: meanVec(frames), n: frames.length, raw: frames };
    this._recomputeNorm();
    return { ok: true, frames: frames.length };
  };

  VoicePrint.prototype.hasProfile = function (speaker) {
    return !!this.profiles[speaker];
  };
  VoicePrint.prototype.ready = function () {
    return !!(this.profiles.me && this.profiles.other);
  };

  VoicePrint.prototype._recomputeNorm = function () {
    const all = [];
    ['me', 'other'].forEach((s) => {
      if (this.profiles[s] && this.profiles[s].raw) all.push.apply(all, this.profiles[s].raw);
    });
    if (all.length < 4) { this.norm = null; return; }
    this.norm = stdVec(all);
  };

  /* ---------- 识别 ---------- */
  // 对 [t0, t1] 时间窗内的语音帧做平均后分类。返回 'me' | 'other' | null
  VoicePrint.prototype.classifyWindow = function (t0, t1) {
    if (!this.ready()) return null;
    const inWin = this.frames.filter((fr) => fr.t >= t0 && fr.t <= t1);
    const use = inWin.length >= 3 ? inWin : this.frames.slice(-8);
    if (use.length < 3) return null;
    return this._classifyVec(meanVec(use.map((x) => x.f)));
  };

  // 实时猜测:最近 ~0.8s
  VoicePrint.prototype.guessNow = function () {
    if (!this.ready()) return null;
    const t = this._now();
    return this.classifyWindow(t - 800, t);
  };

  VoicePrint.prototype._classifyVec = function (v) {
    const norm = this.norm || [1, 1, 1, 1, 1];
    const dMe = zDist(v, this.profiles.me.mean, norm);
    const dOther = zDist(v, this.profiles.other.mean, norm);
    return dMe <= dOther ? 'me' : 'other';
  };

  /* ---------- 数学工具 ---------- */
  function computeRMS(buf) {
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  }

  // 有界自相关基频检测,只搜索人声基频对应的 lag 范围
  function autoCorrelate(buf, sampleRate) {
    const size = buf.length;
    let rms = computeRMS(buf);
    if (rms < 0.01) return -1;

    const minLag = Math.floor(sampleRate / MAX_F0);
    const maxLag = Math.min(Math.floor(sampleRate / MIN_F0), size - 1);
    const limit = size - maxLag;

    let bestLag = -1;
    let bestCorr = 0;
    let prevCorr = 0;
    let energy = 0;
    for (let i = 0; i < limit; i++) energy += buf[i] * buf[i];
    if (energy === 0) return -1;

    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < limit; i++) sum += buf[i] * buf[i + lag];
      const corr = sum / energy; // 归一化清晰度
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
      prevCorr = corr;
    }
    // 清晰度太低判为非周期(噪声/清音)
    if (bestLag < 0 || bestCorr < 0.3) return -1;
    return sampleRate / bestLag;
  }

  function spectralFeatures(freq, sampleRate, fftSize) {
    const binHz = sampleRate / fftSize;
    let total = 0, weighted = 0, lo = 0, mid = 0, hi = 0;
    for (let i = 1; i < freq.length; i++) {
      const m = freq[i];
      if (m === 0) continue;
      const f = i * binHz;
      if (f > 5000) break;
      total += m;
      weighted += f * m;
      if (f < 500) lo += m;
      else if (f < 1500) mid += m;
      else hi += m;
    }
    if (total === 0) return { centroid: 0, lo: 0, mid: 0, hi: 0 };
    return {
      centroid: weighted / total,
      lo: lo / total,
      mid: mid / total,
      hi: hi / total,
    };
  }

  function meanVec(rows) {
    const n = rows.length;
    const d = rows[0].length;
    const out = new Array(d).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) out[j] += rows[i][j];
    for (let j = 0; j < d; j++) out[j] /= n;
    return out;
  }

  function stdVec(rows) {
    const m = meanVec(rows);
    const n = rows.length;
    const d = m.length;
    const out = new Array(d).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) {
      const dd = rows[i][j] - m[j];
      out[j] += dd * dd;
    }
    for (let j = 0; j < d; j++) {
      out[j] = Math.sqrt(out[j] / n) || 1;
      if (out[j] < 1e-6) out[j] = 1;
    }
    return out;
  }

  function zDist(a, b, norm) {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
      const d = (a[i] - b[i]) / (norm[i] || 1);
      s += d * d;
    }
    return Math.sqrt(s);
  }

  global.VoicePrint = VoicePrint;
})(window);
