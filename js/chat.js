/**
 * VanishText {Made by SUVX}
 * Chat Controller & Memory-Only Message Renderer
 *
 * Enforces:
 * - NO CHAT HISTORY: strictly zero localStorage, sessionStorage, or IndexedDB storage.
 * - Live in-memory message display only.
 * - Safe DOM manipulation: document.createTextNode & element.textContent exclusively.
 * - Immediate memory zeroing and DOM wiping when leaving the room.
 */

(function (window) {
  'use strict';

  class VanishChatController {
    constructor(elements) {
      this.elements = elements; // { messageList, textarea, sendBtn, charCount }
      this.liveMessages = [];   // Transient array in memory ONLY
      this.messageTimers = new Map(); // msgId -> setTimeout timerId
      this.isSending = false;
      this.roomSession = null;

      const cfgTtl = window.CHATSPACE_CONFIG && window.CHATSPACE_CONFIG.messaging && window.CHATSPACE_CONFIG.messaging.messageTtlMinutes;
      this.ttlMinutes = typeof cfgTtl === 'number' ? cfgTtl : 15;
      this.ttlMs = this.ttlMinutes * 60 * 1000; // 15 minutes in ms
      this.lastClearedTimestamp = 0; // Cutoff for server-synchronized clear chat

      this._sweeperInterval = null;
      this._onVisibilityChange = null;
      this._startSweeper();
    }

    /**
     * Start background sweeper to reliably enforce expiration during tab throttling or wake from sleep.
     * @private
     */
    _startSweeper() {
      if (this._sweeperInterval) clearInterval(this._sweeperInterval);
      this._sweeperInterval = setInterval(() => this.purgeExpiredMessages(), 2000);
      if (this._sweeperInterval && typeof this._sweeperInterval.unref === 'function') {
        this._sweeperInterval.unref();
      }

      this._onVisibilityChange = () => {
        if (typeof document !== 'undefined' && !document.hidden) {
          this.purgeExpiredMessages();
        }
      };
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', this._onVisibilityChange);
      }
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('focus', this._onVisibilityChange);
      }
    }

    /**
     * Purge any messages whose real elapsed lifespan has exceeded 15 minutes.
     */
    purgeExpiredMessages() {
      const now = window.VanishTimeAuthority ? window.VanishTimeAuthority.now() : Date.now();
      for (const msg of [...this.liveMessages]) {
        if (now >= msg.expiresAt) {
          this.deleteMessage(msg.id);
        }
      }
    }

    /**
     * Attach an active RoomSession instance to this chat controller.
     * @param {VanishRoomSession} roomSession
     */
    attachRoom(roomSession) {
      this.roomSession = roomSession;
      this.clearMessages();

      // Listen for decrypted messages from roomSession
      this.roomSession.onMessageReceived((msg) => {
        this.addMessage(msg);
      });
    }

    /**
     * Clear all messages from UI and memory, canceling all independent deletion timers.
     */
    clearMessages() {
      // Cancel all independent timers
      for (const timerId of this.messageTimers.values()) {
        clearTimeout(timerId);
      }
      this.messageTimers.clear();
      this.liveMessages = [];
      if (this.elements && this.elements.messageList) {
        this.elements.messageList.textContent = '';
      }
      console.log('[VanishChat] In-memory chat messages completely wiped and all message timers cleared.');
    }

    /**
     * Synchronized clear chat action triggered by trusted server coordination.
     * Prevents cleared messages from reappearing.
     * @param {number} clearedAt
     * @param {string} [clearedBy]
     */
    handleClearChat(clearedAt, clearedBy) {
      this.lastClearedTimestamp = typeof clearedAt === 'number' ? clearedAt : Date.now();
      this.clearMessages();
      if (clearedBy) {
        this.addSystemNotice(`Chat was cleared for both participants by ${clearedBy}.`);
      } else {
        this.addSystemNotice('Chat was cleared for both participants.');
      }
    }

    /**
     * Delete an individual message after its independent 15-minute timer expires.
     * @param {string} msgId
     */
    deleteMessage(msgId) {
      if (!msgId) return;

      if (this.messageTimers.has(msgId)) {
        clearTimeout(this.messageTimers.get(msgId));
        this.messageTimers.delete(msgId);
      }

      this.liveMessages = this.liveMessages.filter(m => m.id !== msgId);

      if (this.elements && this.elements.messageList && typeof this.elements.messageList.querySelector === 'function') {
        const row = this.elements.messageList.querySelector(`[data-msg-id="${msgId}"]`);
        if (row && typeof row.remove === 'function') {
          row.remove();
        }
      }
    }

    /**
     * Safely render and append a new message to the live view.
     * Uses textContent and createTextNode exclusively — NO innerHTML injection.
     * Schedules an independent 15-minute deletion timer.
     * @param {Object} msg { text, senderNick, isSelf, isSystem, isSecurityAlert, timestamp, id }
     */
    addMessage(msg) {
      const timestamp = typeof msg.timestamp === 'number'
        ? msg.timestamp
        : (window.VanishTimeAuthority ? window.VanishTimeAuthority.now() : Date.now());

      // Reject any delayed or replayed message sent prior to the chat clear cutoff
      if (this.lastClearedTimestamp && timestamp <= this.lastClearedTimestamp && !msg.isSystem) {
        console.log(`[VanishChat] Message sent prior to chat clear (${timestamp} <= ${this.lastClearedTimestamp}). Discarded.`);
        return;
      }

      const now = window.VanishTimeAuthority ? window.VanishTimeAuthority.now() : Date.now();
      const elapsed = now - timestamp;
      const remainingMs = this.ttlMs - elapsed;

      // Discard messages that have already expired
      if (remainingMs <= 0) {
        console.log(`[VanishChat] Incoming message has already expired (${elapsed}ms elapsed >= ${this.ttlMs}ms limit). Discarded.`);
        return;
      }

      const msgId = msg.id || ('msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9));
      const messageData = {
        ...msg,
        id: msgId,
        timestamp: timestamp,
        expiresAt: timestamp + this.ttlMs
      };

      this.liveMessages.push(messageData);

      if (this.elements && this.elements.messageList) {
        const row = document.createElement('div');
        row.className = `message-row ${msg.isSelf ? 'self' : msg.isSystem ? 'system' : 'peer'}`;
        if (msg.isSecurityAlert) row.classList.add('security-alert');
        if (typeof row.setAttribute === 'function') {
          row.setAttribute('data-msg-id', msgId);
        }

        if (msg.isSystem) {
          const sysCard = document.createElement('div');
          sysCard.className = 'system-message-card';

          const sysText = document.createElement('span');
          sysText.textContent = msg.text;

          sysCard.appendChild(sysText);
          row.appendChild(sysCard);
        } else {
          const bubble = document.createElement('div');
          bubble.className = 'message-bubble';

          // Sender header
          const header = document.createElement('div');
          header.className = 'message-header';

          const senderSpan = document.createElement('span');
          senderSpan.className = 'message-sender';
          senderSpan.textContent = msg.isSelf ? 'You' : msg.senderNick;

          const timeSpan = document.createElement('span');
          timeSpan.className = 'message-time';
          timeSpan.textContent = this._formatTime(timestamp);

          header.appendChild(senderSpan);
          header.appendChild(timeSpan);

          // Message text body (strictly textNode)
          const textBody = document.createElement('div');
          textBody.className = 'message-text';
          textBody.textContent = msg.text;

          bubble.appendChild(header);
          bubble.appendChild(textBody);
          row.appendChild(bubble);
        }

        this.elements.messageList.appendChild(row);

        // Scroll smoothly to bottom
        this.elements.messageList.scrollTop = this.elements.messageList.scrollHeight;
      }

      // Schedule independent 15-minute deletion timer
      const timerId = setTimeout(() => {
        this.deleteMessage(msgId);
      }, Math.max(0, remainingMs));

      this.messageTimers.set(msgId, timerId);
    }

    /**
     * Add a system notice into the live chat log (e.g. Handshake complete, partner joined).
     * @param {string} text
     * @param {boolean} [isAlert=false]
     */
    addSystemNotice(text, isAlert = false) {
      this.addMessage({
        text: text,
        senderNick: 'System',
        isSelf: false,
        isSystem: true,
        isSecurityAlert: isAlert,
        timestamp: window.VanishTimeAuthority ? window.VanishTimeAuthority.now() : Date.now()
      });
    }

    /**
     * Send message from input.
     */
    async handleSendMessage() {
      if (!this.roomSession || this.isSending) return;

      const rawText = this.elements.textarea ? this.elements.textarea.value : '';
      const val = window.VanishValidation.validateMessage(rawText);
      if (!val.valid) {
        window.VanishUI.showToast(val.error, 'error');
        return;
      }

      this.isSending = true;
      if (this.elements.sendBtn) this.elements.sendBtn.disabled = true;

      try {
        const sentMsg = await this.roomSession.sendMessage(val.sanitized);
        this.addMessage(sentMsg);

        // Clear input and reset char count
        if (this.elements.textarea) {
          this.elements.textarea.value = '';
          this.elements.textarea.style.height = 'auto';
        }
        if (this.elements.charCount) {
          this.elements.charCount.textContent = '0 / 2000';
        }
      } catch (err) {
        console.error('[VanishChat] Send error:', err);
        window.VanishUI.showToast(err.message || 'Failed to send message.', 'error');
      } finally {
        this.isSending = false;
        if (this.elements.sendBtn) this.elements.sendBtn.disabled = false;
        if (this.elements.textarea) this.elements.textarea.focus();
      }
    }

    _formatTime(timestamp) {
      const d = new Date(timestamp);
      const hours = d.getHours().toString().padStart(2, '0');
      const mins = d.getMinutes().toString().padStart(2, '0');
      return `${hours}:${mins}`;
    }

    destroy() {
      if (this._sweeperInterval) {
        clearInterval(this._sweeperInterval);
        this._sweeperInterval = null;
      }
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function' && this._onVisibilityChange) {
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
      }
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function' && this._onVisibilityChange) {
        window.removeEventListener('focus', this._onVisibilityChange);
      }
      this.clearMessages();
    }
  }

  window.VanishChatController = VanishChatController;
})(window);
