const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const mqtt    = require('mqtt');

const webPort = 80;

const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer);

app.use(express.static('public'));

// ── Socket.IO ──────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`🔌 Web client connected: \x1b[36m${socket.id}\x1b[0m`);

    // Send the last known device state immediately on connect
    if (lastPayload) socket.emit('sensor_data', lastPayload);
    socket.emit('device_status', deviceStatus);

    socket.on('disconnect', () => {
        console.log(`🔌 Web client disconnected: \x1b[31m${socket.id}\x1b[0m`);
    });
});

// ── MQTT config ────────────────────────────────────────────────
const BROKER_URL    = 'mqtt://64.227.162.243';
const DATA_TOPIC    = 'Manku/Factory/Machine1';
const STATUS_TOPIC  = 'Manku/Factory/Machine1/status';
const OFFLINE_MS    = 5000;   // 5 s without data → declare offline

// State
let lastPayload   = null;
let deviceStatus  = 'offline';
let offlineTimer  = null;

function markOffline() {
    if (deviceStatus !== 'offline') {
        deviceStatus = 'offline';
        console.log('\x1b[31m⚠  Device went OFFLINE (no data for 5 s)\x1b[0m');
        io.emit('device_status', 'offline');
    }
}

function resetOfflineTimer() {
    if (offlineTimer) clearTimeout(offlineTimer);
    offlineTimer = setTimeout(markOffline, OFFLINE_MS);
}

// ── MQTT ───────────────────────────────────────────────────────
const mqttClient = mqtt.connect(BROKER_URL, {
    clientId: 'mfps_server_' + Math.random().toString(16).slice(2, 8),
    clean: true,
    reconnectPeriod: 3000,
});

mqttClient.on('connect', () => {
    console.log(`✅ Server connected to MQTT broker at ${BROKER_URL}`);

    mqttClient.subscribe([DATA_TOPIC, STATUS_TOPIC], (err) => {
        if (!err) {
            console.log(`📡 Subscribed to:`);
            console.log(`   \x1b[36m${DATA_TOPIC}\x1b[0m  (sensor data)`);
            console.log(`   \x1b[36m${STATUS_TOPIC}\x1b[0m  (LWT online/offline)`);
        } else {
            console.error('❌ Subscription error:', err);
        }
    });
});

mqttClient.on('message', (topic, message) => {
    const raw = message.toString().trim();

    // ── Status topic (LWT) ──────────────────────────────────────
    if (topic === STATUS_TOPIC) {
        const status = raw.toLowerCase(); // 'online' or 'offline'
        deviceStatus = status;
        console.log(`\n📶 Device status: \x1b[33m${status}\x1b[0m`);
        io.emit('device_status', status);

        if (status === 'offline') {
            if (offlineTimer) clearTimeout(offlineTimer);
        }
        return;
    }

    // ── Data topic ──────────────────────────────────────────────
    if (topic === DATA_TOPIC) {
        console.log(`\n📬 Data on \x1b[32m${topic}\x1b[0m: ${raw}`);

        try {
            const data = JSON.parse(raw);

            // Validate expected fields exist
            const required = ['current', 'temperature', 'volt', 'vibration', 'machine_state', 'displacement'];
            const missing  = required.filter(k => !(k in data));
            if (missing.length) {
                console.warn('⚠  Missing fields:', missing);
            }

            // Firmware rule: current < 0.08 is forced to 0.00
            if (data.current !== undefined && data.current < 0.08) data.current = 0.00;

            // Firmware rule: machine_state derived from current
            data.machine_state = (data.current > 0.5) ? 'Running' : 'Machine Off';

            lastPayload  = data;
            deviceStatus = 'online';

            io.emit('sensor_data', data);
            io.emit('device_status', 'online');

            resetOfflineTimer();
        } catch (err) {
            console.warn('⚠  Non-JSON payload, ignored:', raw);
        }
    }
});

mqttClient.on('error', (err) => {
    console.error('[MQTT Error]', err.message);
});

mqttClient.on('reconnect', () => {
    console.log('🔄 Reconnecting to MQTT broker...');
});

// ── Start ──────────────────────────────────────────────────────
httpServer.listen(webPort, () => {
    console.log(`🌐 MFPS Dashboard → http://localhost:${webPort}`);
});
