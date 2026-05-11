'use strict';

const socket = io();

// ── UI references ────────────────────────────────────────────────────────────
const connStatus  = document.getElementById('conn-status');
const connDot     = document.getElementById('conn-dot');

const deviceCard   = document.getElementById('device-card');
const deviceIcon   = document.getElementById('device-icon-wrap');
const deviceStatus = document.getElementById('device-status');

const machineCard  = document.getElementById('machine-card');
const machineIcon  = document.getElementById('machine-icon-wrap');
const machineVal   = document.getElementById('machine-state-val');

const attachCard   = document.getElementById('attach-card');
const attachIcon   = document.getElementById('attach-icon-wrap');
const attachStatus = document.getElementById('attach-status');

const dispBanner    = document.getElementById('displacement-banner');
const offlineBanner = document.getElementById('offline-banner');
const alertList     = document.getElementById('alert-list');

// Sensor display elements — keys match ESP32 JSON field names exactly
const sensors = {
    current:     { val: document.getElementById('val-current'),     arc: document.getElementById('arc-current'),     max: 30   },
    temperature: { val: document.getElementById('val-temperature'), arc: document.getElementById('arc-temperature'), max: 120  },
    volt:        { val: document.getElementById('val-volt'),        arc: document.getElementById('arc-volt'),        max: 260  },
};

const vibIcon  = document.getElementById('vib-icon');
const vibLabel = document.getElementById('val-vibration');
const vibBars  = document.getElementById('vib-bars');

// ── Thresholds (per spec) ────────────────────────────────────────────────────
//   temperature > 50°C      → WARNING
//   current > 15A           → WARNING   (mid of 0-30A range)
//   vibration=Vibrating     → WARNING  (only when volt >= 0.1)
//   displacement=Displaced  → CRITICAL
//   offline / no data 5s   → CRITICAL
const T = {
    temp_warn:    50,
    current_warn: 15,
    volt_power:   0.1,   // below this → power is off, ignore vibration
};

// ── Alert history (max 5) ─────────────────────────────────────────────────────
const MAX_ALERTS = 5;
let alertHistory = [];

function pushAlert(severity, msg) {
    const now = new Date().toLocaleTimeString();
    alertHistory.unshift({ severity, msg, time: now });
    if (alertHistory.length > MAX_ALERTS) alertHistory.pop();
    renderAlerts();
}

function renderAlerts() {
    if (alertHistory.length === 0) {
        alertList.innerHTML = '<div class="alert-empty">No alerts yet</div>';
        return;
    }
    alertList.innerHTML = alertHistory.map(a => `
        <div class="alert-item ${a.severity}">
            <span class="alert-time">${a.time}</span>
            <span class="alert-msg">${a.msg}</span>
            <span class="alert-badge ${a.severity}">${a.severity}</span>
        </div>
    `).join('');
}

// Track last alert message to avoid duplicates
let lastAlertMsg = '';

// ── Socket.IO connection events ───────────────────────────────────────────────
socket.on('connect', () => {
    connStatus.textContent = 'Server Connected';
    connDot.classList.replace('disconnected', 'connected');
});

socket.on('disconnect', () => {
    connStatus.textContent = 'Server Connection Lost';
    connDot.classList.replace('connected', 'disconnected');
    setDeviceStatus('offline');
});

// ── Device online/offline from server ────────────────────────────────────────
socket.on('device_status', (status) => {
    setDeviceStatus(status);
});

function setDeviceStatus(status) {
    deviceCard.className = 'status-card';
    if (status === 'online') {
        deviceCard.classList.add('state-ok');
        deviceStatus.textContent = 'Online';
        deviceIcon.innerHTML = svgWifi();
        offlineBanner.classList.add('hidden');
    } else {
        deviceCard.classList.add('state-critical');
        deviceStatus.textContent = 'OFFLINE';
        deviceIcon.innerHTML = svgWifiOff();
        offlineBanner.classList.remove('hidden');

        const msg = 'Device offline — no data received';
        if (lastAlertMsg !== msg) {
            lastAlertMsg = msg;
            pushAlert('critical', msg);
        }
    }
}

// ── Incoming sensor data ──────────────────────────────────────────────────────
socket.on('sensor_data', (data) => {
    /*
     * ESP32 payload fields (all used here):
     *   current       float A
     *   temperature   float °C
     *   volt          float V
     *   vibration     "Normal" | "Vibrating"
     *   machine_state "Running" | "Machine Off"
     *   displacement  "Placed" | "Displaced"
     */

    // ── Numeric sensors ──────────────────────────────────────
    ['current', 'temperature', 'volt'].forEach(key => {
        const el = sensors[key];
        if (data[key] === undefined) return;
        const v = parseFloat(data[key]);
        animateNumber(el.val, v);
        // Ring gauge  (188.5 = 2π × 30)
        const pct = Math.min(v / el.max, 1);
        const dash = pct * 188.5;
        el.arc.style.strokeDasharray = `${dash} ${188.5 - dash}`;
        // Colour the arc
        el.arc.classList.remove('warn', 'danger');
        if (key === 'temperature' && v > T.temp_warn) el.arc.classList.add('warn');
        if (key === 'current'     && v > T.current_warn) el.arc.classList.add('warn');
    });

    // ── Vibration ────────────────────────────────────────────
    // Spec: ignore vibration status when volt < 0.1 (power is off)
    if (data.vibration !== undefined) {
        const powerOff  = (data.volt !== undefined && data.volt < T.volt_power);
        const vibrating = (data.vibration === 'Vibrating') && !powerOff;

        vibLabel.textContent = data.vibration;
        vibIcon.classList.toggle('active', vibrating);
        vibBars.classList.toggle('active', vibrating);
    }

    // ── Machine state ─────────────────────────────────────────
    if (data.machine_state !== undefined) {
        machineCard.className = 'status-card';
        if (data.machine_state === 'Running') {
            machineCard.classList.add('state-ok');
            machineVal.textContent = 'Running';
            machineIcon.innerHTML = svgRunning();
        } else {
            machineCard.classList.add('state-warn');
            machineVal.textContent = 'Machine Off';
            machineIcon.innerHTML = svgOff();
        }
    }

    // ── Displacement ──────────────────────────────────────────
    if (data.displacement !== undefined) {
        attachCard.className = 'status-card';
        if (data.displacement === 'Displaced') {
            attachCard.classList.add('state-critical');
            attachStatus.textContent = 'DISPLACED ⚠';
            attachIcon.innerHTML = svgDisplace();
            dispBanner.classList.remove('hidden');
        } else {
            attachCard.classList.add('state-ok');
            attachStatus.textContent = 'Securely Placed';
            attachIcon.innerHTML = svgPlace();
            dispBanner.classList.add('hidden');
        }
    }

    // ── Alert rule evaluation ─────────────────────────────────
    evaluateAlerts(data);
});

// ── Alert rules (per spec) ────────────────────────────────────────────────────
function evaluateAlerts(data) {
    const volt    = data.volt;
    const temp    = data.temperature;
    const current = data.current;
    const vib     = data.vibration;
    const disp    = data.displacement;
    const mState  = data.machine_state;

    // CRITICAL: Displacement
    if (disp === 'Displaced') {
        const msg = 'Machine displaced — relay has cut power';
        if (lastAlertMsg !== msg) { lastAlertMsg = msg; pushAlert('critical', msg); }
        return;
    }

    // WARNING: Vibration when machine is OFF (abnormal)
    const powerOff = volt !== undefined && volt < T.volt_power;
    if (vib === 'Vibrating' && !powerOff && mState === 'Machine Off') {
        const msg = 'Vibration detected while machine is off';
        if (lastAlertMsg !== msg) { lastAlertMsg = msg; pushAlert('warn', msg); }
    }

    // WARNING: Temperature
    if (temp !== undefined && temp > T.temp_warn) {
        const msg = `High temperature: ${temp.toFixed(1)} °C (threshold: >${T.temp_warn} °C)`;
        if (lastAlertMsg !== msg) { lastAlertMsg = msg; pushAlert('warn', msg); }
    }

    // WARNING: Current
    if (current !== undefined && current > T.current_warn) {
        const msg = `High current: ${current.toFixed(2)} A (threshold: >${T.current_warn} A)`;
        if (lastAlertMsg !== msg) { lastAlertMsg = msg; pushAlert('warn', msg); }
    }
}

// ── Number animation ──────────────────────────────────────────────────────────
function animateNumber(el, target) {
    const decimals = target < 10 ? 2 : 1;
    const current  = parseFloat(el.textContent) || 0;
    if (Math.abs(target - current) > 100) {
        el.textContent = target.toFixed(decimals);
        return;
    }
    let frame = 0;
    const steps = 18;
    const step  = (target - current) / steps;
    let val = current;
    const id = setInterval(() => {
        val += step;
        frame++;
        el.textContent = val.toFixed(decimals);
        if (frame >= steps) {
            el.textContent = target.toFixed(decimals);
            clearInterval(id);
        }
    }, 20);
}

// ── SVG helpers ───────────────────────────────────────────────────────────────
const stroke = `width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"`;

function svgWifi()    { return `<svg ${stroke}><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>`; }
function svgWifiOff() { return `<svg ${stroke}><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.56 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>`; }
function svgRunning() { return `<svg ${stroke}><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>`; }
function svgOff()     { return `<svg ${stroke}><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`; }
function svgPlace()   { return `<svg ${stroke}><polyline points="20 6 9 17 4 12"/></svg>`; }
function svgDisplace(){ return `<svg ${stroke}><path d="M5 12h14M12 5l7 7-7 7"/></svg>`; }
