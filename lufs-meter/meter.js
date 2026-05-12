/*
  Web LUFS Meter R&D

  This is a browser-friendly approximation of an ITU-R BS.1770-4 loudness meter.
  It is useful for portfolio/demo work, but it is not a calibrated compliance
  meter. The main approximations are:
  - K-weighting is implemented with RBJ biquad high-pass/high-shelf filters,
    not the exact coefficient set used by certified meters.
  - Browser tab audio is captured through getDisplayMedia. YouTube iframe audio
    cannot be routed directly into Web Audio because of browser security policy.
  - Multichannel input is summed with equal channel weights.
  - True Peak currently displays sample peak max. TODO: add oversampling.
*/

const LUFS_OFFSET = -0.691;
const ABSOLUTE_GATE_LUFS = -70;
const TARGET_LUFS = -24;
const MIN_METER_LUFS = -54;
const MAX_METER_LUFS = 0;
const BLOCK_SECONDS = 0.4;
const SHORT_TERM_SECONDS = 3;
const SHORT_TERM_RECORD_MS = 250;
const DISPLAY_SMOOTHING = 0.32;
const LRA_MAX = 20;
const HISTOGRAM_MIN = -60;
const HISTOGRAM_MAX = 0;
const HISTOGRAM_STEP = 3;
const TICKS = [0, -3, -6, -9, -18, -24, -27, -36, -45, -54];

const els = {
  start: document.querySelector("#startButton"),
  stop: document.querySelector("#stopButton"),
  reset: document.querySelector("#resetButton"),
  statusPanel: document.querySelector(".status-panel"),
  status: document.querySelector("#statusText"),
  integratedValue: document.querySelector("#integratedValue"),
  integratedBottom: document.querySelector("#integratedBottom"),
  shortTermValue: document.querySelector("#shortTermValue"),
  lraValue: document.querySelector("#lraValue"),
  lraBottom: document.querySelector("#lraBottom"),
  peakValue: document.querySelector("#peakValue"),
  peakSummary: document.querySelector("#peakSummary"),
  realtimeValue: document.querySelector("#realtimeValue"),
  integratedFill: document.querySelector("#integratedFill"),
  realtimeFill: document.querySelector("#realtimeFill"),
  lraFill: document.querySelector("#lraFill"),
  integratedTicks: document.querySelector("#integratedTicks"),
  distribution: document.querySelector("#distributionView")
};

let audioContext = null;
let stream = null;
let source = null;
let processor = null;
let sampleRate = 48000;
let blockSizeFrames = 0;
let blockEnergySum = 0;
let blockFrameCount = 0;
let blockLoudnessHistory = [];
let shortTermBuffer = null;
let shortTermIndex = 0;
let shortTermCount = 0;
let shortTermEnergySum = 0;
let shortTermHistory = [];
let histogramBins = [];
let distributionRows = [];
let biquadChains = [];
let peakMax = 0;
let realtimeLufs = Number.NEGATIVE_INFINITY;
let integratedLufs = Number.NEGATIVE_INFINITY;
let shortTermLufs = Number.NEGATIVE_INFINITY;
let lraValue = 0;
let displayIntegratedLufs = Number.NEGATIVE_INFINITY;
let displayShortTermLufs = Number.NEGATIVE_INFINITY;
let displayRealtimeLufs = Number.NEGATIVE_INFINITY;
let displayLraValue = 0;
let displayPeakDb = Number.NEGATIVE_INFINITY;
let running = false;
let lastShortTermRecord = 0;

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.statusPanel.classList.toggle("is-error", isError);
}

function lufsToMeterPercent(lufs) {
  if (!Number.isFinite(lufs)) return 0;
  const clamped = Math.max(MIN_METER_LUFS, Math.min(MAX_METER_LUFS, lufs));
  return ((clamped - MIN_METER_LUFS) / (MAX_METER_LUFS - MIN_METER_LUFS)) * 100;
}

function linearToDb(value) {
  if (value <= 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(value);
}

function energyToLufs(meanSquare) {
  if (meanSquare <= 0) return Number.NEGATIVE_INFINITY;
  return LUFS_OFFSET + 10 * Math.log10(meanSquare);
}

function meanEnergyToGatedLufs(blocks) {
  const absoluteGated = blocks.filter((block) => block.lufs > ABSOLUTE_GATE_LUFS);
  if (!absoluteGated.length) return Number.NEGATIVE_INFINITY;

  // First pass: mean energy after absolute gate.
  const ungatedMean = average(absoluteGated.map((block) => block.energy));
  const ungatedLufs = energyToLufs(ungatedMean);

  // BS.1770 integrated loudness applies a relative gate 10 LU below the first pass.
  const relativeGate = Math.max(ABSOLUTE_GATE_LUFS, ungatedLufs - 10);
  const relativeGated = absoluteGated.filter((block) => block.lufs > relativeGate);
  if (!relativeGated.length) return Number.NEGATIVE_INFINITY;

  return energyToLufs(average(relativeGated.map((block) => block.energy)));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sortedValues, percentileValue) {
  if (!sortedValues.length) return 0;
  const index = (sortedValues.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

function computeLra() {
  const values = shortTermHistory
    .filter((value) => Number.isFinite(value) && value > ABSOLUTE_GATE_LUFS)
    .sort((a, b) => a - b);

  if (values.length < 2) return 0;

  // Approximation: EBU-style LRA generally uses gated short-term loudness and
  // 10th/95th percentiles. This demo uses the same percentile idea with a
  // simpler absolute gate.
  return Math.max(0, percentile(values, 0.95) - percentile(values, 0.10));
}

function createBiquad(type, frequency, q, gainDb = 0) {
  const omega = 2 * Math.PI * frequency / sampleRate;
  const sin = Math.sin(omega);
  const cos = Math.cos(omega);
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;

  if (type === "highpass") {
    const alpha = sin / (2 * q);
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else if (type === "highshelf") {
    // RBJ high-shelf approximation. This gives the broad high-frequency lift
    // associated with BS.1770 K-weighting, but it is not a certified coefficient set.
    const amplitude = Math.pow(10, gainDb / 40);
    const slope = 1;
    const alpha = sin / 2 * Math.sqrt((amplitude + 1 / amplitude) * (1 / slope - 1) + 2);
    const beta = 2 * Math.sqrt(amplitude) * alpha;

    b0 = amplitude * ((amplitude + 1) + (amplitude - 1) * cos + beta);
    b1 = -2 * amplitude * ((amplitude - 1) + (amplitude + 1) * cos);
    b2 = amplitude * ((amplitude + 1) + (amplitude - 1) * cos - beta);
    a0 = (amplitude + 1) - (amplitude - 1) * cos + beta;
    a1 = 2 * ((amplitude - 1) - (amplitude + 1) * cos);
    a2 = (amplitude + 1) - (amplitude - 1) * cos - beta;
  } else {
    throw new Error(`Unsupported biquad type: ${type}`);
  }

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
    process(sample) {
      const output = this.b0 * sample + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1;
      this.x1 = sample;
      this.y2 = this.y1;
      this.y1 = output;
      return output;
    }
  };
}

function createKWeightingChain() {
  return [
    createBiquad("highpass", 60, 0.5),
    createBiquad("highshelf", 1500, 0.707, 4)
  ];
}

function processKWeightedSample(sample, channelIndex) {
  if (!biquadChains[channelIndex]) {
    biquadChains[channelIndex] = createKWeightingChain();
  }
  return biquadChains[channelIndex].reduce((value, filter) => filter.process(value), sample);
}

function resetAnalysis() {
  blockEnergySum = 0;
  blockFrameCount = 0;
  blockLoudnessHistory = [];
  shortTermBuffer = sampleRate ? new Float32Array(Math.round(sampleRate * SHORT_TERM_SECONDS)) : null;
  shortTermIndex = 0;
  shortTermCount = 0;
  shortTermEnergySum = 0;
  shortTermHistory = [];
  histogramBins = Array.from({ length: Math.ceil((HISTOGRAM_MAX - HISTOGRAM_MIN) / HISTOGRAM_STEP) }, () => 0);
  distributionRows = [];
  els.distribution.innerHTML = "";
  biquadChains = [];
  peakMax = 0;
  realtimeLufs = Number.NEGATIVE_INFINITY;
  integratedLufs = Number.NEGATIVE_INFINITY;
  shortTermLufs = Number.NEGATIVE_INFINITY;
  lraValue = 0;
  displayIntegratedLufs = Number.NEGATIVE_INFINITY;
  displayShortTermLufs = Number.NEGATIVE_INFINITY;
  displayRealtimeLufs = Number.NEGATIVE_INFINITY;
  displayLraValue = 0;
  displayPeakDb = Number.NEGATIVE_INFINITY;
  lastShortTermRecord = 0;
  render();
}

function addShortTermEnergy(frameEnergy) {
  if (!shortTermBuffer) return;
  if (shortTermCount < shortTermBuffer.length) {
    shortTermCount += 1;
  } else {
    shortTermEnergySum -= shortTermBuffer[shortTermIndex];
  }
  shortTermBuffer[shortTermIndex] = frameEnergy;
  shortTermEnergySum += frameEnergy;
  shortTermIndex = (shortTermIndex + 1) % shortTermBuffer.length;
}

function addHistogramValue(lufs) {
  if (!Number.isFinite(lufs) || lufs < HISTOGRAM_MIN || lufs > HISTOGRAM_MAX) return;
  const index = Math.min(histogramBins.length - 1, Math.max(0, Math.floor((lufs - HISTOGRAM_MIN) / HISTOGRAM_STEP)));
  histogramBins[index] += 1;
}

function finalizeBlock() {
  if (!blockFrameCount) return;
  const meanSquare = blockEnergySum / blockFrameCount;
  const lufs = energyToLufs(meanSquare);
  realtimeLufs = lufs;

  const block = { energy: meanSquare, lufs };
  blockLoudnessHistory.push(block);
  addHistogramValue(lufs);
  integratedLufs = meanEnergyToGatedLufs(blockLoudnessHistory);

  blockEnergySum = 0;
  blockFrameCount = 0;
}

function handleAudioProcess(event) {
  const input = event.inputBuffer;
  const output = event.outputBuffer;
  const channelCount = input.numberOfChannels;
  const frameCount = input.length;

  // Keep the processing node connected without playing the mic signal back.
  for (let ch = 0; ch < output.numberOfChannels; ch += 1) {
    output.getChannelData(ch).fill(0);
  }

  for (let i = 0; i < frameCount; i += 1) {
    let frameEnergy = 0;

    for (let ch = 0; ch < channelCount; ch += 1) {
      const sample = input.getChannelData(ch)[i] || 0;
      peakMax = Math.max(peakMax, Math.abs(sample));
      const weighted = processKWeightedSample(sample, ch);
      frameEnergy += weighted * weighted;
    }

    // For multichannel material BS.1770 sums weighted channel energies.
    // Captured browser/tab audio is usually mono or stereo; surround weights are not applied here.
    blockEnergySum += frameEnergy;
    blockFrameCount += 1;
    addShortTermEnergy(frameEnergy);

    if (blockFrameCount >= blockSizeFrames) {
      finalizeBlock();
    }
  }
}

async function requestBrowserOutputStream() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("이 브라우저는 탭/화면 오디오 공유(getDisplayMedia)를 지원하지 않습니다.");
  }

  const captureStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      suppressLocalAudioPlayback: false
    }
  });

  const audioTracks = captureStream.getAudioTracks();
  if (!audioTracks.length) {
    captureStream.getTracks().forEach((track) => track.stop());
    throw new Error("공유 창에서 '탭 오디오 공유' 또는 '시스템 오디오 공유'를 선택해야 합니다.");
  }

  captureStream.getTracks().forEach((track) => {
    track.addEventListener("ended", () => {
      if (running) stopMeter();
    });
  });

  return captureStream;
}

async function startMeter() {
  if (running) return;
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    sampleRate = audioContext.sampleRate;
    blockSizeFrames = Math.round(sampleRate * BLOCK_SECONDS);
    resetAnalysis();

    stream = await requestBrowserOutputStream();

    source = audioContext.createMediaStreamSource(stream);

    // ScriptProcessorNode is deprecated, but it is still widely supported and
    // keeps this GitHub Pages MVP simple. AudioWorklet would be the next step.
    processor = audioContext.createScriptProcessor(4096, source.channelCount || 1, 1);
    processor.onaudioprocess = handleAudioProcess;
    source.connect(processor);
    processor.connect(audioContext.destination);

    running = true;
    els.start.disabled = true;
    els.stop.disabled = false;
    setStatus("브라우저 탭 오디오를 분석 중입니다. YouTube 재생 신호에 따라 LUFS, LRA, Peak 값이 갱신됩니다.");
  } catch (error) {
    stopMeter();
    setStatus(`브라우저 오디오 공유를 시작할 수 없습니다: ${error.message}`, true);
  }
}

function stopMeter() {
  running = false;
  els.start.disabled = false;
  els.stop.disabled = true;

  if (processor) {
    processor.disconnect();
    processor.onaudioprocess = null;
    processor = null;
  }
  if (source) {
    source.disconnect();
    source = null;
  }
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  if (!els.statusPanel.classList.contains("is-error")) {
    setStatus("분석이 정지되었습니다.");
  }
}

function formatLufs(value) {
  return Number.isFinite(value) ? value.toFixed(1) : "--.-";
}

function smoothValue(current, target, amount = DISPLAY_SMOOTHING) {
  if (!Number.isFinite(target)) return current;
  if (!Number.isFinite(current)) return target;
  return current + (target - current) * amount;
}

function renderTicks() {
  els.integratedTicks.innerHTML = "";
  TICKS.forEach((tickValue) => {
    const tick = document.createElement("div");
    tick.className = "tick";
    if (tickValue === TARGET_LUFS) tick.classList.add("is-target");
    tick.style.bottom = `${lufsToMeterPercent(tickValue)}%`;
    tick.innerHTML = `<strong>${tickValue}</strong>`;
    els.integratedTicks.appendChild(tick);
  });
}

function renderDistribution() {
  const maxCount = Math.max(1, ...histogramBins);

  if (distributionRows.length !== histogramBins.length) {
    els.distribution.innerHTML = "";
    distributionRows = [];
    for (let upper = HISTOGRAM_MAX; upper > HISTOGRAM_MIN; upper -= HISTOGRAM_STEP) {
      const lower = upper - HISTOGRAM_STEP;
      const row = document.createElement("div");
      row.className = "dist-row";
      if (upper > -3) row.classList.add("is-peak");
      if (lower <= TARGET_LUFS && TARGET_LUFS < upper) row.classList.add("is-target");
      row.innerHTML = `
        <div class="dist-label">${upper}</div>
        <div class="dist-track"><div class="dist-bar"></div></div>
        <div class="dist-label">${upper}</div>
      `;
      els.distribution.appendChild(row);
      distributionRows.push(row);
    }
  }

  for (let upper = HISTOGRAM_MAX; upper > HISTOGRAM_MIN; upper -= HISTOGRAM_STEP) {
    const lower = upper - HISTOGRAM_STEP;
    const index = Math.floor((lower - HISTOGRAM_MIN) / HISTOGRAM_STEP);
    const count = histogramBins[index] || 0;
    const rowIndex = Math.floor((HISTOGRAM_MAX - upper) / HISTOGRAM_STEP);
    const bar = distributionRows[rowIndex]?.querySelector(".dist-bar");
    if (bar) bar.style.width = `${Math.max(1, (count / maxCount) * 100)}%`;
  }
}

function render() {
  if (shortTermCount > 0) {
    shortTermLufs = energyToLufs(shortTermEnergySum / shortTermCount);
  }

  const now = performance.now();
  if (running && Number.isFinite(shortTermLufs) && now - lastShortTermRecord > SHORT_TERM_RECORD_MS) {
    shortTermHistory.push(shortTermLufs);
    lastShortTermRecord = now;
    lraValue = computeLra();
  }

  const peakDb = linearToDb(peakMax);
  displayIntegratedLufs = smoothValue(displayIntegratedLufs, integratedLufs);
  displayShortTermLufs = smoothValue(displayShortTermLufs, shortTermLufs, 0.42);
  displayRealtimeLufs = smoothValue(displayRealtimeLufs, realtimeLufs, 0.58);
  displayLraValue = smoothValue(displayLraValue, lraValue, 0.24);
  displayPeakDb = smoothValue(displayPeakDb, peakDb, 0.7);

  els.integratedValue.textContent = formatLufs(displayIntegratedLufs);
  els.integratedBottom.textContent = formatLufs(displayIntegratedLufs);
  els.shortTermValue.textContent = formatLufs(displayShortTermLufs);
  els.realtimeValue.textContent = `${formatLufs(displayRealtimeLufs)} LUFS`;
  els.lraValue.textContent = displayLraValue ? displayLraValue.toFixed(1) : "--.-";
  els.lraBottom.textContent = displayLraValue ? displayLraValue.toFixed(1) : "--.-";
  els.peakValue.textContent = Number.isFinite(displayPeakDb) ? displayPeakDb.toFixed(1) : "--.-";
  if (els.peakSummary) {
    els.peakSummary.textContent = Number.isFinite(displayPeakDb) ? displayPeakDb.toFixed(1) : "--.-";
  }

  els.integratedFill.style.height = `${lufsToMeterPercent(displayIntegratedLufs)}%`;
  els.realtimeFill.style.width = `${lufsToMeterPercent(displayRealtimeLufs)}%`;
  els.lraFill.style.height = `${Math.min(100, (displayLraValue / LRA_MAX) * 100)}%`;
  renderDistribution();
}

function renderLoop() {
  render();
  requestAnimationFrame(renderLoop);
}

els.start.addEventListener("click", startMeter);
els.stop.addEventListener("click", stopMeter);
els.reset.addEventListener("click", () => {
  if (audioContext) {
    sampleRate = audioContext.sampleRate;
  }
  resetAnalysis();
  setStatus(running ? "분석값을 초기화했습니다. 입력 분석은 계속 진행 중입니다." : "분석값을 초기화했습니다.");
});

renderTicks();
resetAnalysis();
renderLoop();
