/* ============================================================
   AQUAROOT — SMART IRRIGATION PLATFORM
   script.js — Full Application Logic
   ESP32 API Simulation + FAO-56 Engine + Charts + UI
   ============================================================ */

'use strict';

/* ============================================================
   SUPABASE CONFIG
   Paste your actual Supabase project URL and anon/publishable key below.
   ============================================================ */
const SUPABASE_URL = "https://hzhaybstgurhfcymucoe.supabase.co"; // Paste your Supabase project URL here.
const SUPABASE_ANON_KEY = "sb_publishable_2RI88cyW-Csz3VkoJaOJgg_fMdUP5U9"; // Paste your Supabase anon/publishable key here.
const SUPABASE_CONFIG_READY =
  /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(SUPABASE_URL) &&
  typeof SUPABASE_ANON_KEY === 'string' &&
  SUPABASE_ANON_KEY.trim().length > 0;
const supabaseClient = SUPABASE_CONFIG_READY
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

/* ============================================================
   FAO-56 IRRIGATION ENGINE DATA
   ============================================================ */
const FAO56 = {
  // Crop coefficients (Kc) - mid-season values
  cropKc: {
    tomato:    { kc: 1.15, eto: 5.5, name: 'Tomato',    emoji: '🍅' },
    wheat:     { kc: 1.15, eto: 4.5, name: 'Wheat',     emoji: '🌾' },
    rice:      { kc: 1.20, eto: 6.0, name: 'Rice',      emoji: '🌾' },
    onion:     { kc: 1.05, eto: 4.0, name: 'Onion',     emoji: '🧅' },
    cotton:    { kc: 1.20, eto: 5.5, name: 'Cotton',    emoji: '🌿' },
    maize:     { kc: 1.20, eto: 5.0, name: 'Maize',     emoji: '🌽' },
    sugarcane: { kc: 1.25, eto: 6.5, name: 'Sugarcane', emoji: '🎋' },
    groundnut: { kc: 1.15, eto: 5.0, name: 'Groundnut', emoji: '🥜' },
  },

  // Soil drainage/retention factors
  soilFactor: {
    sandy: 0.85,  // drains fast, more irrigation needed
    loamy: 1.00,  // balanced, reference
    clay:  1.15,  // retains water, less irrigation
    black: 1.10,  // retains water well
  },

  // Weather demand factors
  weatherFactor: {
    sunny:  1.20,  // high evaporation
    cloudy: 0.90,  // moderate evaporation
    rainy:  0.40,  // minimal irrigation needed
  },

  // Litres per mm per acre (1 mm/acre = ~4047 litres)
  LITRES_PER_MM_PER_ACRE: 4047,

  // Flow rate assumption for duration calc (L/min)
  FLOW_RATE_LITRES_PER_MIN: 4.0,

  /**
   * Calculate ETc and generate 7-day irrigation schedule
   * @param {string} crop
   * @param {string} soil
   * @param {string} weather
   * @param {number} farmAcres
   * @param {number|null} manualOverrideLitres
   * @returns {Object} schedule data
   */
  calculate(crop, soil, weather, farmAcres, manualOverrideLitres = null) {
    const cropData   = this.cropKc[crop]     || this.cropKc.maize;
    const soilFac    = this.soilFactor[soil]  || 1.0;
    const weatherFac = this.weatherFactor[weather] || 1.0;

    // ETc in mm/day
    const etc = +(cropData.kc * cropData.eto * soilFac * weatherFac).toFixed(2);

    // Total water needed per day per acre (litres)
    const litersPerAcrePerDay = etc * this.LITRES_PER_MM_PER_ACRE / 1000;
    const totalLitresPerDay   = manualOverrideLitres || +(litersPerAcrePerDay * farmAcres).toFixed(0);

    // Duration in minutes
    const durationMin = +(totalLitresPerDay / this.FLOW_RATE_LITRES_PER_MIN).toFixed(0);

    // Generate 7-day schedule
    const today    = new Date();
    const days     = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const schedule = [];

    for (let i = 0; i < 7; i++) {
      const d    = new Date(today);
      d.setDate(today.getDate() + i);
      const dayName = days[d.getDay()];
      const dateNum = d.getDate();

      // Skip logic: always skip if rainy; stagger based on soil
      let shouldIrrigate = true;
      let reason         = '';

      if (weather === 'rainy') {
        shouldIrrigate = false;
        reason         = 'Skip — Rain expected';
      } else if (soil === 'clay' && i % 3 === 0 && i > 0) {
        shouldIrrigate = false;
        reason         = 'Skip — Clay holds moisture';
      } else if (soil === 'black' && i % 3 === 1) {
        shouldIrrigate = false;
        reason         = 'Skip — Soil retention ok';
      }

      const volume = shouldIrrigate ? +(totalLitresPerDay * (0.9 + Math.random() * 0.2)).toFixed(0) : 0;

      schedule.push({
        day: dayName,
        date: dateNum,
        irrigate: shouldIrrigate,
        reason,
        volume,
        duration: shouldIrrigate ? durationMin : 0,
        emoji: shouldIrrigate ? '💧' : '⛔',
      });
    }

    return {
      cropData,
      etc,
      totalLitresPerDay,
      durationMin,
      soilFac,
      weatherFac,
      schedule,
      farmAcres,
      weather,
      soil,
      crop,
    };
  },
};

/* ============================================================
   MOCK ESP32 API SERVICE
   ============================================================ */
const ESP32Api = (() => {
  // Internal device state (simulated)
  let state = {
    online:       true,
    pumpActive:   false,
    moisture:     65,
    flowRate:     0.0,
    waterDel:     0,
    temperature:  29,
    humidity:     49,
    tankLevel:    65,
    uptime:       8040,  // seconds
    rssi:         -52,
    freeHeap:     214,
    sessionStart: null,
  };

  // Simulate gradual sensor drift
  function drift(val, min, max, step) {
    const d = (Math.random() - 0.5) * step;
    return Math.max(min, Math.min(max, +(val + d).toFixed(1)));
  }

  return {
    /**
     * GET /status
     * Returns full device state snapshot
     */
    async getStatus() {
      await new Promise(r => setTimeout(r, 60 + Math.random() * 80));

      // Simulate natural drift
      state.moisture    = drift(state.moisture, 20, 95, 2.5);
      state.temperature = drift(state.temperature, 20, 40, 1.0);
      state.humidity    = drift(state.humidity, 30, 80, 2.0);
      state.rssi        = drift(state.rssi, -80, -30, 3.0);
      state.uptime     += 3;

      if (state.pumpActive) {
        state.flowRate  = drift(state.flowRate, 3.5, 4.8, 0.3);
        state.waterDel  = +(state.waterDel + state.flowRate * 0.05).toFixed(1);
        state.tankLevel = Math.max(5, state.tankLevel - 0.08);
        // Moisture rises when irrigating
        state.moisture  = Math.min(95, state.moisture + 0.4);
      } else {
        state.flowRate  = 0.0;
        // Moisture falls slowly when not irrigating
        state.moisture  = Math.max(20, state.moisture - 0.15);
      }

      return { ok: true, data: { ...state } };
    },

    /**
     * POST /start
     * Starts irrigation pump
     */
    async start() {
      await new Promise(r => setTimeout(r, 120 + Math.random() * 80));
      if (state.pumpActive) return { ok: false, msg: 'Pump already running' };
      state.pumpActive   = true;
      state.sessionStart = Date.now();
      state.flowRate     = 4.0;
      return { ok: true, msg: 'Irrigation started successfully' };
    },

    /**
     * POST /stop
     * Stops irrigation pump
     */
    async stop() {
      await new Promise(r => setTimeout(r, 100 + Math.random() * 80));
      if (!state.pumpActive) return { ok: false, msg: 'Pump is not running' };
      const duration = state.sessionStart
        ? Math.round((Date.now() - state.sessionStart) / 1000)
        : 0;
      state.pumpActive   = false;
      state.flowRate     = 0.0;
      state.sessionStart = null;
      return { ok: true, msg: 'Irrigation stopped', waterDelivered: state.waterDel, duration };
    },

    /**
     * GET /logs
     * Returns simulated activity log entries
     */
    async getLogs() {
      await new Promise(r => setTimeout(r, 80));
      return { ok: true, data: generateMockLogs() };
    },

    /** Direct state access for UI */
    getState: () => ({ ...state }),
    isPumpActive: () => state.pumpActive,
  };
})();

/* ============================================================
   LOG GENERATOR
   ============================================================ */
function generateMockLogs() {
  const events = [
    { event: 'Irrigation Started',   type: 'success', dur: '14 min', vol: '56', trigger: 'Schedule' },
    { event: 'Irrigation Completed', type: 'success', dur: '14 min', vol: '56', trigger: 'Auto' },
    { event: 'Low Water Warning',    type: 'warning', dur: '—',      vol: '—',  trigger: 'Sensor' },
    { event: 'Sensor Error',         type: 'error',   dur: '—',      vol: '—',  trigger: 'System' },
    { event: 'Irrigation Skipped',   type: 'info',    dur: '—',      vol: '—',  trigger: 'FAO-56: Rain' },
    { event: 'Irrigation Started',   type: 'success', dur: '18 min', vol: '72', trigger: 'Manual' },
    { event: 'Irrigation Completed', type: 'success', dur: '18 min', vol: '72', trigger: 'Manual' },
    { event: 'WiFi Reconnected',     type: 'info',    dur: '—',      vol: '—',  trigger: 'System' },
    { event: 'Irrigation Started',   type: 'success', dur: '12 min', vol: '48', trigger: 'Schedule' },
    { event: 'Low Moisture Alert',   type: 'warning', dur: '—',      vol: '—',  trigger: 'Sensor' },
  ];

  const now = Date.now();
  return events.map((e, i) => ({
    ...e,
    timestamp: new Date(now - (i * 3600000 + Math.random() * 1800000)),
  }));
}

/* ============================================================
   CHARTS MODULE
   ============================================================ */
const Charts = (() => {
  let instances = {};

  const COLORS = {
    emerald: '#10b981',
    emeraldLight: 'rgba(16,185,129,0.15)',
    cyan: '#06b6d4',
    cyanLight: 'rgba(6,182,212,0.15)',
    blue: '#3b82f6',
    blueLight: 'rgba(59,130,246,0.12)',
    amber: '#f59e0b',
    red: '#ef4444',
    slate: '#94a3b8',
    grid: 'rgba(148,163,184,0.1)',
  };

  function baseOptions(isDark) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 800, easing: 'easeOutQuart' },
      plugins: {
        legend: {
          labels: {
            color: isDark ? '#94a3b8' : '#475569',
            font: { family: 'Inter', size: 12, weight: '500' },
            boxWidth: 10, boxHeight: 10, borderRadius: 3,
          },
        },
        tooltip: {
          backgroundColor: isDark ? 'rgba(10,22,40,0.92)' : 'rgba(255,255,255,0.96)',
          titleColor: isDark ? '#f1f5f9' : '#0f172a',
          bodyColor: isDark ? '#94a3b8' : '#475569',
          borderColor: isDark ? 'rgba(148,163,184,0.15)' : 'rgba(148,163,184,0.2)',
          borderWidth: 1,
          cornerRadius: 10,
          padding: 12,
          titleFont: { family: 'Outfit', size: 13, weight: '700' },
          bodyFont: { family: 'Inter', size: 12 },
        },
      },
      scales: {
        x: {
          grid: { color: COLORS.grid },
          ticks: { color: isDark ? '#94a3b8' : '#64748b', font: { family: 'Inter', size: 11 } },
        },
        y: {
          grid: { color: COLORS.grid },
          ticks: { color: isDark ? '#94a3b8' : '#64748b', font: { family: 'Inter', size: 11 } },
        },
      },
    };
  }

  function makeGradient(ctx, color1, color2) {
    const g = ctx.createLinearGradient(0, 0, 0, 200);
    g.addColorStop(0, color1);
    g.addColorStop(1, color2);
    return g;
  }

  return {
    initAll() {
      this.initDashboardChart();
      this.initWaterUsageChart();
      this.initComparisonChart();
      this.initMoistureTrendChart();
      this.initMonthlyChart();
    },

    destroy(id) {
      if (instances[id]) { instances[id].destroy(); delete instances[id]; }
    },

    initDashboardChart() {
      this.destroy('dashboard');
      const ctx = document.getElementById('dashboardChart');
      if (!ctx) return;
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const labels = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2,'0')}:00`);
      const moisture = labels.map((_, i) => 50 + Math.sin(i * 0.4) * 20 + Math.random() * 10);
      const irrigEvents = labels.map((_, i) => (i >= 6 && i <= 8) || (i >= 17 && i <= 18) ? 80 : null);
      const opts = baseOptions(isDark);
      opts.plugins.legend.display = true;
      instances['dashboard'] = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'Soil Moisture (%)',
              data: moisture,
              borderColor: COLORS.emerald,
              backgroundColor: makeGradient(ctx.getContext('2d'), 'rgba(16,185,129,0.2)', 'rgba(16,185,129,0)'),
              fill: true,
              tension: 0.45,
              pointRadius: 0,
              pointHoverRadius: 5,
              borderWidth: 2.5,
            },
            {
              label: 'Irrigation Active',
              data: irrigEvents,
              borderColor: COLORS.cyan,
              backgroundColor: 'rgba(6,182,212,0.1)',
              fill: true,
              tension: 0,
              pointRadius: 0,
              borderWidth: 2,
              borderDash: [5, 3],
            },
          ],
        },
        options: opts,
      });
    },

    initWaterUsageChart() {
      this.destroy('waterUsage');
      const ctx = document.getElementById('waterUsageChart');
      if (!ctx) return;
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const g = ctx.getContext('2d');
      const grad = makeGradient(g, 'rgba(16,185,129,0.5)', 'rgba(16,185,129,0.05)');
      const opts = baseOptions(isDark);
      instances['waterUsage'] = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
          datasets: [{
            label: 'Water Used (L)',
            data: [142, 98, 167, 124, 190, 88, 155],
            backgroundColor: grad,
            borderColor: COLORS.emerald,
            borderWidth: 2,
            borderRadius: 8,
            borderSkipped: false,
          }],
        },
        options: { ...opts, plugins: { ...opts.plugins, legend: { display: false } } },
      });
    },

    initComparisonChart() {
      this.destroy('comparison');
      const ctx = document.getElementById('comparisonChart');
      if (!ctx) return;
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const opts = baseOptions(isDark);
      instances['comparison'] = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: ['Week 1','Week 2','Week 3','Week 4'],
          datasets: [
            {
              label: 'AquaRoot Smart (L)',
              data: [560, 610, 590, 640],
              backgroundColor: 'rgba(16,185,129,0.75)',
              borderColor: COLORS.emerald,
              borderWidth: 2,
              borderRadius: 6,
              borderSkipped: false,
            },
            {
              label: 'Flood Irrigation (L)',
              data: [1200, 1350, 1280, 1400],
              backgroundColor: 'rgba(59,130,246,0.55)',
              borderColor: COLORS.blue,
              borderWidth: 2,
              borderRadius: 6,
              borderSkipped: false,
            },
          ],
        },
        options: opts,
      });
    },

    initMoistureTrendChart() {
      this.destroy('moistureTrend');
      const ctx = document.getElementById('moistureTrendChart');
      if (!ctx) return;
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const g = ctx.getContext('2d');
      const grad = makeGradient(g, 'rgba(6,182,212,0.35)', 'rgba(6,182,212,0)');
      const labels = Array.from({ length: 12 }, (_, i) => `${String(i * 2).padStart(2,'0')}:00`);
      const opts = baseOptions(isDark);
      instances['moistureTrend'] = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Soil Moisture (%)',
            data: labels.map(() => 40 + Math.random() * 40),
            borderColor: COLORS.cyan,
            backgroundColor: grad,
            fill: true,
            tension: 0.5,
            pointRadius: 4,
            pointBackgroundColor: COLORS.cyan,
            pointBorderColor: '#fff',
            pointBorderWidth: 2,
            borderWidth: 2.5,
          }],
        },
        options: { ...opts, plugins: { ...opts.plugins, legend: { display: false } } },
      });
    },

    initMonthlyChart() {
      this.destroy('monthly');
      const ctx = document.getElementById('monthlyChart');
      if (!ctx) return;
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const opts = baseOptions(isDark);
      instances['monthly'] = new Chart(ctx, {
        type: 'line',
        data: {
          labels: ['Wk 1','Wk 2','Wk 3','Wk 4'],
          datasets: [
            {
              label: 'Volume (L)',
              data: [980, 1240, 1070, 1380],
              borderColor: COLORS.emerald,
              backgroundColor: 'rgba(16,185,129,0.15)',
              fill: true,
              tension: 0.45,
              pointRadius: 6,
              pointBackgroundColor: COLORS.emerald,
              pointBorderColor: '#fff',
              pointBorderWidth: 2.5,
              borderWidth: 2.5,
            },
            {
              label: 'Sessions',
              data: [12, 15, 13, 17],
              borderColor: COLORS.amber,
              backgroundColor: 'transparent',
              tension: 0.4,
              pointRadius: 5,
              pointBackgroundColor: COLORS.amber,
              pointBorderColor: '#fff',
              pointBorderWidth: 2,
              borderWidth: 2,
              yAxisID: 'y1',
            },
          ],
        },
        options: {
          ...opts,
          scales: {
            ...opts.scales,
            y1: {
              position: 'right',
              grid: { drawOnChartArea: false },
              ticks: {
                color: isDark ? '#94a3b8' : '#64748b',
                font: { family: 'Inter', size: 11 },
              },
            },
          },
        },
      });
    },

    /** Update all charts for theme change */
    updateTheme() {
      this.initAll();
    },

    /** Push a new moisture reading to the dashboard chart */
    pushMoistureReading(value) {
      const chart = instances['dashboard'];
      if (!chart) return;
      chart.data.datasets[0].data.push(value);
      chart.data.datasets[0].data.shift();
      chart.update('none');
    },
  };
})();

/* ============================================================
   NOTIFICATION SYSTEM
   ============================================================ */
const Notifications = (() => {
  const INITIAL_NOTIFICATIONS = [
    { id: 1, type: 'success', icon: 'fa-check-circle', title: 'Irrigation Completed', desc: 'Morning schedule ran for 14 min, 56L delivered.', time: '2 hours ago', unread: true },
    { id: 2, type: 'warning', icon: 'fa-triangle-exclamation', title: 'Low Water Warning', desc: 'Tank level dropped below 25%. Refill recommended.', time: '4 hours ago', unread: true },
    { id: 3, type: 'info',    icon: 'fa-circle-info', title: 'Irrigation Skipped', desc: 'FAO-56 engine detected rain forecast. Session skipped.', time: '6 hours ago', unread: false },
    { id: 4, type: 'error',   icon: 'fa-circle-xmark', title: 'Sensor Error',    desc: 'Temperature sensor briefly disconnected. Reconnected.', time: '1 day ago', unread: false },
    { id: 5, type: 'success', icon: 'fa-play-circle', title: 'Irrigation Started', desc: 'Evening session activated by schedule.', time: '1 day ago', unread: false },
  ];

  let notifications = [...INITIAL_NOTIFICATIONS];
  let nextId = 10;

  function renderNotifList() {
    const list = document.getElementById('notifList');
    if (!list) return;

    if (notifications.length === 0) {
      list.innerHTML = `
        <div style="padding:40px; text-align:center; color:var(--text-muted);">
          <i class="fa-solid fa-bell-slash" style="font-size:32px; margin-bottom:12px; display:block;"></i>
          No notifications
        </div>`;
      return;
    }

    list.innerHTML = notifications.map(n => `
      <div class="notif-item ${n.unread ? 'unread' : ''}" id="notif-${n.id}">
        <div class="notif-dot-icon ${n.type}">
          <i class="fa-solid ${n.icon}"></i>
        </div>
        <div class="notif-body">
          <div class="notif-title">${n.title}</div>
          <div class="notif-desc">${n.desc}</div>
          <div class="notif-time"><i class="fa-regular fa-clock" style="margin-right:4px;"></i>${n.time}</div>
        </div>
        ${n.unread ? '<div class="notif-unread-badge"></div>' : ''}
      </div>
    `).join('');

    // Update badge count
    const unreadCount = notifications.filter(n => n.unread).length;
    const badge = document.getElementById('notifBadge');
    if (badge) {
      badge.style.display = unreadCount > 0 ? 'block' : 'none';
    }
    const logBadge = document.getElementById('logBadge');
    if (logBadge) {
      logBadge.textContent = unreadCount;
      logBadge.style.display = unreadCount > 0 ? 'inline-block' : 'none';
    }
  }

  return {
    init() { renderNotifList(); },

    add(type, title, desc) {
      const icons = { success: 'fa-check-circle', info: 'fa-circle-info', warning: 'fa-triangle-exclamation', error: 'fa-circle-xmark' };
      notifications.unshift({
        id: nextId++,
        type, title, desc,
        icon: icons[type] || 'fa-circle-info',
        time: 'Just now',
        unread: true,
      });
      if (notifications.length > 20) notifications.pop();
      renderNotifList();
    },

    clear() {
      notifications = [];
      renderNotifList();
    },

    markAllRead() {
      notifications.forEach(n => n.unread = false);
      renderNotifList();
    },
  };
})();

/* ============================================================
   TOAST SYSTEM
   ============================================================ */
const Toast = (() => {
  const ICONS = {
    success: 'fa-circle-check',
    info:    'fa-circle-info',
    warning: 'fa-triangle-exclamation',
    error:   'fa-circle-xmark',
  };

  let queue = 0;

  return {
    show(type = 'info', title, message, duration = 4500) {
      const container = document.getElementById('toastContainer');
      if (!container) return;

      // Limit to 4 toasts
      if (queue >= 4) return;
      queue++;

      const id    = 'toast-' + Date.now();
      const toast = document.createElement('div');
      toast.className = `toast ${type}`;
      toast.id = id;

      toast.innerHTML = `
        <i class="fa-solid ${ICONS[type]} toast-icon"></i>
        <div class="toast-body">
          <div class="toast-title">${title}</div>
          ${message ? `<div class="toast-message">${message}</div>` : ''}
        </div>
        <button class="toast-close" onclick="window.Toast_dismiss('${id}')">
          <i class="fa-solid fa-xmark"></i>
        </button>
        <div class="toast-progress" id="prog-${id}" style="width:100%;"></div>
      `;

      container.appendChild(toast);

      // Progress bar animation
      const prog = document.getElementById(`prog-${id}`);
      if (prog) {
        prog.style.transition = `width ${duration}ms linear`;
        requestAnimationFrame(() => { prog.style.width = '0%'; });
      }

      setTimeout(() => this.dismiss(id), duration);
    },

    dismiss(id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.add('removing');
      el.addEventListener('animationend', () => { el.remove(); queue = Math.max(0, queue - 1); }, { once: true });
    },
  };
})();

window.Toast_dismiss = (id) => Toast.dismiss(id);

/* ============================================================
   UI UPDATER — Updates DOM from live sensor state
   ============================================================ */
const UIUpdater = {
  update(data) {
    const fmt1 = v => isNaN(v) ? '—' : v;

    // Dashboard stats
    this.setText('statMoisture', `${Math.round(data.moisture)}%`);
    this.setText('statPumpStatus', data.pumpActive ? 'ON' : 'OFF');
    this.setText('statActiveIrrigation', data.pumpActive ? 'ON' : 'OFF');

    // Irrigation page readings
    this.setText('irrMoisture', `${Math.round(data.moisture)}%`);
    this.setText('irrFlowRate', `${fmt1(data.flowRate.toFixed(1))} L/min`);
    this.setText('irrWaterDel', `${fmt1(data.waterDel.toFixed(1))} L`);

    // Sensors page
    this.setText('moistureVal', Math.round(data.moisture));
    this.setText('flowVal', data.flowRate.toFixed(1));
    this.setText('waterDelVal', Math.round(data.waterDel));
    this.setText('tempVal', Math.round(data.temperature));
    this.setText('humidityVal', Math.round(data.humidity));
    this.toggleMoistureWarning(data.moisture < 30);

    // Table
    this.setText('tblMoisture', `${Math.round(data.moisture)}%`);
    this.setText('tblFlow', `${data.flowRate.toFixed(1)} L/min`);
    this.setText('tblTemp', `${Math.round(data.temperature)}°C`);
    this.setText('tblHumidity', `${Math.round(data.humidity)}%`);
    this.setText('tblPump', data.pumpActive ? 'Running' : 'Idle');

    // Circular progress rings
    this.setCircleProgress('moistureCircle', data.moisture, 100);
    this.setCircleProgress('flowCircle', data.flowRate, 5);
    this.setCircleProgress('waterDelCircle', Math.min(data.waterDel, 200), 200);
    this.setCircleProgress('tempCircle', data.temperature, 50);
    this.setCircleProgress('humidityCircle', data.humidity, 100);

    // Device info
    this.setText('deviceUptime', this.formatUptime(data.uptime));
    this.setText('rssiVal', `${Math.round(data.rssi)} dBm`);
    this.setText('freeHeap', `${data.freeHeap} KB`);

    // Pump state UI
    this.updatePumpState(data.pumpActive);

    // Visualizer
    this.updateVisualizer(data);

    // Push live reading to dashboard chart
    Charts.pushMoistureReading(+data.moisture.toFixed(1));
  },

  setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  },

  setCircleProgress(id, value, max) {
    const el = document.getElementById(id);
    if (!el) return;
    const circumference = 314; // 2π × 50
    const pct    = Math.min(1, Math.max(0, value / max));
    const offset = circumference * (1 - pct);
    el.style.strokeDashoffset = offset;
  },

  toggleMoistureWarning(show) {
    const el = document.getElementById('moistureLowWarning');
    if (!el) return;
    el.hidden = !show;
  },

  updatePumpState(active) {
    // Visualizer pump
    const pump = document.getElementById('vizPump');
    if (pump) pump.classList.toggle('active', active);

    // Pipes
    ['pipeH1','pipeH2'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('active', active);
    });

    // Drip container
    const drips = document.getElementById('dripContainer');
    if (drips) drips.style.opacity = active ? '1' : '0';

    // Viz status
    const vizStatus = document.getElementById('vizStatus');
    const vizTxt    = document.getElementById('vizStatusText');
    const vizLed    = document.getElementById('vizLed');
    if (vizStatus && vizTxt && vizLed) {
      vizStatus.className = 'status-indicator ' + (active ? 'online' : 'online');
      vizTxt.textContent  = active ? 'Irrigating...' : 'Standby';
      vizLed.className    = 'led ' + (active ? 'green' : 'green');
    }

    // Pump sensor status
    const pumpStatus = document.getElementById('pumpSensorStatus');
    const pumpTxt    = document.getElementById('pumpSensorTxt');
    const pumpLed    = document.getElementById('pumpLed');
    const pumpEmoji  = document.getElementById('pumpEmoji');
    const pumpBadge  = document.getElementById('pumpBadge');
    if (pumpStatus && pumpTxt && pumpLed) {
      pumpStatus.className = 'status-indicator ' + (active ? 'online' : 'offline');
      pumpTxt.textContent  = active ? 'Running' : 'Idle';
      pumpLed.className    = 'led ' + (active ? 'green' : 'red');
    }
    if (pumpEmoji) pumpEmoji.textContent = active ? '💧' : '⚙️';
    if (pumpBadge) {
      pumpBadge.textContent  = active ? 'Running' : 'Standby';
      pumpBadge.className    = 'log-badge ' + (active ? 'success' : 'info');
    }

    // Pump state in irrigation page
    const irrPump = document.getElementById('irrPumpState');
    if (irrPump) {
      irrPump.innerHTML = active
        ? '<span class="status-indicator online"><span class="led green"></span>ON</span>'
        : '<span class="status-indicator offline"><span class="led red"></span>OFF</span>';
    }

    // Stat card
    const statPump = document.getElementById('statPumpStatus');
    if (statPump) statPump.textContent = active ? 'ON' : 'OFF';
    const pumpTrend = document.getElementById('pumpTrend');
    if (pumpTrend) {
      pumpTrend.className   = 'stat-trend ' + (active ? 'up' : 'up');
      pumpTrend.innerHTML   = `<i class="fa-solid fa-circle"></i> ${active ? 'Running' : 'Ready'}`;
    }

    // Irrigation stat
    const irrigTrend = document.getElementById('irrigationTrend');
    if (irrigTrend) {
      irrigTrend.className = 'stat-trend ' + (active ? 'up' : 'down');
      irrigTrend.innerHTML = `<i class="fa-solid fa-circle"></i> ${active ? 'Active' : 'Standby'}`;
    }
  },

  updateVisualizer(data) {
    // Tank water level
    const tankWater = document.getElementById('tankWater');
    if (tankWater) tankWater.style.height = `${data.tankLevel}%`;
    this.setText('tankLevelText', `${Math.round(data.tankLevel)}%`);

    // Soil moisture visual
    const soilOverlay = document.getElementById('soilMoistureOverlay');
    if (soilOverlay) soilOverlay.style.width = `${data.moisture}%`;
    const soilBar = document.getElementById('soilBar');
    if (soilBar) soilBar.classList.toggle('wet', data.moisture > 55);

    // Plant icon
    const plantIcon = document.getElementById('plantIcon');
    if (plantIcon) {
      if (data.moisture > 70)      plantIcon.textContent = '🌿';
      else if (data.moisture > 45) plantIcon.textContent = '🌱';
      else                         plantIcon.textContent = '🥀';
    }

    // Device viz wrapper class
    const viz = document.getElementById('deviceViz');
    if (viz) viz.className = 'device-viz' + (data.pumpActive ? ' irrigation-active' : '');
  },

  formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  },
};

/* ============================================================
   SUPABASE LIVE DASHBOARD
   ============================================================ */
const SupabaseDashboard = (() => {
  let sensorChannel = null;
  let controlChannel = null;
  let latestSensorRow = null;
  let latestControlRow = null;
  let freshnessTimer = null;
  let isUpdatingControl = false;

  function isTrue(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
  }

  function safeNumber(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function setHidden(id, hidden) {
    const el = document.getElementById(id);
    if (el) el.hidden = hidden;
  }

  function showControlError(message) {
    const el = document.getElementById('supabaseControlError');
    if (!el) return;
    if (!message) {
      el.textContent = '';
      el.hidden = true;
      return;
    }

    el.textContent = `Error: ${message}`;
    el.hidden = false;
  }

  function showMoistureError(message) {
    const el = document.getElementById('supabaseMoistureError');
    if (!el) return;
    if (!message) {
      el.textContent = '';
      el.hidden = true;
      return;
    }

    el.textContent = `Error: ${message}`;
    el.hidden = false;
  }

  function formatTimestamp(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '--';
    return date.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function updateFreshnessBadge() {
    const badge = document.getElementById('supabaseFreshnessBadge');
    if (!badge || !latestSensorRow?.created_at) return;

    const createdAt = new Date(latestSensorRow.created_at);
    if (Number.isNaN(createdAt.getTime())) return;

    const ageMs = Date.now() - createdAt.getTime();
    const stale = ageMs > 20000;

    badge.textContent = stale ? 'Stale' : 'Live';
    badge.className = `log-badge ${stale ? 'warning' : 'success'}`;
  }

  function updateManualRelayButton() {
    const btn = document.getElementById('startIrrigationBtn');
    if (!btn) return;

    const manualRelay = isTrue(latestControlRow?.manual_relay);
    const cutoffActive = isTrue(latestSensorRow?.cutoff_active);
    const isStartState = !manualRelay;

    btn.disabled = cutoffActive || isUpdatingControl;
    btn.setAttribute('aria-disabled', btn.disabled ? 'true' : 'false');
    btn.classList.remove('btn-primary', 'btn-danger');
    btn.classList.add(isStartState ? 'btn-primary' : 'btn-danger');
    btn.innerHTML = isStartState
      ? '<i class="fa-solid fa-play"></i> Start Watering'
      : '<i class="fa-solid fa-stop"></i> Stop Watering';
  }

  function bindControlButton() {
    const btn = document.getElementById('startIrrigationBtn');
    if (!btn || btn.dataset.supabaseBound === '1') return;

    btn.dataset.supabaseBound = '1';
    btn.addEventListener('click', async () => {
      const newValue = !isTrue(latestControlRow?.manual_relay);
      console.log('Button clicked, new value:', newValue);
      await setManualRelay(newValue);
    });
  }

  function renderControlState() {
    const manualRelay = isTrue(latestControlRow?.manual_relay);
    const cutoffActive = isTrue(latestSensorRow?.cutoff_active);

    updateManualRelayButton();

    setHidden('supabaseCutoffBanner', !cutoffActive);
  }

  function renderSensorState(row) {
    if (!row) return;

    showMoistureError('');
    latestSensorRow = row;
    const moisture = Math.max(0, Math.min(100, safeNumber(row.soil_moisture)));
    const relayActive = isTrue(row.relay_state);
    const cutoffActive = isTrue(row.cutoff_active);
    const createdAt = row.created_at ? new Date(row.created_at) : new Date();
    const stale = !Number.isNaN(createdAt.getTime()) && (Date.now() - createdAt.getTime()) > 20000;

    setText('statMoisture', `${Math.round(moisture)}%`);
    setText('moistureVal', `${Math.round(moisture)}`);
    setText('tblMoisture', `${Math.round(moisture)}%`);
    setText('supabaseSoilText', `${Math.round(moisture)}%`);
    setText('supabaseLastUpdated', formatTimestamp(createdAt));

    const fill = document.getElementById('supabaseSoilFill');
    if (fill) fill.style.width = `${moisture}%`;

    setHidden('supabaseLowBadge', moisture >= 30);
    setHidden('moistureLowWarning', moisture >= 30);
    setHidden('supabaseCutoffBanner', !cutoffActive);

    const relayBadge = document.getElementById('supabaseRelayBadge');
    if (relayBadge) {
      relayBadge.className = `status-indicator ${relayActive ? 'online' : 'offline'}`;
      relayBadge.innerHTML = relayActive
        ? '<span class="led green"></span><span>Pump ON</span>'
        : '<span class="led red"></span><span>Pump OFF</span>';
    }

    const lowBadge = document.getElementById('supabaseLowBadge');
    if (lowBadge) {
      lowBadge.textContent = '⚠️ Water level is low';
      lowBadge.className = 'log-badge warning';
    }

    const cutoffBanner = document.getElementById('supabaseCutoffBanner');
    if (cutoffBanner) {
      cutoffBanner.innerHTML = '<span class="sensor-warning-icon">🔒</span><span>Soil fully saturated — pump locked off</span>';
    }

    const lowWarning = document.getElementById('moistureLowWarning');
    if (lowWarning) {
      lowWarning.hidden = moisture >= 30;
    }

    updateFreshnessBadge();
    renderControlState();

    // Keep the rest of the dashboard pump visuals aligned with the live relay state.
    UIUpdater.updatePumpState(relayActive);
  }

  function clearChannels() {
    if (sensorChannel) {
      supabaseClient.removeChannel(sensorChannel);
      sensorChannel = null;
    }
    if (controlChannel) {
      supabaseClient.removeChannel(controlChannel);
      controlChannel = null;
    }
  }

  async function fetchLatestSensorRow() {
    const { data, error } = await supabaseClient
      .from('sensor_readings')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1);

    console.log('Fetched sensor data:', data, error);

    if (error) throw error;
    return data?.[0] || null;
  }

  async function fetchControlRow() {
    const { data, error } = await supabaseClient
      .from('device_control')
      .select('id, manual_relay')
      .eq('id', 1)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  }

  async function refresh() {
    if (!SUPABASE_CONFIG_READY) {
      console.warn('[SupabaseDashboard] Add your Supabase URL and anon key to enable live data.');
      return false;
    }

    try {
      const [sensorRow, controlRow] = await Promise.all([
        fetchLatestSensorRow(),
        fetchControlRow(),
      ]);

      latestSensorRow = sensorRow;
      latestControlRow = controlRow;

      if (sensorRow) renderSensorState(sensorRow);
      else updateFreshnessBadge();

      if (controlRow) renderControlState();
      updateManualRelayButton();
      return true;
    } catch (error) {
      console.error('[SupabaseDashboard] Refresh failed:', error);
      showMoistureError(error?.message || String(error));
      Toast.show('error', 'Supabase Sync Failed', 'Check your URL, key, and table permissions.');
      return false;
    }
  }

  function subscribe() {
    if (!SUPABASE_CONFIG_READY) return;

    clearChannels();

    sensorChannel = supabaseClient
      .channel('aquaroot-sensor-readings')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'sensor_readings' },
        payload => {
          latestSensorRow = payload.new;
          renderSensorState(payload.new);
        },
      )
      .subscribe();

    controlChannel = supabaseClient
      .channel('aquaroot-device-control')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'device_control', filter: 'id=eq.1' },
        payload => {
          latestControlRow = payload.new;
          renderControlState();
        },
      )
      .subscribe();
  }

  function startFreshnessTimer() {
    if (freshnessTimer) clearInterval(freshnessTimer);
    freshnessTimer = setInterval(updateFreshnessBadge, 1000);
  }

  async function setManualRelay(nextValue) {
    if (!SUPABASE_CONFIG_READY) {
      Toast.show('warning', 'Supabase Not Configured', 'Paste your project URL and anon key first.');
      showControlError('Supabase is not configured yet.');
      return;
    }

    if (isTrue(latestSensorRow?.cutoff_active)) {
      Toast.show('warning', 'Pump Locked Off', 'Soil is fully saturated right now.');
      showControlError('Soil is fully saturated. Pump is locked off.');
      return;
    }

    if (isUpdatingControl) return;

    showControlError('');
    isUpdatingControl = true;
    updateManualRelayButton();

    try {
      const { data, error } = await supabaseClient
        .from('device_control')
        .update({ manual_relay: nextValue })
        .eq('id', 1);

      console.log('Supabase update result:', data, error);

      if (error) throw error;

      latestControlRow = { ...(latestControlRow || { id: 1 }), manual_relay: nextValue };
      renderControlState();
      Toast.show(
        'success',
        nextValue ? '💧 Watering Started' : '⏹️ Watering Stopped',
        nextValue ? 'Manual relay has been enabled.' : 'Manual relay has been disabled.',
      );
    } catch (error) {
      console.error('[SupabaseDashboard] Manual relay update failed:', error);
      showControlError(error?.message || String(error));
      Toast.show('error', 'Relay Update Failed', 'Could not update device_control.');
      await refresh();
    } finally {
      isUpdatingControl = false;
      updateManualRelayButton();
    }
  }

  return {
    init() {
      startFreshnessTimer();
      bindControlButton();
      refresh();
      subscribe();
    },
    refresh,
    setManualRelay,
    toggleManualRelay() {
      setManualRelay(!isTrue(latestControlRow?.manual_relay));
    },
    startWatering() {
      setManualRelay(true);
    },
    stopWatering() {
      setManualRelay(false);
    },
  };
})();

/* ============================================================
   SCHEDULE RENDERER
   ============================================================ */
function renderSchedule(result, gridId, bannersId, etcId, waterReqId, durId) {
  // Show result card
  const card = document.getElementById(gridId.replace('Grid','ResultCard').replace('schedPageGrid','schedPageResultCard'));
  if (card) card.classList.add('visible');

  // Stats
  document.getElementById(etcId).innerHTML    = `${result.etc}<span style="font-size:14px;font-weight:500;"> mm/day</span>`;
  document.getElementById(waterReqId).innerHTML = `${Math.round(result.totalLitresPerDay)}<span style="font-size:14px;font-weight:500;"> L</span>`;
  document.getElementById(durId).innerHTML     = `${result.durationMin}<span style="font-size:14px;font-weight:500;"> min</span>`;

  // Banners
  const banners = document.getElementById(bannersId);
  if (banners) {
    const recs = [];
    if (result.weather === 'rainy')
      recs.push({ type: 'info', icon: '🌧️', title: 'Rain Detected', msg: 'All 7 days marked as skip — natural rainfall is sufficient.' });
    if (result.soil === 'clay' || result.soil === 'black')
      recs.push({ type: 'success', icon: '💡', title: 'Smart Retention', msg: 'Clay/Black soil retains water well. Irrigation frequency reduced automatically.' });
    if (result.etc > 7)
      recs.push({ type: 'warning', icon: '⚠️', title: 'High Water Demand', msg: `${result.cropData.name} has high ETc (${result.etc} mm/day). Ensure adequate water supply.` });
    recs.push({ type: 'success', icon: '🌿', title: `${result.cropData.emoji} ${result.cropData.name} Schedule Generated`, msg: `Kc = ${result.cropData.kc}, ET₀ = ${result.cropData.eto} mm/day. Farm: ${result.farmAcres} acres.` });

    banners.innerHTML = recs.map(r => `
      <div class="recommendation-banner ${r.type}">
        <span class="banner-icon">${r.icon}</span>
        <div class="banner-text"><strong>${r.title}</strong>${r.msg}</div>
      </div>
    `).join('');
  }

  // Day cards
  const grid = document.getElementById(gridId);
  if (grid) {
    grid.innerHTML = result.schedule.map((day, i) => `
      <div class="schedule-day-card ${day.irrigate ? 'irrigate' : 'skip'}" style="animation-delay:${i * 60}ms;">
        <div class="sched-day">${day.day}</div>
        <div class="sched-date">${day.date}</div>
        <span class="sched-icon">${day.emoji}</span>
        <div class="sched-action">${day.irrigate ? 'Irrigate' : 'Skip'}</div>
        <div class="sched-volume">${day.irrigate ? `${day.volume}L · ${day.duration}min` : (day.reason || 'No irrigation')}</div>
      </div>
    `).join('');
  }
}

/* ============================================================
   LOGS TABLE RENDERER
   ============================================================ */
function renderLogsTable(logs) {
  const tbody = document.getElementById('logsTableBody');
  if (!tbody) return;
  tbody.innerHTML = logs.map(log => {
    const ts = log.timestamp instanceof Date ? log.timestamp : new Date(log.timestamp);
    const timeStr = ts.toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
    return `
      <tr>
        <td style="color:var(--text-muted); font-size:12px;">${timeStr}</td>
        <td style="font-weight:600;">${log.event}</td>
        <td><span class="log-badge ${log.type}">${log.type.toUpperCase()}</span></td>
        <td>${log.dur}</td>
        <td>${log.vol}</td>
        <td style="color:var(--text-muted);">${log.trigger}</td>
      </tr>`;
  }).join('');
}

/* ============================================================
   MAIN APP CONTROLLER
   ============================================================ */
const AquaRoot = (() => {
  let pollingInterval = null;
  let uptimeInterval  = null;
  let waterSavedCount = 8420;
  let isDark = false;

  // Water saved counter animation
  function animateCounter(id, target, duration = 1200) {
    const el = document.getElementById(id);
    if (!el) return;
    const start     = parseInt(el.textContent.replace(/[^0-9]/g,'')) || 0;
    const startTime = performance.now();
    const diff      = target - start;
    function step(now) {
      const t = Math.min(1, (now - startTime) / duration);
      const ease = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(start + diff * ease).toLocaleString();
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function startPolling() {
    if (pollingInterval) clearInterval(pollingInterval);
    pollingInterval = setInterval(async () => {
      try {
        const res = await ESP32Api.getStatus();
        if (res.ok) UIUpdater.update(res.data);
      } catch (e) {
        console.warn('[AquaRoot] Polling error:', e);
      }
    }, 3000);
  }

  async function initialLoad() {
    // Animate water saved counter
    animateCounter('statWaterSaved', waterSavedCount, 1500);

    // Load logs
    const logsRes = await ESP32Api.getLogs();
    if (logsRes.ok) renderLogsTable(logsRes.data);

    // Increment water saved every 30s
    setInterval(() => {
      waterSavedCount += Math.floor(Math.random() * 3 + 1);
      animateCounter('statWaterSaved', waterSavedCount, 600);
    }, 30000);
  }

  return {
    init() {
      this.initSidebar();
      this.initTheme();
      Notifications.init();
      Charts.initAll();
      SupabaseDashboard.init();
      initialLoad();
      this.bindNotifBtn();
      console.log('%c🌱 AquaRoot Dashboard Ready', 'color:#10b981; font-size:14px; font-weight:700;');
    },

    /* ---- Sidebar ---- */
    initSidebar() {
      const sidebar = document.getElementById('sidebar');
      const toggle  = document.getElementById('sidebarToggle');
      const mobile  = document.getElementById('mobileMenuBtn');
      const mobileIcon = document.getElementById('mobileMenuIcon');
      const overlay = document.getElementById('sidebarOverlay');
      const setMobileSidebarState = isOpen => {
        sidebar.classList.toggle('mobile-open', isOpen);
        overlay.classList.toggle('visible', isOpen);
        document.body.classList.toggle('sidebar-open-mobile', isOpen);
        mobile?.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        mobile?.setAttribute('aria-label', isOpen ? 'Close navigation menu' : 'Open navigation menu');
        if (mobileIcon) {
          mobileIcon.className = isOpen ? 'fa-solid fa-xmark' : 'fa-solid fa-bars';
        }
      };

      if (toggle) {
        toggle.addEventListener('click', () => {
          sidebar.classList.toggle('collapsed');
        });
      }

      if (mobile) {
        mobile.addEventListener('click', () => {
          setMobileSidebarState(!sidebar.classList.contains('mobile-open'));
        });
      }

      if (overlay) {
        overlay.addEventListener('click', () => {
          setMobileSidebarState(false);
        });
      }

      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          setMobileSidebarState(false);
        }
      });

      window.addEventListener('resize', () => {
        if (window.innerWidth > 768) {
          setMobileSidebarState(false);
        }
      });

      // Nav items
      document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
          const section = item.dataset.section;
          if (!section) return;
          this.navigateTo(section, item.querySelector('.nav-label')?.textContent || section);

          // Close mobile sidebar
          setMobileSidebarState(false);
        });

        // Keyboard accessibility
        item.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            item.click();
          }
        });
      });

      document.querySelectorAll('.mobile-section-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          const section = tab.dataset.section;
          if (!section) return;
          this.navigateTo(section, tab.textContent?.trim() || section);
        });
      });
    },

    navigateTo(section, label) {
      // Update active nav
      document.querySelectorAll('.nav-item').forEach(n => {
        n.classList.toggle('active', n.dataset.section === section);
        n.setAttribute('aria-current', n.dataset.section === section ? 'page' : 'false');
      });

      document.querySelectorAll('.mobile-section-tab').forEach(tab => {
        const isActive = tab.dataset.section === section;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-current', isActive ? 'page' : 'false');
        if (isActive) {
          tab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }
      });

      // Show section
      document.querySelectorAll('.page-section').forEach(s => {
        s.classList.toggle('active', s.id === `section-${section}`);
      });

      // Update page title
      document.getElementById('pageTitle').textContent = label;
      document.getElementById('pageBreadcrumb').textContent = label;

      // Re-init charts if analytics opened
      if (section === 'analytics') {
        setTimeout(() => Charts.initAll(), 100);
      }
    },

    /* ---- Theme ---- */
    initTheme() {
      const saved = localStorage.getItem('aqr-theme') || 'light';
      isDark = saved === 'dark';
      this.applyTheme(isDark, false);

      document.getElementById('themeToggle')?.addEventListener('click', () => {
        isDark = !isDark;
        this.applyTheme(isDark, true);
        localStorage.setItem('aqr-theme', isDark ? 'dark' : 'light');
      });

      document.getElementById('themeToggle')?.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('themeToggle').click(); }
      });
    },

    applyTheme(dark, animate = true) {
      const root  = document.documentElement;
      const track = document.getElementById('toggleTrack');
      const icon  = document.getElementById('themeIcon');
      const settingsToggle = document.getElementById('settingsDarkMode');

      root.setAttribute('data-theme', dark ? 'dark' : 'light');
      if (track) track.classList.toggle('on', dark);
      if (icon)  { icon.className = dark ? 'fa-solid fa-moon' : 'fa-solid fa-sun'; }
      if (settingsToggle) settingsToggle.checked = dark;

      if (animate) {
        Charts.updateTheme();
        Toast.show(dark ? 'info' : 'success',
          dark ? '🌙 Dark Mode Enabled' : '☀️ Light Mode Enabled',
          'Theme preference saved.');
      }
    },

    toggleThemeFromSettings(checkbox) {
      isDark = checkbox.checked;
      this.applyTheme(isDark, true);
      localStorage.setItem('aqr-theme', isDark ? 'dark' : 'light');
    },

    toggleCompactSidebar(checkbox) {
      const sidebar = document.getElementById('sidebar');
      if (sidebar) sidebar.classList.toggle('collapsed', checkbox.checked);
    },

    /* ---- Notification Button ---- */
    bindNotifBtn() {
      document.getElementById('notifBtn')?.addEventListener('click', () => {
        this.navigateTo('logs', 'Water Logs');
        Notifications.markAllRead();
      });
    },

    /* ---- Supabase Relay Actions ---- */
    async startIrrigation() {
      await SupabaseDashboard.setManualRelay(true);
    },

    async stopIrrigation() {
      await SupabaseDashboard.setManualRelay(false);
    },

    async fetchStatus() {
      const btn = document.getElementById('refreshStatusBtn');
      if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
      try {
        const ok = await SupabaseDashboard.refresh();
        if (ok) {
          Toast.show('success', '✅ Status Refreshed', 'Live Supabase readings updated.');
        }
      } catch (e) {
        Toast.show('error', 'Refresh Failed', 'Unable to reach Supabase.');
      }
      if (btn) btn.innerHTML = '<i class="fa-solid fa-rotate"></i> Refresh';
    },

    toggleManualRelay() {
      SupabaseDashboard.toggleManualRelay();
    },

    /* ---- FAO-56 Schedule Generation ---- */
    generateSchedule() {
      const crop    = document.getElementById('cropType')?.value     || 'maize';
      const soil    = document.getElementById('soilType')?.value     || 'loamy';
      const weather = document.getElementById('weatherCond')?.value  || 'sunny';
      const acres   = parseFloat(document.getElementById('farmSize')?.value) || 2;
      const manual  = parseFloat(document.getElementById('manualOverride')?.value) || null;

      const btn = document.getElementById('generateScheduleBtn');
      if (btn) { btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Calculating…'; btn.disabled = true; }

      setTimeout(() => {
        const result = FAO56.calculate(crop, soil, weather, acres, manual);
        const card   = document.getElementById('scheduleResultCard');
        if (card) card.style.display = 'none';

        renderSchedule(result, 'scheduleGrid', 'recommendationBanners', 'schedEtc', 'schedWaterReq', 'schedDuration');

        if (card) { card.style.display = 'block'; card.classList.add('visible'); }

        if (btn) { btn.innerHTML = '<i class="fa-solid fa-calendar-check"></i> Generate Schedule'; btn.disabled = false; }

        Toast.show('success', '📅 Schedule Generated', `${result.cropData.emoji} ${result.cropData.name} — ETc: ${result.etc} mm/day · ${Math.round(result.totalLitresPerDay)}L/day needed.`);
        Notifications.add('info', 'Schedule Generated', `FAO-56 plan for ${result.cropData.name}: ${Math.round(result.totalLitresPerDay)}L/day.`);
      }, 600);
    },

    generateSchedulerSchedule() {
      const crop    = document.getElementById('schedCropType')?.value  || 'maize';
      const soil    = document.getElementById('schedSoilType')?.value  || 'loamy';
      const weather = document.getElementById('schedWeather')?.value   || 'sunny';
      const acres   = parseFloat(document.getElementById('schedFarmSize')?.value) || 2;

      const result = FAO56.calculate(crop, soil, weather, acres);
      const card   = document.getElementById('schedPageResultCard');
      if (card) card.style.display = 'none';

      renderSchedule(result, 'schedPageGrid', 'schedPageBanners', 'schedPageEtc', 'schedPageWater', 'schedPageDur');

      if (card) { card.style.display = 'block'; card.classList.add('visible'); }

      Toast.show('success', '📅 Crop Schedule Ready', `${result.cropData.emoji} ${result.cropData.name} plan generated for ${acres} acres.`);
    },

    /* ---- Logs ---- */
    clearNotifications() {
      Notifications.clear();
      Toast.show('info', 'Notifications Cleared', 'All system notifications have been dismissed.');
    },

    async refreshLogs() {
      const res = await ESP32Api.getLogs();
      if (res.ok) {
        renderLogsTable(res.data);
        Toast.show('success', 'Logs Refreshed', 'Activity log updated from device.');
      }
    },

    exportLogs() {
      Toast.show('info', '📥 Export Started', 'Logs exported as CSV — check your downloads folder.');
    },

    /* ---- Settings ---- */
    saveWifi() {
      const ssid = document.getElementById('wifiSsidInput')?.value;
      const ip   = document.getElementById('deviceIpInput')?.value;
      if (ssid) document.getElementById('wifiSsid').textContent = ssid;
      if (ip)   document.getElementById('deviceIp').textContent  = ip;
      Toast.show('success', '✅ WiFi Saved', `Connected to: ${ssid}. ESP32 IP: ${ip}`);
    },

    testTelegram() {
      Toast.show('info', '📨 Test Message Sent', 'Check your Telegram chat for the test notification from AquaRoot Bot.');
    },

    saveCalibration() {
      Toast.show('success', '⚙️ Calibration Saved', 'Sensor calibration values applied to ESP32.');
    },

    rebootDevice() {
      Toast.show('warning', '🔄 Rebooting ESP32', 'Device will reconnect in ~10 seconds.');
      Notifications.add('warning', 'Device Reboot', 'ESP32 is rebooting. Connection will restore shortly.');
    },

    factoryReset() {
      if (confirm('⚠️ This will erase all device settings. Are you sure?')) {
        Toast.show('error', '🗑️ Factory Reset', 'ESP32 has been reset to factory defaults.');
      }
    },
  };
})();

/* ============================================================
   HERO BUTTON HANDLERS
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  window.aqr = AquaRoot;
  AquaRoot.init();

  document.getElementById('heroConnectBtn')?.addEventListener('click', () => {
    AquaRoot.navigateTo('settings', 'Settings');
    Toast.show('info', '🔌 Configure WiFi', 'Enter your ESP32 IP address in the WiFi settings below.');
  });

  document.getElementById('heroOpenDashBtn')?.addEventListener('click', () => {
    AquaRoot.navigateTo('sensors', 'Sensors');
  });

  // Initial toast welcome
  setTimeout(() => {
    Toast.show('success', '🌱 AquaRoot Connected', 'Live telemetry is streaming from Supabase.');
  }, 800);

  setTimeout(() => {
    Toast.show('info', '💧 Auto-Monitoring Active', 'Sensor readings update in realtime via Supabase.');
  }, 2000);
});
