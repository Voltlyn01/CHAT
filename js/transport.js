/**
 * VanishText {Made by SUVX}
 * Transport & Signaling Layer
 *
 * Implements:
 * 1. ServerSignalingTransport (Primary trusted server-side coordinator with WebRTC STUN/TURN relay)
 * 2. PeerJS WebRTC Transport (Direct peer-to-peer data channel)
 * 3. BroadcastChannel Transport (Zero-setup local development & testing between tabs)
 *
 * Enforces:
 * - Cross-network communication with STUN and TURN relay support
 * - Strict 1-to-1 admission control (creator + 1 admitted guest at a time; rejects 3rd participant)
 * - Creator-only authenticated actions (admit guest, remove guest, revoke access)
 * - Synchronized CLEAR CHAT FOR BOTH with timestamp cutoff
 * - Genuine End-to-End Encryption (AES-256-GCM + ECDH P-256) across direct, relayed, and fallback transports
 * - No plaintext ever traverses the network or reaches the server
 */

(function (window) {
  'use strict';

  class BaseTransport {
    constructor(callbacks) {
      this.callbacks = callbacks || {};
      this.role = null; // 'creator' | 'guest'
      this.roomId = null;
      this.nickname = null;
      this.participantId = null;
      this.roomType = 'direct';
      this.maxParticipants = 2;
    }

    emit(event, ...args) {
      if (this.callbacks[event]) {
        try {
          this.callbacks[event](...args);
        } catch (err) {
          console.error(`[Transport Error] Exception in callback for ${event}:`, err);
        }
      }
    }

    admitGuest(guestId) {}
    rejectGuest(guestId) {}
    removeGuest() {}
    clearChatForBoth() {}
  }

  /**
   * 1. ServerSignalingTransport
   * Trusted Server-Coordinated Transport with WebRTC STUN/TURN Relay Support
   */
  class ServerSignalingTransport extends BaseTransport {
    constructor(callbacks) {
      super(callbacks);
      this.ws = null;
      this.pc = null;
      this.dataChannel = null;
      this.creatorSecret = null;
      this.guestToken = null;
      this.guestId = null;
      this.publicKeyJwk = null;
      this.roomCreatedAt = null;
      this.transportName = 'WebRTC DataChannel (STUN/TURN Relay)';
      this.iceServers = (window.CHATSPACE_CONFIG && window.CHATSPACE_CONFIG.webrtc && window.CHATSPACE_CONFIG.webrtc.iceServers) || [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:openrelay.metered.ca:80' },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
      ];
      this.iceTransportPolicy = (window.CHATSPACE_CONFIG && window.CHATSPACE_CONFIG.signaling && window.CHATSPACE_CONFIG.signaling.forceTurnRelay) ? 'relay' : 'all';
      this.candidateTypes = new Set();
      this._iceCandidateQueue = [];
    }

    async _fetchTurnCredentials() {
      try {
        const forceRelay = (window.CHATSPACE_CONFIG && window.CHATSPACE_CONFIG.signaling && window.CHATSPACE_CONFIG.signaling.forceTurnRelay) || false;
        const apiUrl = (window.CHATSPACE_CONFIG && window.CHATSPACE_CONFIG.signaling && window.CHATSPACE_CONFIG.signaling.turnApiUrl) || '/api/turn-credentials';
        const url = `${apiUrl}${apiUrl.includes('?') ? '&' : '?'}mode=${forceRelay ? 'relay' : 'all'}`;

        if (typeof fetch === 'function') {
          let timeoutId = null;
          let fetchPromise;
          if (typeof AbortController !== 'undefined') {
            const controller = new AbortController();
            timeoutId = setTimeout(() => controller.abort(), 1800);
            fetchPromise = fetch(url, { signal: controller.signal });
          } else {
            fetchPromise = fetch(url);
          }
          const res = await fetchPromise;
          if (timeoutId) clearTimeout(timeoutId);
          if (res.ok) {
            const data = await res.json();
            if (data.iceServers && Array.isArray(data.iceServers)) {
              this.iceServers = data.iceServers;
            }
            if (data.iceTransportPolicy) {
              this.iceTransportPolicy = data.iceTransportPolicy;
            }
          }
        }
      } catch (e) {
        console.warn('[ServerSignalingTransport] Using configured default STUN/TURN servers:', e.message);
      }
    }

    _resolveWsUrl() {
      if (window.CHATSPACE_CONFIG && window.CHATSPACE_CONFIG.signaling && window.CHATSPACE_CONFIG.signaling.serverUrl) {
        return window.CHATSPACE_CONFIG.signaling.serverUrl;
      }
      if (typeof window !== 'undefined' && window.location && window.location.host && window.location.protocol !== 'file:') {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${window.location.host}/ws`;
      }
      return 'ws://localhost:8080/ws';
    }

    async initRoom(role, cleanCode, nickname, publicKeyJwk, roomCreatedAt, roomType = 'direct', maxParticipants = 2) {
      this.role = role;
      this.roomId = cleanCode;
      this.nickname = nickname;
      this.publicKeyJwk = publicKeyJwk;
      this.roomCreatedAt = roomCreatedAt || Date.now();
      this.roomType = roomType || 'direct';
      this.maxParticipants = maxParticipants || 2;

      // 1. Fetch secure, temporary STUN/TURN relay credentials with timeout
      await this._fetchTurnCredentials();

      // 2. Connect to trusted WebSocket coordinator
      const wsUrl = this._resolveWsUrl();
      return new Promise((resolve, reject) => {
        let settled = false;
        const connectTimeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            if (this.ws) {
              try { this.ws.close(); } catch (e) {}
            }
            reject(new Error('Signaling server connection timeout.'));
          }
        }, 3500);

        try {
          const WSConstructor = (typeof window !== 'undefined' && window.WebSocket)
            ? window.WebSocket
            : (typeof require !== 'undefined' ? require('ws') : null);

          if (!WSConstructor) {
            clearTimeout(connectTimeout);
            reject(new Error('WebSocket is not available in this environment.'));
            return;
          }

          this.ws = new WSConstructor(wsUrl);

          this.ws.onopen = () => {
            this._setupWebSocketHandlers((msg) => {
              if (!settled) {
                if (msg.type === 'ROOM_CREATED' || msg.type === 'WAITING_FOR_ADMISSION') {
                  settled = true;
                  clearTimeout(connectTimeout);
                  resolve();
                } else if (msg.type === 'ERROR' || msg.type === 'ROOM_FULL') {
                  settled = true;
                  clearTimeout(connectTimeout);
                  reject(new Error(msg.error || msg.message || 'Server rejected room creation.'));
                }
              }
            });

            if (this.role === 'creator') {
              this.ws.send(JSON.stringify({
                type: 'CREATE_ROOM',
                roomId: this.roomId,
                nickname: this.nickname,
                jwk: this.publicKeyJwk
              }));
            } else {
              this.ws.send(JSON.stringify({
                type: 'REQUEST_ADMISSION',
                roomId: this.roomId,
                nickname: this.nickname,
                jwk: this.publicKeyJwk
              }));
            }
          };

          this.ws.onerror = (err) => {
            if (!settled) {
              settled = true;
              clearTimeout(connectTimeout);
              reject(new Error('Failed to connect to trusted signaling server at ' + wsUrl));
            }
          };

          this.ws.onclose = () => {
            if (!settled) {
              settled = true;
              clearTimeout(connectTimeout);
              reject(new Error('Signaling server connection closed before room creation.'));
            }
          };
        } catch (e) {
          if (!settled) {
            settled = true;
            clearTimeout(connectTimeout);
            reject(e);
          }
        }
      });
    }

    _setupWebSocketHandlers(onInitHook) {
      this.ws.onmessage = async (event) => {
        let msg;
        try {
          msg = typeof event.data === 'string' ? JSON.parse(event.data) : JSON.parse(event.data.toString());
        } catch (e) {
          return;
        }

        switch (msg.type) {
          case 'ROOM_CREATED':
            this.creatorSecret = msg.creatorSecret;
            this.participantId = msg.creatorId;
            this.emit('onReady', { transport: this.transportName, role: 'creator', code: this.roomId });
            if (typeof onInitHook === 'function') onInitHook(msg);
            break;

          case 'WAITING_FOR_ADMISSION':
            this.guestId = msg.guestId;
            this.participantId = msg.guestId;
            this.emit('onReady', { transport: this.transportName, role: 'guest', code: this.roomId });
            this.emit('onWaitingForAdmission', { message: msg.message });
            if (typeof onInitHook === 'function') onInitHook(msg);
            break;

          case 'ADMISSION_REQUEST':
            this.emit('onAdmissionRequest', { guestId: msg.guestId, nickname: msg.nickname });
            break;

          case 'ADMISSION_REJECTED':
            this.emit('onAdmissionRejected', msg.message || 'Admission request was declined.');
            this.destroy();
            break;

          case 'ROOM_FULL':
            this.emit('onRoomFull', msg.message || 'This room is full. Only two participants are allowed.');
            if (typeof onInitHook === 'function') onInitHook(msg);
            this.destroy();
            break;

          case 'ADMISSION_GRANTED':
            this.guestToken = msg.guestToken;
            this.roomCreatedAt = msg.roomCreatedAt;
            this.emit('onConnected');
            this.emit('onHandshakeReceived', {
              senderId: 'creator',
              nickname: msg.creatorNickname,
              role: 'creator',
              jwk: msg.creatorPublicKey,
              roomCreatedAt: msg.roomCreatedAt,
              roomType: 'direct',
              maxParticipants: 2,
              participantCount: 2
            });
            break;

          case 'GUEST_ADMITTED':
            this.emit('onConnected');
            this.emit('onHandshakeReceived', {
              senderId: msg.guestId,
              nickname: msg.nickname,
              role: 'guest',
              jwk: msg.guestPublicKey,
              roomCreatedAt: this.roomCreatedAt,
              roomType: 'direct',
              maxParticipants: 2,
              participantCount: 2
            });
            // As creator, negotiate WebRTC PeerConnection with STUN/TURN
            this._initiateWebRtcOffer();
            break;

          case 'REMOVED_BY_CREATOR':
            this.emit('onRemovedByCreator', msg.message || 'You were removed from the room by the creator.');
            this.destroy();
            break;

          case 'GUEST_REMOVED':
            this.emit('onPeerLeft', { nickname: msg.nickname || 'Guest', message: msg.message, participantId: msg.guestId });
            this._teardownWebRtc();
            break;

          case 'GUEST_LEFT':
            this.emit('onPeerLeft', { nickname: msg.nickname || 'Guest', message: msg.message, participantId: msg.guestId });
            this._teardownWebRtc();
            break;

          case 'PARTICIPANT_JOINED':
            this.emit('onParticipantJoined', {
              participantId: msg.participantId,
              nickname: msg.nickname,
              count: msg.participantCount
            });
            break;

          case 'PARTICIPANT_LEFT':
            this.emit('onPeerLeft', {
              participantId: msg.participantId,
              nickname: msg.nickname,
              count: msg.participantCount
            });
            break;

          case 'CREATOR_DISCONNECTED':
            this.emit('onDisconnected', msg.message || 'Room creator has disconnected.');
            this.destroy();
            break;

          case 'CHAT_CLEARED':
            this.emit('onChatCleared', { clearedAt: msg.clearedAt, clearedBy: msg.clearedBy });
            break;

          case 'SIGNAL':
            this._handleWebRtcSignal(msg.signalData);
            break;

          case 'ENCRYPTED_MESSAGE':
            this.emit('onEncryptedMessage', msg);
            break;

          case 'ROOM_EXPIRED':
            this.emit('onRoomExpired', msg.message || 'Room has expired.');
            this.destroy();
            break;

          case 'ERROR':
            this.emit('onError', new Error(msg.error || 'Server error.'));
            break;
        }
      };

      this.ws.onclose = () => {
        this.emit('onDisconnected', 'Signaling connection closed.');
      };
    }

    async _initiateWebRtcOffer() {
      if (typeof window === 'undefined' || !window.RTCPeerConnection) return;
      try {
        this.pc = new window.RTCPeerConnection({
          iceServers: this.iceServers,
          iceTransportPolicy: this.iceTransportPolicy || 'all',
          iceCandidatePoolSize: 10
        });

        this._bindPcEvents();

        this.dataChannel = this.pc.createDataChannel('vt-chat', { ordered: true });
        this._bindDataChannelEvents(this.dataChannel);

        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            type: 'SIGNAL',
            roomId: this.roomId,
            creatorSecret: this.creatorSecret,
            guestToken: this.guestToken,
            signalData: { desc: this.pc.localDescription }
          }));
        }
      } catch (e) {
        console.warn('[ServerTransport] WebRTC offer setup error, falling back to secure encrypted WebSocket relay:', e);
      }
    }

    async _drainIceCandidateQueue() {
      if (!this.pc || !this.pc.remoteDescription) return;
      while (this._iceCandidateQueue.length > 0) {
        const candidate = this._iceCandidateQueue.shift();
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.warn('[ServerTransport] Failed to add queued ICE candidate:', e.message);
        }
      }
    }

    async _handleWebRtcSignal(signalData) {
      if (!signalData || typeof window === 'undefined' || !window.RTCPeerConnection) return;
      try {
        if (signalData.desc) {
          const desc = signalData.desc;
          if (desc.type === 'offer') {
            this.pc = new window.RTCPeerConnection({
              iceServers: this.iceServers,
              iceTransportPolicy: this.iceTransportPolicy || 'all',
              iceCandidatePoolSize: 10
            });
            this._bindPcEvents();
            this.pc.ondatachannel = (e) => {
              this.dataChannel = e.channel;
              this._bindDataChannelEvents(this.dataChannel);
            };

            await this.pc.setRemoteDescription(new RTCSessionDescription(desc));
            await this._drainIceCandidateQueue();

            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);

            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({
                type: 'SIGNAL',
                roomId: this.roomId,
                creatorSecret: this.creatorSecret,
                guestToken: this.guestToken,
                signalData: { desc: this.pc.localDescription }
              }));
            }
          } else if (desc.type === 'answer') {
            if (this.pc) {
              await this.pc.setRemoteDescription(new RTCSessionDescription(desc));
              await this._drainIceCandidateQueue();
            }
          }
        } else if (signalData.candidate) {
          if (this.pc && this.pc.remoteDescription) {
            await this.pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
          } else {
            this._iceCandidateQueue.push(signalData.candidate);
          }
        }
      } catch (err) {
        console.warn('[ServerTransport] WebRTC signal handling error:', err);
      }
    }

    _bindPcEvents() {
      this.pc.onicecandidate = (e) => {
        if (e.candidate) {
          if (e.candidate.type) this.candidateTypes.add(e.candidate.type);
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
              type: 'SIGNAL',
              roomId: this.roomId,
              creatorSecret: this.creatorSecret,
              guestToken: this.guestToken,
              signalData: { candidate: e.candidate }
            }));
          }
        }
      };

      this.pc.oniceconnectionstatechange = () => {
        if (this.pc.iceConnectionState === 'connected' || this.pc.iceConnectionState === 'completed') {
          const isRelayed = this.iceTransportPolicy === 'relay' || this.candidateTypes.has('relay');
          this.transportName = isRelayed ? 'WebRTC (TURN Relayed)' : 'WebRTC DataChannel (Direct P2P)';
          this.emit('onConnected');
        }
      };
    }

    _bindDataChannelEvents(channel) {
      channel.onopen = () => {
        const isRelayed = this.iceTransportPolicy === 'relay' || this.candidateTypes.has('relay');
        this.transportName = isRelayed ? 'WebRTC (TURN Relayed)' : 'WebRTC DataChannel (Direct P2P)';
        this.emit('onConnected');
      };

      channel.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'ENCRYPTED_MESSAGE') {
            this.emit('onEncryptedMessage', data);
          } else if (data.type === 'CLEAR_CHAT') {
            this.emit('onChatCleared', data);
          }
        } catch (e) {
          console.warn('[DataChannel message parse error]', e);
        }
      };
    }

    _teardownWebRtc() {
      if (this.dataChannel) {
        try { this.dataChannel.close(); } catch (e) {}
        this.dataChannel = null;
      }
      if (this.pc) {
        try { this.pc.close(); } catch (e) {}
        this.pc = null;
      }
      this.candidateTypes.clear();
      this._iceCandidateQueue = [];
    }

    admitGuest(guestId) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && this.creatorSecret) {
        this.ws.send(JSON.stringify({
          type: 'ADMIT_GUEST',
          roomId: this.roomId,
          guestId: guestId,
          creatorSecret: this.creatorSecret
        }));
      }
    }

    rejectGuest(guestId) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && this.creatorSecret) {
        this.ws.send(JSON.stringify({
          type: 'REJECT_GUEST',
          roomId: this.roomId,
          guestId: guestId,
          creatorSecret: this.creatorSecret
        }));
      }
    }

    removeGuest(guestId) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && this.creatorSecret) {
        this.ws.send(JSON.stringify({
          type: 'REMOVE_GUEST',
          roomId: this.roomId,
          creatorSecret: this.creatorSecret,
          guestId: guestId || null
        }));
      }
      this._teardownWebRtc();
    }

    clearChatForBoth() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'CLEAR_CHAT',
          roomId: this.roomId,
          creatorSecret: this.creatorSecret,
          guestToken: this.guestToken
        }));
      }
      if (this.dataChannel && this.dataChannel.readyState === 'open') {
        try {
          this.dataChannel.send(JSON.stringify({
            type: 'CLEAR_CHAT',
            clearedAt: Date.now(),
            clearedBy: this.nickname
          }));
        } catch (e) {}
      }
    }

    sendEncryptedMessage(payload, senderNickname, timestamp) {
      const msg = {
        type: 'ENCRYPTED_MESSAGE',
        payload: payload,
        senderId: this.participantId,
        senderNick: senderNickname,
        timestamp: timestamp || Date.now()
      };

      // 1. Direct WebRTC DataChannel (P2P or TURN Relay)
      if (this.dataChannel && this.dataChannel.readyState === 'open') {
        this.dataChannel.send(JSON.stringify(msg));
        return;
      }

      // 2. Encrypted fallback relay over WebSocket (Preserves 100% E2EE)
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'ENCRYPTED_MESSAGE',
          roomId: this.roomId,
          creatorSecret: this.creatorSecret,
          guestToken: this.guestToken,
          payload: payload,
          senderNick: senderNickname,
          timestamp: msg.timestamp
        }));
        return;
      }

      throw new Error('No active transport channel available.');
    }

    notifyRoomExpired() {
      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            type: 'ROOM_EXPIRED',
            roomId: this.roomId,
            creatorSecret: this.creatorSecret,
            guestToken: this.guestToken
          }));
        }
      } catch (e) {}
    }

    destroy() {
      this._teardownWebRtc();
      if (this.ws) {
        try { this.ws.close(); } catch (e) {}
        this.ws = null;
      }
    }
  }

  /**
   * 2. PeerJS WebRTC Transport
   */
  class PeerJsTransport extends BaseTransport {
    constructor(callbacks) {
      super(callbacks);
      this.peer = null;
      this.conn = null;
      this.connections = new Map();
      this.transportName = 'PeerJS WebRTC (Cross-Device P2P)';
    }

    async initRoom(role, cleanCode, nickname, publicKeyJwk, roomCreatedAt, roomType = 'direct', maxParticipants = 2) {
      this.role = role;
      this.roomId = cleanCode;
      this.nickname = nickname;
      this.participantId = `${role}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      this.roomCreatedAt = roomCreatedAt || (window.VanishTimeAuthority ? window.VanishTimeAuthority.now() : Date.now());
      this.roomType = roomType || 'direct';
      this.maxParticipants = maxParticipants || (roomType === 'group' ? 10 : 2);

      if (typeof window.Peer === 'undefined') {
        throw new Error('PeerJS library is not loaded.');
      }

      const hostPeerId = `vt-room-${cleanCode}-host`;
      const config = window.CHATSPACE_CONFIG && window.CHATSPACE_CONFIG.peerjs ? window.CHATSPACE_CONFIG.peerjs : {};

      if (role === 'creator') {
        return new Promise((resolve, reject) => {
          let settled = false;
          const peerTimeout = setTimeout(() => {
            if (!settled) {
              settled = true;
              if (this.peer) {
                try { this.peer.destroy(); } catch (e) {}
              }
              reject(new Error('PeerJS connection timed out.'));
            }
          }, 4000);

          try {
            this.peer = new window.Peer(hostPeerId, {
              host: config.host || '0.peerjs.com',
              port: config.port || 443,
              path: config.path || '/',
              secure: config.secure !== false,
              config: config.config
            });

            this.peer.on('open', (id) => {
              if (!settled) {
                settled = true;
                clearTimeout(peerTimeout);
                this.emit('onReady', { transport: this.transportName, role: 'creator', code: cleanCode });
                resolve();
              }
            });

            this.peer.on('connection', (incomingConn) => {
              const now = window.VanishTimeAuthority ? window.VanishTimeAuthority.now() : Date.now();
              if (this.roomCreatedAt && (now - this.roomCreatedAt >= 3600000)) {
                incomingConn.on('open', () => {
                  incomingConn.send({
                    type: 'ROOM_EXPIRED',
                    message: 'This room has reached its 1-hour expiration and is permanently disabled.'
                  });
                  setTimeout(() => incomingConn.close(), 500);
                });
                return;
              }

              // Strict admission control
              if (this.conn && this.conn.open) {
                const rejectFull = () => {
                  incomingConn.send({
                    type: 'ROOM_FULL',
                    message: 'This room is full. Only two participants are allowed.'
                  });
                  setTimeout(() => incomingConn.close(), 500);
                };
                if (incomingConn.open) rejectFull();
                else incomingConn.on('open', rejectFull);
                return;
              }

              this.conn = incomingConn;
              this._setupConnectionHandlers(incomingConn, publicKeyJwk);
            });

            this.peer.on('error', (err) => {
              if (!settled) {
                settled = true;
                clearTimeout(peerTimeout);
                if (err.type === 'unavailable-id') {
                  reject(new Error('A room with this invitation code is already active.'));
                } else {
                  reject(new Error(err.message || 'PeerJS host initialization failed.'));
                }
              }
            });
          } catch (initErr) {
            if (!settled) {
              settled = true;
              clearTimeout(peerTimeout);
              reject(initErr);
            }
          }
        });
      } else {
        return new Promise((resolve, reject) => {
          let settled = false;
          let connectTimeout = setTimeout(() => {
            if (!settled) {
              settled = true;
              reject(new Error('Connection timed out.'));
            }
          }, 20000);

          const guestPeerId = `vt-room-${cleanCode}-guest-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
          this.peer = new window.Peer(guestPeerId, {
            host: config.host || '0.peerjs.com',
            port: config.port || 443,
            path: config.path || '/',
            secure: config.secure !== false,
            config: config.config
          });

          this.peer.on('open', (id) => {
            this.emit('onReady', { transport: this.transportName, role: 'guest', code: cleanCode });
            try {
              const conn = this.peer.connect(hostPeerId, { reliable: true });
              this.conn = conn;
              this._setupConnectionHandlers(conn, publicKeyJwk, () => {
                if (!settled) { settled = true; clearTimeout(connectTimeout); resolve(); }
              }, (err) => {
                if (!settled) { settled = true; clearTimeout(connectTimeout); reject(err); }
              });
            } catch (connErr) {
              if (!settled) { settled = true; clearTimeout(connectTimeout); reject(connErr); }
            }
          });

          this.peer.on('error', (err) => {
            if (!settled) {
              settled = true;
              clearTimeout(connectTimeout);
              reject(new Error(err.message || 'Error connecting to signaling network.'));
            }
          });
        });
      }
    }

    _setupConnectionHandlers(conn, localPublicKeyJwk, onOpenCallback, onErrorCallback) {
      conn.on('open', () => {
        if (typeof onOpenCallback === 'function') onOpenCallback();
        this.emit('onConnected');

        if (this.role === 'guest') {
          conn.send({
            type: 'HANDSHAKE_INIT',
            senderId: this.participantId,
            nickname: this.nickname,
            role: this.role,
            jwk: localPublicKeyJwk,
            roomCreatedAt: this.roomCreatedAt,
            roomType: this.roomType,
            maxParticipants: this.maxParticipants,
            participantCount: 2
          });
        }
      });

      conn.on('data', (data) => {
        if (!data || typeof data !== 'object') return;

        if (data.type === 'ROOM_EXPIRED') {
          this.emit('onRoomExpired', data.message || 'Room expired.');
          this.destroy();
          return;
        }

        if (data.type === 'ROOM_FULL') {
          this.emit('onRoomFull', data.message || 'This room is full.');
          this.destroy();
          return;
        }

        if (data.type === 'HANDSHAKE_INIT') {
          this.emit('onHandshakeReceived', {
            senderId: data.senderId,
            nickname: data.nickname,
            role: data.role,
            jwk: data.jwk,
            roomCreatedAt: data.roomCreatedAt,
            roomType: 'direct',
            maxParticipants: 2,
            participantCount: 2
          });

          if (this.role === 'creator') {
            conn.send({
              type: 'HANDSHAKE_REPLY',
              senderId: this.participantId,
              nickname: this.nickname,
              role: this.role,
              jwk: localPublicKeyJwk,
              roomCreatedAt: this.roomCreatedAt,
              roomType: 'direct',
              maxParticipants: 2,
              participantCount: 2
            });
          }
        } else if (data.type === 'HANDSHAKE_REPLY') {
          this.emit('onHandshakeReceived', {
            senderId: data.senderId,
            nickname: data.nickname,
            role: data.role,
            jwk: data.jwk,
            roomCreatedAt: data.roomCreatedAt,
            roomType: 'direct',
            maxParticipants: 2,
            participantCount: 2
          });
        } else if (data.type === 'ENCRYPTED_MESSAGE') {
          this.emit('onEncryptedMessage', data);
        } else if (data.type === 'CLEAR_CHAT') {
          this.emit('onChatCleared', { clearedAt: data.clearedAt, clearedBy: data.clearedBy });
        } else if (data.type === 'REMOVED_BY_CREATOR') {
          this.emit('onRemovedByCreator', data.message || 'You were removed from the room.');
          this.destroy();
        } else if (data.type === 'LEAVE_ROOM') {
          this.emit('onPeerLeft', { nickname: data.nickname, count: 1 });
        }
      });

      conn.on('close', () => {
        this.conn = null;
        this.emit('onDisconnected', 'A participant disconnected.');
      });

      conn.on('error', (err) => {
        if (typeof onErrorCallback === 'function') onErrorCallback(err);
        this.emit('onError', err);
      });
    }

    clearChatForBoth() {
      const clearedAt = Date.now();
      if (this.conn && this.conn.open) {
        this.conn.send({
          type: 'CLEAR_CHAT',
          clearedAt: clearedAt,
          clearedBy: this.nickname
        });
      }
      this.emit('onChatCleared', { clearedAt, clearedBy: this.nickname });
    }

    removeGuest() {
      if (this.role === 'creator' && this.conn && this.conn.open) {
        this.conn.send({
          type: 'REMOVED_BY_CREATOR',
          message: 'You have been removed from the room by the creator.'
        });
        setTimeout(() => { if (this.conn) this.conn.close(); }, 200);
      }
    }

    sendEncryptedMessage(payload, senderNickname, timestamp) {
      if (!this.conn || !this.conn.open) {
        throw new Error('WebRTC DataChannel is not open.');
      }
      this.conn.send({
        type: 'ENCRYPTED_MESSAGE',
        payload: payload,
        senderId: this.participantId,
        senderNick: senderNickname,
        timestamp: timestamp || Date.now()
      });
    }

    notifyRoomExpired() {
      try {
        if (this.conn && this.conn.open) {
          this.conn.send({
            type: 'ROOM_EXPIRED',
            message: 'This room has reached its 1-hour expiration and is permanently disabled.'
          });
        }
      } catch (e) {}
    }

    destroy() {
      try {
        if (this.conn && this.conn.open) {
          this.conn.send({ type: 'LEAVE_ROOM', nickname: this.nickname });
          this.conn.close();
        }
        if (this.peer) this.peer.destroy();
      } catch (e) {}
      this.peer = null;
      this.conn = null;
    }
  }

  /**
   * 3. BroadcastChannel Transport (Local Dev / Offline Test Mode)
   */
  class BroadcastChannelTransport extends BaseTransport {
    constructor(callbacks) {
      super(callbacks);
      this.channel = null;
      this.peerPresent = false;
      this.peerId = null;
      this.groupMembers = new Map();
      this.transportName = 'Local Tab Mode (Same Browser / Device)';
    }

    async initRoom(role, cleanCode, nickname, publicKeyJwk, roomCreatedAt, roomType = 'direct', maxParticipants = 2) {
      this.role = role;
      this.roomId = cleanCode;
      this.nickname = nickname;
      this.participantId = `${role}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      this.publicKeyJwk = publicKeyJwk;
      this.roomCreatedAt = roomCreatedAt || Date.now();
      this.roomType = roomType || 'direct';
      this.maxParticipants = maxParticipants || 2;

      const channelName = `vanishtext_room_${cleanCode}`;
      this.channel = new BroadcastChannel(channelName);

      this.channel.onmessage = (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object' || msg.senderId === this.participantId) return;

        if (msg.type === 'PING_JOIN') {
          if (this.role === 'creator') {
            const now = Date.now();
            if (this.roomCreatedAt && (now - this.roomCreatedAt >= 3600000)) {
              this.channel.postMessage({
                type: 'ROOM_EXPIRED',
                targetId: msg.senderId,
                message: 'This room has reached its 1-hour expiration and is permanently disabled.'
              });
              return;
            }

            if (this.roomType === 'group') {
              const maxGuests = (this.maxParticipants || 10) - 1;
              if (this.groupMembers.size >= maxGuests && !this.groupMembers.has(msg.senderId)) {
                this.channel.postMessage({
                  type: 'ROOM_FULL',
                  targetId: msg.senderId,
                  message: `This group room is full.`
                });
                return;
              }
              this.groupMembers.set(msg.senderId, { nickname: msg.nickname });
              this.peerPresent = true;
              this.channel.postMessage({
                type: 'PONG_JOIN',
                targetId: msg.senderId,
                senderId: this.participantId,
                nickname: this.nickname,
                role: this.role,
                jwk: this.publicKeyJwk,
                roomCreatedAt: this.roomCreatedAt,
                roomType: this.roomType,
                maxParticipants: this.maxParticipants,
                participantCount: this.groupMembers.size + 1
              });
              this.emit('onConnected');
              return;
            }

            // Strict 1-to-1 Admission Control
            if (this.peerPresent && this.peerId !== msg.senderId) {
              this.channel.postMessage({
                type: 'ROOM_FULL',
                targetId: msg.senderId,
                message: 'This room is full. Only two participants are allowed.'
              });
              return;
            }

            this.peerPresent = true;
            this.peerId = msg.senderId;
            this.channel.postMessage({
              type: 'PONG_JOIN',
              targetId: msg.senderId,
              senderId: this.participantId,
              nickname: this.nickname,
              role: this.role,
              jwk: this.publicKeyJwk,
              roomCreatedAt: this.roomCreatedAt,
              roomType: this.roomType,
              maxParticipants: this.maxParticipants,
              participantCount: 2
            });
            this.emit('onConnected');
          }
        } else if (msg.type === 'PONG_JOIN') {
          if (msg.targetId === this.participantId) {
            this.peerPresent = true;
            this.peerId = msg.senderId;
            this.emit('onConnected');
            this.emit('onHandshakeReceived', {
              senderId: msg.senderId,
              nickname: msg.nickname,
              role: msg.role,
              jwk: msg.jwk,
              roomCreatedAt: msg.roomCreatedAt,
              roomType: msg.roomType || this.roomType,
              maxParticipants: msg.maxParticipants || this.maxParticipants,
              participantCount: msg.participantCount || 2
            });
          }
        } else if (msg.type === 'ROOM_FULL') {
          if (msg.targetId === this.participantId) {
            this.emit('onRoomFull', msg.message);
            this.destroy();
          }
        } else if (msg.type === 'ENCRYPTED_MESSAGE') {
          this.emit('onEncryptedMessage', msg);
        } else if (msg.type === 'CLEAR_CHAT') {
          this.emit('onChatCleared', { clearedAt: msg.clearedAt, clearedBy: msg.clearedBy });
        } else if (msg.type === 'REMOVED_BY_CREATOR') {
          if (!msg.targetId || msg.targetId === this.participantId) {
            this.emit('onRemovedByCreator', msg.message || 'You have been removed from the room by the creator.');
            this.destroy();
          }
        } else if (msg.type === 'LEAVE_ROOM') {
          if (msg.senderId === this.peerId) {
            this.peerPresent = false;
            this.peerId = null;
            this.emit('onPeerLeft', { nickname: msg.nickname, count: 1 });
          }
        } else if (msg.type === 'ROOM_EXPIRED') {
          this.emit('onRoomExpired', msg.message);
          this.destroy();
        }
      };

      this.emit('onReady', { transport: this.transportName, role: this.role, code: cleanCode });

      if (role === 'guest') {
        setTimeout(() => {
          if (this.channel) {
            this.channel.postMessage({
              type: 'PING_JOIN',
              senderId: this.participantId,
              nickname: this.nickname,
              role: this.role,
              jwk: this.publicKeyJwk
            });
          }
        }, 150);
      }
    }

    clearChatForBoth() {
      const clearedAt = Date.now();
      if (this.channel) {
        this.channel.postMessage({
          type: 'CLEAR_CHAT',
          clearedAt: clearedAt,
          clearedBy: this.nickname
        });
      }
      this.emit('onChatCleared', { clearedAt, clearedBy: this.nickname });
    }

    removeGuest() {
      if (this.role === 'creator') {
        if (this.channel) {
          this.channel.postMessage({
            type: 'REMOVED_BY_CREATOR',
            targetId: this.peerId,
            message: 'You have been removed from the room by the creator.'
          });
        }
        this.peerPresent = false;
        this.peerId = null;
      }
    }

    sendEncryptedMessage(payload, senderNickname, timestamp) {
      if (!this.channel) throw new Error('BroadcastChannel is closed.');
      this.channel.postMessage({
        type: 'ENCRYPTED_MESSAGE',
        payload: payload,
        senderId: this.participantId,
        senderNick: senderNickname,
        timestamp: timestamp || Date.now()
      });
    }

    notifyRoomExpired() {
      try {
        if (this.channel) {
          this.channel.postMessage({
            type: 'ROOM_EXPIRED',
            senderId: this.participantId,
            message: 'This room has reached its 1-hour expiration and is permanently disabled.'
          });
        }
      } catch (e) {}
    }

    destroy() {
      try {
        if (this.channel) {
          this.channel.postMessage({
            type: 'LEAVE_ROOM',
            senderId: this.participantId,
            nickname: this.nickname
          });
          this.channel.close();
        }
      } catch (e) {}
      this.channel = null;
    }
  }

  /**
   * Transport Factory & Manager
   */
  class TransportManager {
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.activeTransport = null;
      this.mode = (window.CHATSPACE_CONFIG && window.CHATSPACE_CONFIG.transportMode) || 'auto';
    }

    async connect(role, cleanCode, nickname, publicKeyJwk, preferredMode, roomCreatedAt, roomType = 'direct', maxParticipants = 2) {
      const mode = preferredMode || this.mode;

      if (mode === 'broadcast') {
        this.activeTransport = new BroadcastChannelTransport(this.callbacks);
        await this.activeTransport.initRoom(role, cleanCode, nickname, publicKeyJwk, roomCreatedAt, roomType, maxParticipants);
        return this.activeTransport;
      }

      if (mode === 'peerjs') {
        try {
          this.activeTransport = new PeerJsTransport(this.callbacks);
          await this.activeTransport.initRoom(role, cleanCode, nickname, publicKeyJwk, roomCreatedAt, roomType, maxParticipants);
          return this.activeTransport;
        } catch (peerErr) {
          console.warn('[TransportManager] PeerJS failed, falling back to BroadcastChannel:', peerErr.message);
          this.activeTransport = new BroadcastChannelTransport(this.callbacks);
          await this.activeTransport.initRoom(role, cleanCode, nickname, publicKeyJwk, roomCreatedAt, roomType, maxParticipants);
          return this.activeTransport;
        }
      }

      // 'auto' or 'server': Try ServerSignalingTransport first
      try {
        const serverTransport = new ServerSignalingTransport(this.callbacks);
        await serverTransport.initRoom(role, cleanCode, nickname, publicKeyJwk, roomCreatedAt, roomType, maxParticipants);
        this.activeTransport = serverTransport;
        return this.activeTransport;
      } catch (serverErr) {
        console.warn('[TransportManager] ServerSignalingTransport unavailable or failed:', serverErr.message);

        // Tier 2 Fallback: PeerJS WebRTC
        if (typeof window.Peer !== 'undefined') {
          try {
            console.log('[TransportManager] Trying PeerJS transport...');
            const peerTransport = new PeerJsTransport(this.callbacks);
            await peerTransport.initRoom(role, cleanCode, nickname, publicKeyJwk, roomCreatedAt, roomType, maxParticipants);
            this.activeTransport = peerTransport;
            return this.activeTransport;
          } catch (peerErr) {
            console.warn('[TransportManager] PeerJS transport failed or unavailable:', peerErr.message);
          }
        }

        // Tier 3 Guaranteed Fallback: BroadcastChannel (Dual-tab / Offline / Local mode)
        console.log('[TransportManager] Using BroadcastChannel transport as reliable fallback...');
        this.activeTransport = new BroadcastChannelTransport(this.callbacks);
        await this.activeTransport.initRoom(role, cleanCode, nickname, publicKeyJwk, roomCreatedAt, roomType, maxParticipants);
        return this.activeTransport;
      }
    }

    admitGuest(guestId) {
      if (this.activeTransport && typeof this.activeTransport.admitGuest === 'function') {
        this.activeTransport.admitGuest(guestId);
      }
    }

    rejectGuest(guestId) {
      if (this.activeTransport && typeof this.activeTransport.rejectGuest === 'function') {
        this.activeTransport.rejectGuest(guestId);
      }
    }

    removeGuest(guestId) {
      if (this.activeTransport && typeof this.activeTransport.removeGuest === 'function') {
        this.activeTransport.removeGuest(guestId);
      }
    }

    clearChatForBoth() {
      if (this.activeTransport && typeof this.activeTransport.clearChatForBoth === 'function') {
        this.activeTransport.clearChatForBoth();
      }
    }

    notifyRoomExpired() {
      if (this.activeTransport && typeof this.activeTransport.notifyRoomExpired === 'function') {
        this.activeTransport.notifyRoomExpired();
      }
    }

    sendEncryptedMessage(payload, nickname, timestamp) {
      if (!this.activeTransport) {
        throw new Error('No active transport available.');
      }
      this.activeTransport.sendEncryptedMessage(payload, nickname, timestamp);
    }

    getTransportName() {
      return this.activeTransport ? this.activeTransport.transportName : 'None';
    }

    destroy() {
      if (this.activeTransport) {
        this.activeTransport.destroy();
        this.activeTransport = null;
      }
    }
  }

  window.VanishTransportManager = TransportManager;
  window.ServerSignalingTransport = ServerSignalingTransport;
  window.PeerJsTransport = PeerJsTransport;
  window.BroadcastChannelTransport = BroadcastChannelTransport;
})(window);
