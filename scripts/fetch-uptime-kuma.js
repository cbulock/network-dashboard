import "dotenv/config";
import { io } from 'socket.io-client';

const KUMA_URL = process.env.UK_URL;
const USERNAME = process.env.UK_USER;
const PASSWORD = process.env.UK_PASS;

const socket = io(KUMA_URL, {
  path: '/socket.io/',
  transports: ['websocket'],
  reconnection: false,
});

socket.onAny((event, ...args) => {
  console.log(`📡 Event: ${event}`, args);
});

socket.on('connect', () => {
  console.log('✅ Connected to Uptime Kuma WebSocket');

  socket.emit('login', {
    username: USERNAME,
    password: PASSWORD,
    token: null,            // explicitly needed
    type: 'login',
    rememberMe: false
  });
});

socket.on('login_success', () => {
  console.log('🔓 Login successful — requesting monitors...');
  socket.emit('getMonitorList');
});

socket.on('monitorList', (monitors) => {
  console.log(`📋 ${monitors.length} monitors received:`);
  for (const m of monitors) {
    console.log(`- ${m.name} [${m.type}] - Active: ${m.active}`);
  }
  socket.disconnect();
});

socket.on('login_error', (err) => {
  console.error('❌ Login failed:', err?.msg || err);
  socket.disconnect();
});
