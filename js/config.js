/**
 * VanishText {Made by SUVX}
 * Active Configuration File
 *
 * Frontend relies strictly on public endpoints and client-side Web Crypto.
 * No secret administrative keys or credentials belong in this file.
 */

window.CHATSPACE_CONFIG = {
  appName: 'VanishText',
  authorBadge: 'Made by SUVX',
  tagline: 'Private conversations. Just two people. Text only.',

  // Transport mode: 'auto' will connect to trusted server coordination & WebRTC (with TURN relay support),
  // with fallback to PeerJS or BroadcastChannel for offline same-machine tab testing.
  transportMode: 'auto',

  // Trusted Signaling & Coordination Server
  signaling: {
    serverUrl: '', // Auto-detected from window.location (e.g. ws://localhost:8080/ws)
    turnApiUrl: '/api/turn-credentials',
    forceTurnRelay: false // Set to true to explicitly test TURN relay mode
  },

  // Multi-network WebRTC STUN & TURN Relay Configuration
  webrtc: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:openrelay.metered.ca:80' },
      // OpenRelay Public TURN Relay on ports 80 & 443 (UDP/TCP/TURNS)
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turns:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ],
    iceCandidatePoolSize: 10
  },

  peerjs: {
    host: '0.peerjs.com',
    port: 443,
    path: '/',
    secure: true,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:openrelay.metered.ca:80' },
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turns:openrelay.metered.ca:443?transport=tcp',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
      ],
      iceCandidatePoolSize: 10
    }
  },

  supabase: {
    url: '',
    anonKey: ''
  },

  room: {
    maxParticipants: 2,
    groupMaxParticipants: 10,
    roomTtlMinutes: 60,
    codeLength: 12,
    codeCharset: '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  },

  messaging: {
    maxMessageLength: 2000,
    rateLimitMax: 5,
    rateLimitWindowMs: 2000,
    allowedFormats: ['text'],
    messageTtlMinutes: 15
  },

  security: {
    privacyBlurDefault: true,
    preventShortcuts: true,
    sessionStorageBlocked: true
  }
};
