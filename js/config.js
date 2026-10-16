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

  // Transport mode: 'auto' will use PeerJS (WebRTC P2P) if network and library are available,
  // allowing genuine communication between two different devices over the internet,
  // or seamless fallback to BroadcastChannel for local same-browser dual-tab testing.
  transportMode: 'auto',

  peerjs: {
    host: '0.peerjs.com',
    port: 443,
    path: '/',
    secure: true,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.services.mozilla.com' },
        { urls: 'stun:global.stun.twilio.com:3478' }
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
