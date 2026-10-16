/**
 * VanishText {Made by SUVX}
 * Transport & Signaling Layer
 *
 * Implements:
 * 1. WebRTC DataChannel via PeerJS Cloud (Real cross-device P2P communication)
 * 2. BroadcastChannel Transport (Zero-setup local development & testing between tabs)
 * 3. Supabase Realtime Broadcast (Optional managed websocket transport)
 *
 * Strict 2-participant admission control enforced at connection handshake.
 * No plaintext messages ever traverse the network.
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
  }

  /**
   * 1. PeerJS WebRTC Transport
   * Connects two separate devices directly over WebRTC DataChannel.
   * Signaling handled ephemerally by PeerJS cloud broker (0.peerjs.com).
   */
  class PeerJsTransport extends BaseTransport {
    constructor(callbacks) {
      super(callbacks);
      this.peer = null;
      this.conn = null;
      this.connections = new Map(); // Host tracks all connected guest peers
      this.activeConnections = 0;
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
        throw new Error('PeerJS library is not loaded. Ensure external internet connection or switch to Local Dev Mode.');
      }

      const hostPeerId = `vt-room-${cleanCode}-host`;
      const config = window.CHATSPACE_CONFIG && window.CHATSPACE_CONFIG.peerjs ? window.CHATSPACE_CONFIG.peerjs : {};

      if (role === 'creator') {
        return new Promise((resolve, reject) => {
          this.peer = new window.Peer(hostPeerId, {
            host: config.host || '0.peerjs.com',
            port: config.port || 443,
            path: config.path || '/',
            secure: config.secure !== false,
            config: config.config
          });

          this.peer.on('open', (id) => {
            console.log(`[PeerJS] Host registered with peer ID: ${id}`);
            this.emit('onReady', { transport: this.transportName, role: 'creator', code: cleanCode });
            resolve();
          });

          this.peer.on('connection', (incomingConn) => {
            // Check if room has reached its 1-hour lifespan
            const now = window.VanishTimeAuthority ? window.VanishTimeAuthority.now() : Date.now();
            if (this.roomCreatedAt && (now - this.roomCreatedAt >= 3600000)) {
              console.warn('[PeerJS] Incoming connection rejected. Room has expired.');
              incomingConn.on('open', () => {
                incomingConn.send({
                  type: 'ROOM_EXPIRED',
                  message: 'This room has reached its 1-hour expiration and is permanently disabled.'
                });
                setTimeout(() => incomingConn.close(), 500);
              });
              return;
            }

            // Admission Control
            if (this.roomType === 'group') {
              const maxGuests = (this.maxParticipants || 10) - 1;
              if (this.connections.size >= maxGuests) {
                console.warn(`[PeerJS] Group connection rejected. Room is full (${this.maxParticipants} max).`);
                incomingConn.on('open', () => {
                  incomingConn.send({
                    type: 'ROOM_FULL',
                    message: `This group room is full. Maximum ${this.maxParticipants} participants allowed.`
                  });
                  setTimeout(() => incomingConn.close(), 500);
                });
                return;
              }
              this.connections.set(incomingConn.peer, incomingConn);
              this.conn = incomingConn;
              this._setupConnectionHandlers(incomingConn, publicKeyJwk);
            } else {
              // Strict 2-Participant Admission Control!
              if (this.conn && this.conn.open) {
                console.warn('[PeerJS] Third participant rejected. Room is full.');
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
            }
          });

          this.peer.on('error', (err) => {
            console.error('[PeerJS Host Error]', err);
            if (err.type === 'unavailable-id') {
              reject(new Error('A room with this invitation code is already active.'));
            } else {
              reject(new Error(err.message || 'PeerJS host initialization failed.'));
            }
          });
        });
      } else {
        // Guest joining
        return new Promise((resolve, reject) => {
          let settled = false;
          let connectTimeout = null;

          const safeResolve = () => {
            if (!settled) {
              settled = true;
              if (connectTimeout) clearTimeout(connectTimeout);
              resolve();
            }
          };

          const safeReject = (err) => {
            if (!settled) {
              settled = true;
              if (connectTimeout) clearTimeout(connectTimeout);
              reject(err);
            }
          };

          // 20-second timeout for WebRTC ICE candidate negotiation
          connectTimeout = setTimeout(() => {
            safeReject(new Error('Connection timed out. Host may be offline, room expired, or network firewall is blocking P2P connection.'));
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
            console.log(`[PeerJS] Guest initialized (${id}), connecting to host: ${hostPeerId}`);
            this.emit('onReady', { transport: this.transportName, role: 'guest', code: cleanCode });

            try {
              const conn = this.peer.connect(hostPeerId, {
                reliable: true
              });
              this.conn = conn;
              this._setupConnectionHandlers(conn, publicKeyJwk, safeResolve, safeReject);
            } catch (connErr) {
              safeReject(connErr);
            }
          });

          this.peer.on('error', (err) => {
            console.error('[PeerJS Guest Error]', err);
            if (err.type === 'peer-unavailable') {
              safeReject(new Error('Room not found or creator has left the room. Please check the invitation code.'));
            } else if (err.type === 'unavailable-id') {
              safeReject(new Error('Connection conflict. Please try joining again.'));
            } else {
              safeReject(new Error(err.message || 'Error connecting to signaling network.'));
            }
          });
        });
      }
    }

    _setupConnectionHandlers(conn, localPublicKeyJwk, onOpenCallback, onErrorCallback) {
      conn.on('open', () => {
        console.log(`[PeerJS] Direct WebRTC DataChannel connection established (role: ${this.role}).`);
        if (typeof onOpenCallback === 'function') {
          onOpenCallback();
        }
        this.emit('onConnected');

        // Only guest initiates the handshake request; host will respond with HANDSHAKE_REPLY
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
          this.emit('onRoomExpired', data.message || 'This room has reached its 1-hour expiration and is permanently disabled.');
          this.destroy();
          return;
        }

        if (data.type === 'ROOM_FULL') {
          this.emit('onRoomFull', data.message || 'This room is full.');
          this.destroy();
          return;
        }

        if (data.type === 'HANDSHAKE_INIT') {
          if (data.roomType) this.roomType = data.roomType;
          if (data.maxParticipants) this.maxParticipants = data.maxParticipants;

          this.emit('onHandshakeReceived', {
            senderId: data.senderId,
            nickname: data.nickname,
            role: data.role,
            jwk: data.jwk,
            roomCreatedAt: data.roomCreatedAt,
            roomType: data.roomType || this.roomType,
            maxParticipants: data.maxParticipants || this.maxParticipants,
            participantCount: this.role === 'creator' ? this.connections.size + 1 : (data.participantCount || 2)
          });

          // Reply if we are host and received guest's handshake
          if (this.role === 'creator') {
            conn.send({
              type: 'HANDSHAKE_REPLY',
              senderId: this.participantId,
              nickname: this.nickname,
              role: this.role,
              jwk: localPublicKeyJwk,
              roomCreatedAt: this.roomCreatedAt,
              roomType: this.roomType,
              maxParticipants: this.maxParticipants,
              participantCount: this.connections.size + 1
            });

            if (this.roomType === 'group') {
              this._broadcastToPeers({
                type: 'ROOM_PARTICIPANTS_UPDATE',
                count: this.connections.size + 1,
                maxParticipants: this.maxParticipants,
                joinedNick: data.nickname
              }, conn.peer);
            }
          }
        } else if (data.type === 'HANDSHAKE_REPLY') {
          if (data.roomType) this.roomType = data.roomType;
          if (data.maxParticipants) this.maxParticipants = data.maxParticipants;
          this.emit('onHandshakeReceived', {
            senderId: data.senderId,
            nickname: data.nickname,
            role: data.role,
            jwk: data.jwk,
            roomCreatedAt: data.roomCreatedAt,
            roomType: data.roomType || this.roomType,
            maxParticipants: data.maxParticipants || this.maxParticipants,
            participantCount: data.participantCount || 2
          });
        } else if (data.type === 'ROOM_PARTICIPANTS_UPDATE') {
          this.emit('onParticipantCountUpdated', data);
        } else if (data.type === 'ENCRYPTED_MESSAGE') {
          this.emit('onEncryptedMessage', data);
          // If host in group mode, forward to other connected guests!
          if (this.role === 'creator' && this.roomType === 'group') {
            this._broadcastToPeers(data, conn.peer);
          }
        } else if (data.type === 'LEAVE_ROOM') {
          if (this.role === 'creator') {
            this.connections.delete(conn.peer);
            if (this.roomType === 'group') {
              this._broadcastToPeers({
                type: 'ROOM_PARTICIPANTS_UPDATE',
                count: this.connections.size + 1,
                maxParticipants: this.maxParticipants,
                leftNick: data.nickname
              });
            }
          }
          this.emit('onPeerLeft', { nickname: data.nickname, count: this.role === 'creator' ? this.connections.size + 1 : 1 });
        }
      });

      conn.on('close', () => {
        console.log('[PeerJS] WebRTC connection closed.');
        if (typeof onErrorCallback === 'function') {
          onErrorCallback(new Error('Connection closed before handshake completed.'));
        }
        if (this.role === 'creator') {
          this.connections.delete(conn.peer);
          if (this.conn === conn) {
            this.conn = null;
          }
        } else {
          this.conn = null;
        }
        this.emit('onDisconnected', 'A participant disconnected.');
      });

      conn.on('error', (err) => {
        console.error('[PeerJS DataChannel Error]', err);
        if (typeof onErrorCallback === 'function') {
          onErrorCallback(err);
        }
        this.emit('onError', err);
      });
    }

    _broadcastToPeers(msg, excludePeer) {
      for (const [peerId, c] of this.connections.entries()) {
        if (peerId !== excludePeer && c && c.open) {
          try {
            c.send(msg);
          } catch (e) {
            console.warn('[PeerJS Broadcast Error]', e);
          }
        }
      }
    }

    notifyRoomExpired() {
      try {
        const msg = {
          type: 'ROOM_EXPIRED',
          message: 'This room has reached its 1-hour expiration and is permanently disabled.'
        };
        if (this.role === 'creator' && this.roomType === 'group') {
          this._broadcastToPeers(msg);
        }
        if (this.conn && this.conn.open) {
          this.conn.send(msg);
        }
      } catch (e) {
        console.warn('[PeerJS] Could not send ROOM_EXPIRED notice:', e);
      }
    }

    sendEncryptedMessage(payload, senderNickname, timestamp) {
      const msg = {
        type: 'ENCRYPTED_MESSAGE',
        payload: payload,
        senderId: this.participantId,
        senderNick: senderNickname,
        timestamp: timestamp || (window.VanishTimeAuthority ? window.VanishTimeAuthority.now() : Date.now())
      };

      if (this.role === 'creator' && this.roomType === 'group') {
        let sentCount = 0;
        for (const conn of this.connections.values()) {
          if (conn && conn.open) {
            conn.send(msg);
            sentCount++;
          }
        }
        if (sentCount === 0 && (!this.conn || !this.conn.open)) {
          throw new Error('WebRTC DataChannel is not open.');
        }
      } else {
        if (!this.conn || !this.conn.open) {
          throw new Error('WebRTC DataChannel is not open.');
        }
        this.conn.send(msg);
      }
    }

    destroy() {
      try {
        if (this.role === 'creator') {
          this._broadcastToPeers({ type: 'LEAVE_ROOM', nickname: this.nickname });
          for (const conn of this.connections.values()) {
            if (conn && conn.open) conn.close();
          }
          this.connections.clear();
        } else if (this.conn && this.conn.open) {
          this.conn.send({ type: 'LEAVE_ROOM', nickname: this.nickname });
          this.conn.close();
        }
        if (this.peer) {
          this.peer.destroy();
        }
      } catch (e) {
        console.warn('[PeerJS Destroy Warning]', e);
      }
      this.peer = null;
      this.conn = null;
    }
  }

  /**
   * 2. BroadcastChannel Transport (Local Dev / Offline Test Mode)
   * Connects tabs in the same browser window for immediate offline testing.
   */
  class BroadcastChannelTransport extends BaseTransport {
    constructor(callbacks) {
      super(callbacks);
      this.channel = null;
      this.peerPresent = false;
      this.groupMembers = new Map(); // senderId -> { nickname }
      this.transportName = 'Local Tab Mode (Same Browser / Device)';
    }

    async initRoom(role, cleanCode, nickname, publicKeyJwk, roomCreatedAt, roomType = 'direct', maxParticipants = 2) {
      this.role = role;
      this.roomId = cleanCode;
      this.nickname = nickname;
      this.participantId = `${role}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      this.publicKeyJwk = publicKeyJwk;
      this.roomCreatedAt = roomCreatedAt || (window.VanishTimeAuthority ? window.VanishTimeAuthority.now() : Date.now());
      this.roomType = roomType || 'direct';
      this.maxParticipants = maxParticipants || (roomType === 'group' ? 10 : 2);

      const channelName = `vanishtext_room_${cleanCode}`;
      this.channel = new BroadcastChannel(channelName);

      this.channel.onmessage = (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object' || msg.senderId === this.participantId) return;

        if (msg.type === 'PING_JOIN') {
          // If creator receives PING_JOIN from guest
          if (this.role === 'creator') {
            const now = window.VanishTimeAuthority ? window.VanishTimeAuthority.now() : Date.now();
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
                  message: `This group room is full. Maximum ${this.maxParticipants} participants allowed.`
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
              this.emit('onParticipantCountUpdated', {
                count: this.groupMembers.size + 1,
                maxParticipants: this.maxParticipants,
                joinedNick: msg.nickname
              });
            } else {
              if (this.peerPresent && this.peerId !== msg.senderId) {
                // Third participant attempt! Reject atomically!
                this.channel.postMessage({
                  type: 'ROOM_FULL',
                  targetId: msg.senderId,
                  message: 'This room is full. Only two participants are allowed.'
                });
                return;
              }
              this.peerPresent = true;
              this.peerId = msg.senderId;
              // Send PONG and handshake
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
          }
        } else if (msg.type === 'PONG_JOIN') {
          if (msg.targetId === this.participantId) {
            this.peerPresent = true;
            this.peerId = msg.senderId;
            if (msg.roomType) this.roomType = msg.roomType;
            if (msg.maxParticipants) this.maxParticipants = msg.maxParticipants;
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
        } else if (msg.type === 'ROOM_EXPIRED') {
          if (!msg.targetId || msg.targetId === this.participantId) {
            this.emit('onRoomExpired', msg.message || 'This room has reached its 1-hour expiration and is permanently disabled.');
            this.destroy();
          }
        } else if (msg.type === 'ROOM_FULL') {
          if (msg.targetId === this.participantId) {
            this.emit('onRoomFull', msg.message);
            this.destroy();
          }
        } else if (msg.type === 'HANDSHAKE_INIT') {
          if (this.peerId === msg.senderId || !this.peerId || this.roomType === 'group') {
            this.peerId = msg.senderId;
            if (msg.roomType) this.roomType = msg.roomType;
            if (msg.maxParticipants) this.maxParticipants = msg.maxParticipants;
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
        } else if (msg.type === 'ROOM_PARTICIPANTS_UPDATE') {
          this.emit('onParticipantCountUpdated', msg);
        } else if (msg.type === 'ENCRYPTED_MESSAGE') {
          this.emit('onEncryptedMessage', msg);
        } else if (msg.type === 'LEAVE_ROOM') {
          if (this.roomType === 'group' && this.role === 'creator') {
            this.groupMembers.delete(msg.senderId);
            this.emit('onPeerLeft', { nickname: msg.nickname, count: this.groupMembers.size + 1 });
            this.channel.postMessage({
              type: 'ROOM_PARTICIPANTS_UPDATE',
              count: this.groupMembers.size + 1,
              maxParticipants: this.maxParticipants,
              leftNick: msg.nickname
            });
          } else if (msg.senderId === this.peerId) {
            this.peerPresent = false;
            this.peerId = null;
            this.emit('onPeerLeft', { nickname: msg.nickname, count: 1 });
          }
        }
      };

      this.emit('onReady', { transport: this.transportName, role: this.role, code: cleanCode });

      // If guest, broadcast PING_JOIN and our public key
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
        }, 300);
      }
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
      } catch (e) {
        console.warn('[BroadcastChannel] Could not send ROOM_EXPIRED notice:', e);
      }
    }

    sendEncryptedMessage(payload, senderNickname, timestamp) {
      if (!this.channel) {
        throw new Error('BroadcastChannel is closed.');
      }
      this.channel.postMessage({
        type: 'ENCRYPTED_MESSAGE',
        payload: payload,
        senderId: this.participantId,
        senderNick: senderNickname,
        timestamp: timestamp || (window.VanishTimeAuthority ? window.VanishTimeAuthority.now() : Date.now())
      });
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
      } catch (e) {
        console.warn('[BroadcastChannel Destroy Warning]', e);
      }
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

    /**
     * Create appropriate transport based on configuration and availability.
     * @param {string} role 'creator' | 'guest'
     * @param {string} cleanCode
     * @param {string} nickname
     * @param {Object} publicKeyJwk
     */
    async connect(role, cleanCode, nickname, publicKeyJwk, preferredMode, roomCreatedAt, roomType = 'direct', maxParticipants = 2) {
      const mode = preferredMode || this.mode;

      if (mode === 'broadcast') {
        this.activeTransport = new BroadcastChannelTransport(this.callbacks);
      } else if (mode === 'peerjs') {
        this.activeTransport = new PeerJsTransport(this.callbacks);
      } else {
        // 'auto' mode: try PeerJS if library is present, otherwise fallback to BroadcastChannel
        if (typeof window.Peer !== 'undefined') {
          console.log('[TransportManager] Using PeerJS WebRTC Transport for real cross-device communication.');
          this.activeTransport = new PeerJsTransport(this.callbacks);
        } else {
          console.log('[TransportManager] PeerJS unavailable. Using BroadcastChannel local dev transport.');
          this.activeTransport = new BroadcastChannelTransport(this.callbacks);
        }
      }

      try {
        await this.activeTransport.initRoom(role, cleanCode, nickname, publicKeyJwk, roomCreatedAt, roomType, maxParticipants);
        return this.activeTransport;
      } catch (err) {
        console.error('[TransportManager] Connection failed:', err);
        throw err;
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
  window.PeerJsTransport = PeerJsTransport;
  window.BroadcastChannelTransport = BroadcastChannelTransport;
})(window);
