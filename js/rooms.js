/**
 * VanishText {Made by SUVX}
 * Room Lifecycle & Session Coordination Module
 *
 * Enforces:
 * - Temporary 1-to-1 room lifecycle (strictly 2 participants)
 * - 60-minute expiration timer
 * - Handshake coordination with VanishCryptoEngine
 * - Clean teardown upon departure or expiration
 */

(function (window) {
  'use strict';

  const ROOM_STATES = {
    IDLE: 'IDLE',
    CREATING: 'CREATING',
    WAITING_FOR_PEER: 'WAITING_FOR_PEER',
    JOINING: 'JOINING',
    HANDSHAKE: 'HANDSHAKE',
    CONNECTED: 'CONNECTED',
    PEER_DISCONNECTED: 'PEER_DISCONNECTED',
    ROOM_FULL: 'ROOM_FULL',
    EXPIRED: 'EXPIRED',
    ERROR: 'ERROR'
  };

  class RoomSession {
    constructor() {
      this.state = ROOM_STATES.IDLE;
      this.roomId = null;             // Normalized code
      this.formattedCode = null;      // Formatted "XXXX-XXXX-XXXX"
      this.roomName = 'Private Room';
      this.localNickname = '';
      this.remoteNickname = '';
      this.role = null;               // 'creator' | 'guest'
      this.roomType = 'direct';       // 'direct' | 'group'
      this.maxParticipants = 2;
      this.participantCount = 1;
      this.participants = new Map();  // senderId -> nickname
      this.createdAt = null;
      this.createdPerf = 0;
      this.expiresAt = null;
      this.ttlTimerId = null;
      this._onVisibilityCheck = null;

      const ttlMinutes = (window.CHATSPACE_CONFIG && window.CHATSPACE_CONFIG.room && window.CHATSPACE_CONFIG.room.roomTtlMinutes) || 60;
      this.ttlMs = ttlMinutes * 60 * 1000;

      this.crypto = new window.VanishCryptoEngine();
      this.transport = null;

      // Listeners for UI state updates
      this.onStateChangeCallbacks = [];
      this.onMessageReceivedCallbacks = [];
    }

    onStateChange(callback) {
      this.onStateChangeCallbacks.push(callback);
    }

    onMessageReceived(callback) {
      this.onMessageReceivedCallbacks.push(callback);
    }

    _setState(newState, details = {}) {
      this.state = newState;
      console.log(`[RoomSession] State => ${newState}`, details);
      for (const cb of this.onStateChangeCallbacks) {
        try {
          cb(newState, details);
        } catch (e) {
          console.error('[RoomSession] Callback error:', e);
        }
      }
    }

    /**
     * Create a brand new private room.
     * Generates a CSPRNG invitation code and sets the user as Participant 1.
     * @param {string} nickname
     * @param {string} roomName
     * @param {string} [preferredTransport]
     */
    async createRoom(nickname, roomName, preferredTransport, roomType = 'direct') {
      const nickVal = window.VanishValidation.validateNickname(nickname);
      if (!nickVal.valid) throw new Error(nickVal.error);

      const nameVal = window.VanishValidation.validateRoomName(roomName);
      if (!nameVal.valid) throw new Error(nameVal.error);

      const typeVal = window.VanishValidation.validateRoomType
        ? window.VanishValidation.validateRoomType(roomType)
        : { type: roomType, maxParticipants: roomType === 'group' ? 10 : 2 };

      this.leaveRoom(); // reset any prior session
      this._setState(ROOM_STATES.CREATING);

      this.localNickname = nickVal.sanitized;
      this.roomName = nameVal.sanitized;
      this.role = 'creator';
      this.roomType = typeVal.type;
      this.maxParticipants = typeVal.maxParticipants;
      this.participantCount = 1;
      this.participants.clear();

      // Generate cryptographically secure invitation code
      this.formattedCode = this.crypto.generateSecureRoomCode(12);
      this.roomId = this.formattedCode.replace(/-/g, '');
      this.createdAt = window.VanishTimeAuthority ? window.VanishTimeAuthority.now() : Date.now();
      this.createdPerf = (typeof performance !== 'undefined') ? performance.now() : 0;
      const ttlMinutes = (window.CHATSPACE_CONFIG && window.CHATSPACE_CONFIG.room && window.CHATSPACE_CONFIG.room.roomTtlMinutes) || 60;
      this.ttlMs = ttlMinutes * 60 * 1000;
      this.expiresAt = this.createdAt + this.ttlMs;

      // Group rooms derive symmetric room key immediately from room code
      if (this.roomType === 'group') {
        await this.crypto.establishGroupSession(this.formattedCode, this.roomId);
      }

      // Ephemeral ECDH keypair generation
      const localJwk = await this.crypto.generateEphemeralKeypair();

      // Initialize transport manager
      this.transport = new window.VanishTransportManager({
        onReady: (info) => {
          this._startTtlTimer();
          this._setState(ROOM_STATES.WAITING_FOR_PEER, {
            formattedCode: this.formattedCode,
            roomId: this.roomId,
            roomName: this.roomName,
            transportName: info.transport,
            roomType: this.roomType,
            maxParticipants: this.maxParticipants,
            participantCount: 1
          });
        },
        onConnected: () => {
          this._setState(ROOM_STATES.HANDSHAKE, { message: 'Participant connected. Exchanging encryption keys...' });
        },
        onHandshakeReceived: async (peerData) => {
          await this._handlePeerHandshake(peerData);
        },
        onParticipantCountUpdated: (info) => {
          if (info.count) this.participantCount = info.count;
          this._setState(ROOM_STATES.CONNECTED, {
            remoteNickname: this.remoteNickname,
            localNickname: this.localNickname,
            roomName: this.roomName,
            formattedCode: this.formattedCode,
            roomType: this.roomType,
            maxParticipants: this.maxParticipants,
            participantCount: this.participantCount,
            verification: this.crypto.verificationData,
            transportName: this.transport ? this.transport.getTransportName() : ''
          });
        },
        onEncryptedMessage: (data) => {
          this._handleIncomingEncryptedMessage(data);
        },
        onPeerLeft: (peerInfo) => {
          if (this.roomType === 'group') {
            if (peerInfo.count) this.participantCount = peerInfo.count;
            this._setState(ROOM_STATES.CONNECTED, {
              remoteNickname: this.remoteNickname,
              localNickname: this.localNickname,
              roomName: this.roomName,
              formattedCode: this.formattedCode,
              roomType: this.roomType,
              maxParticipants: this.maxParticipants,
              participantCount: this.participantCount,
              verification: this.crypto.verificationData,
              transportName: this.transport ? this.transport.getTransportName() : ''
            });
            for (const cb of this.onMessageReceivedCallbacks) {
              cb({
                text: `${peerInfo.nickname || 'A member'} left the group.`,
                senderNick: 'System',
                isSystem: true,
                timestamp: Date.now()
              });
            }
          } else {
            this.remoteNickname = '';
            this._setState(ROOM_STATES.PEER_DISCONNECTED, {
              message: `${peerInfo.nickname || 'Participant'} has left the room.`
            });
          }
        },
        onRoomFull: (msg) => {
          this._setState(ROOM_STATES.ROOM_FULL, { message: msg });
        },
        onRoomExpired: () => {
          this.expireRoom();
        },
        onDisconnected: (reason) => {
          this._setState(ROOM_STATES.PEER_DISCONNECTED, { message: reason || 'Disconnected from peer.' });
        },
        onError: (err) => {
          this._setState(ROOM_STATES.ERROR, { error: err.message || 'Transport error.' });
        }
      });

      await this.transport.connect('creator', this.roomId, this.localNickname, localJwk, preferredTransport, this.createdAt, this.roomType, this.maxParticipants);
      return {
        formattedCode: this.formattedCode,
        roomId: this.roomId,
        roomName: this.roomName,
        roomType: this.roomType
      };
    }

    /**
     * Join an existing private room as Participant 2.
     * @param {string} rawCode
     * @param {string} nickname
     * @param {string} [preferredTransport]
     */
    async joinRoom(rawCode, nickname, preferredTransport) {
      // Check joining rate limits
      const rateCheck = window.VanishValidation.checkJoinRateLimit();
      if (!rateCheck.allowed) {
        throw new Error(`Too many join attempts. Please wait ${Math.ceil(rateCheck.waitMs / 1000)} seconds.`);
      }

      const codeVal = window.VanishValidation.validateRoomCode(rawCode);
      if (!codeVal.valid) throw new Error(codeVal.error);

      // Rule 4: Never reactivate an expired room
      if (window.VanishValidation && window.VanishValidation.isRoomExpired(codeVal.normalized)) {
        throw new Error('This room has reached its 1-hour expiration and is permanently disabled. Never reactivate an expired room; please create a new room with a new invitation code.');
      }

      const nickVal = window.VanishValidation.validateNickname(nickname);
      if (!nickVal.valid) throw new Error(nickVal.error);

      this.leaveRoom();
      this._setState(ROOM_STATES.JOINING);

      this.roomId = codeVal.normalized;
      this.formattedCode = codeVal.formatted;
      this.localNickname = nickVal.sanitized;
      this.role = 'guest';
      this.createdAt = window.VanishTimeAuthority ? window.VanishTimeAuthority.now() : Date.now();
      this.createdPerf = (typeof performance !== 'undefined') ? performance.now() : 0;
      const ttlMinutes = (window.CHATSPACE_CONFIG && window.CHATSPACE_CONFIG.room && window.CHATSPACE_CONFIG.room.roomTtlMinutes) || 60;
      this.ttlMs = ttlMinutes * 60 * 1000;
      this.expiresAt = this.createdAt + this.ttlMs;

      // Ephemeral ECDH keypair generation
      const localJwk = await this.crypto.generateEphemeralKeypair();

      this.transport = new window.VanishTransportManager({
        onReady: () => {
          this._startTtlTimer();
          this._setState(ROOM_STATES.HANDSHAKE, { message: 'Connecting to room and verifying participant slot...' });
        },
        onConnected: () => {
          this._setState(ROOM_STATES.HANDSHAKE, { message: 'Connected to host. Initiating ECDH key exchange...' });
        },
        onHandshakeReceived: async (peerData) => {
          await this._handlePeerHandshake(peerData);
        },
        onParticipantCountUpdated: (info) => {
          if (info.count) this.participantCount = info.count;
          this._setState(ROOM_STATES.CONNECTED, {
            remoteNickname: this.remoteNickname,
            localNickname: this.localNickname,
            roomName: this.roomName,
            formattedCode: this.formattedCode,
            roomType: this.roomType,
            maxParticipants: this.maxParticipants,
            participantCount: this.participantCount,
            verification: this.crypto.verificationData,
            transportName: this.transport ? this.transport.getTransportName() : ''
          });
        },
        onEncryptedMessage: (data) => {
          this._handleIncomingEncryptedMessage(data);
        },
        onPeerLeft: (peerInfo) => {
          if (this.roomType === 'group') {
            if (peerInfo.count) this.participantCount = peerInfo.count;
            this._setState(ROOM_STATES.CONNECTED, {
              remoteNickname: this.remoteNickname,
              localNickname: this.localNickname,
              roomName: this.roomName,
              formattedCode: this.formattedCode,
              roomType: this.roomType,
              maxParticipants: this.maxParticipants,
              participantCount: this.participantCount,
              verification: this.crypto.verificationData,
              transportName: this.transport ? this.transport.getTransportName() : ''
            });
            for (const cb of this.onMessageReceivedCallbacks) {
              cb({
                text: `${peerInfo.nickname || 'A member'} left the group.`,
                senderNick: 'System',
                isSystem: true,
                timestamp: Date.now()
              });
            }
          } else {
            this.remoteNickname = '';
            this._setState(ROOM_STATES.PEER_DISCONNECTED, {
              message: `${peerInfo.nickname || 'Participant'} has left the room.`
            });
          }
        },
        onRoomFull: (msg) => {
          this._setState(ROOM_STATES.ROOM_FULL, { message: msg });
        },
        onRoomExpired: () => {
          this.expireRoom();
        },
        onDisconnected: (reason) => {
          this._setState(ROOM_STATES.PEER_DISCONNECTED, { message: reason || 'Disconnected from room.' });
        },
        onError: (err) => {
          this._setState(ROOM_STATES.ERROR, { error: err.message || 'Connection failed.' });
        }
      });

      await this.transport.connect('guest', this.roomId, this.localNickname, localJwk, preferredTransport, this.createdAt);
    }

    /**
     * Handle incoming peer public key and establish shared AES-GCM + SAS session.
     * Synchronizes room creation time from creator to enforce exact 1-hour expiration.
     * @private
     */
    async _handlePeerHandshake(peerData) {
      try {
        if (peerData.roomCreatedAt && typeof peerData.roomCreatedAt === 'number') {
          this.createdAt = peerData.roomCreatedAt;
          this.expiresAt = this.createdAt + this.ttlMs;
          if (this._checkIfExpired()) {
            return;
          }
        }

        if (peerData.roomType) this.roomType = peerData.roomType;
        if (peerData.maxParticipants) this.maxParticipants = peerData.maxParticipants;

        let verification = null;
        if (this.roomType === 'group') {
          verification = await this.crypto.establishGroupSession(this.formattedCode, this.roomId);
          if (peerData.senderId && peerData.nickname) {
            this.participants.set(peerData.senderId, peerData.nickname);
          }
          this.participantCount = peerData.participantCount || Math.max(2, this.participants.size + 1);
          this.remoteNickname = `${this.participantCount - 1} members`;
        } else {
          this.remoteNickname = peerData.nickname || (this.role === 'creator' ? 'Participant 2' : 'Host');
          verification = await this.crypto.establishSharedSession(peerData.jwk, this.roomId);
          this.participantCount = 2;
        }

        this._setState(ROOM_STATES.CONNECTED, {
          remoteNickname: this.remoteNickname,
          localNickname: this.localNickname,
          roomName: this.roomName,
          formattedCode: this.formattedCode,
          roomType: this.roomType,
          maxParticipants: this.maxParticipants,
          participantCount: this.participantCount,
          verification: verification,
          transportName: this.transport ? this.transport.getTransportName() : ''
        });
      } catch (err) {
        console.error('[RoomSession] Handshake failed:', err);
        this._setState(ROOM_STATES.ERROR, { error: 'Failed to establish encrypted session: ' + err.message });
      }
    }

    /**
     * Receive and decrypt incoming ciphertext.
     * Verifies message lifetime; discards any message older than 15 minutes.
     * @private
     */
    async _handleIncomingEncryptedMessage(data) {
      if (!this.crypto.hasActiveSession()) {
        console.warn('[RoomSession] Received message but crypto session is not ready.');
        return;
      }

      if (this._checkIfExpired()) {
        console.warn('[RoomSession] Message rejected: room has expired.');
        return;
      }

      const msgTimestamp = typeof data.timestamp === 'number' ? data.timestamp : Date.now();
      const msgTtlMinutes = (window.CHATSPACE_CONFIG && window.CHATSPACE_CONFIG.messaging && window.CHATSPACE_CONFIG.messaging.messageTtlMinutes) || 15;
      const ttlMs = msgTtlMinutes * 60 * 1000;

      // Reliable enforcement: reject expired incoming message immediately
      if (window.VanishTimeAuthority && window.VanishTimeAuthority.isMessageExpired(msgTimestamp, ttlMs)) {
        console.warn('[RoomSession] Received message has already expired (> 15m). Discarding.');
        return;
      }

      try {
        const decryptedText = await this.crypto.decryptMessage(data.payload, {
          roomId: this.roomId,
          senderId: data.senderId
        });

        // Notify chat controller with decrypted plain text and verified timestamp
        for (const cb of this.onMessageReceivedCallbacks) {
          try {
            cb({
              text: decryptedText,
              senderNick: data.senderNick || this.remoteNickname || 'Participant',
              isSelf: false,
              timestamp: msgTimestamp
            });
          } catch (e) {
            console.error('[RoomSession] Message callback error:', e);
          }
        }
      } catch (decryptErr) {
        console.error('[RoomSession] Decryption error:', decryptErr);
        for (const cb of this.onMessageReceivedCallbacks) {
          cb({
            text: '⚠️ [Security Alert: Tampered or unauthenticated message rejected.]',
            senderNick: 'System',
            isSelf: false,
            isSecurityAlert: true,
            timestamp: Date.now()
          });
        }
      }
    }

    /**
     * Send an outbound encrypted message.
     * @param {string} text
     */
    async sendMessage(text) {
      if (this._checkIfExpired()) {
        throw new Error('Cannot send message: room has reached its 1-hour expiration and is permanently disabled.');
      }

      if (this.state !== ROOM_STATES.CONNECTED) {
        throw new Error('Cannot send message. Room is not connected and encrypted.');
      }

      const msgVal = window.VanishValidation.validateMessage(text);
      if (!msgVal.valid) throw new Error(msgVal.error);

      const rateCheck = window.VanishValidation.checkMessageRateLimit();
      if (!rateCheck.allowed) {
        throw new Error(`Message rate limit reached. Please wait ${Math.ceil(rateCheck.waitMs / 1000)}s.`);
      }

      // Encrypt message locally with fresh IV and bound AAD
      const encryptedPayload = await this.crypto.encryptMessage(msgVal.sanitized, {
        roomId: this.roomId,
        senderId: this.transport.activeTransport ? this.transport.activeTransport.participantId : 'self'
      });

      const messageTimestamp = window.VanishTimeAuthority ? window.VanishTimeAuthority.now() : Date.now();

      // Transmit ciphertext over transport with creation timestamp
      this.transport.sendEncryptedMessage(encryptedPayload, this.localNickname, messageTimestamp);

      // Return self message for local live display
      return {
        text: msgVal.sanitized,
        senderNick: this.localNickname,
        isSelf: true,
        timestamp: messageTimestamp
      };
    }

    /**
     * Check if room has expired based on real elapsed time.
     * @returns {boolean}
     */
    _checkIfExpired() {
      if (!this.createdAt || !this.expiresAt) return false;
      const now = window.VanishTimeAuthority ? window.VanishTimeAuthority.now() : Date.now();
      const elapsedWall = now - this.createdAt;
      const elapsedPerf = (this.createdPerf && typeof performance !== 'undefined')
        ? (performance.now() - this.createdPerf)
        : 0;
      const realElapsed = Math.max(elapsedWall, elapsedPerf);

      if (realElapsed >= this.ttlMs || now >= this.expiresAt) {
        this.expireRoom();
        return true;
      }
      return false;
    }

    /**
     * Start the 1-hour countdown timer using real elapsed time.
     * @private
     */
    _startTtlTimer() {
      if (this.ttlTimerId) clearInterval(this.ttlTimerId);
      this.ttlTimerId = setInterval(() => {
        this._checkIfExpired();
      }, 1000);
      if (this.ttlTimerId && typeof this.ttlTimerId.unref === 'function') {
        this.ttlTimerId.unref();
      }

      this._onVisibilityCheck = () => {
        if (typeof document !== 'undefined' && !document.hidden) {
          this._checkIfExpired();
        }
      };
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', this._onVisibilityCheck);
      }
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('focus', this._onVisibilityCheck);
      }
    }

    /**
     * Permanently expire and disable the room after exactly 1 hour of real elapsed time.
     * Invalids invitation code and disconnects both participants.
     */
    expireRoom() {
      const codeToInvalidate = this.roomId;
      const formattedToInvalidate = this.formattedCode;

      // Invalidate code in permanent registry
      if (codeToInvalidate && window.VanishValidation) {
        window.VanishValidation.markRoomExpired(codeToInvalidate);
      }
      if (formattedToInvalidate && window.VanishValidation) {
        window.VanishValidation.markRoomExpired(formattedToInvalidate);
      }

      // Notify peer that room expired
      if (this.transport) {
        try {
          this.transport.notifyRoomExpired();
        } catch (e) {}
      }

      this._teardownResources();

      this._setState(ROOM_STATES.EXPIRED, {
        message: 'This room has reached its 1-hour lifespan and has been permanently disabled. The creator must create a new room with a new invitation code.'
      });
    }

    /**
     * Teardown all resources, timers, and crypto material.
     * @private
     */
    _teardownResources() {
      if (this.ttlTimerId) {
        clearInterval(this.ttlTimerId);
        this.ttlTimerId = null;
      }
      if (this._onVisibilityCheck) {
        if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
          document.removeEventListener('visibilitychange', this._onVisibilityCheck);
        }
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          window.removeEventListener('focus', this._onVisibilityCheck);
        }
        this._onVisibilityCheck = null;
      }
      if (this.transport) {
        this.transport.destroy();
        this.transport = null;
      }
      if (this.crypto) {
        this.crypto.destroySession();
      }

      this.roomId = null;
      this.formattedCode = null;
      this.roomName = 'Private Room';
      this.localNickname = '';
      this.remoteNickname = '';
      this.role = null;
      this.roomType = 'direct';
      this.maxParticipants = 2;
      this.participantCount = 1;
      this.participants.clear();
      this.createdAt = null;
      this.createdPerf = 0;
      this.expiresAt = null;
    }

    /**
     * Leave and completely destroy the current room.
     * Wipes all keys, transport connections, and temporary state.
     */
    leaveRoom() {
      this._teardownResources();
      this._setState(ROOM_STATES.IDLE);
    }
  }

  window.VanishRoomSession = RoomSession;
  window.VANISH_ROOM_STATES = ROOM_STATES;
})(window);
