/**
 * VanishText {Made by SUVX}
 * UI Controller & Screen Transition Module
 */

(function (window) {
  'use strict';

  class VanishUIController {
    constructor() {
      this.currentView = 'landing';
      this.privacyBlurEnabled = true;
      this.clipboardTimeout = null;
    }

    init() {
      this._cacheDOMElements();
      this._bindGlobalEvents();
      this.showView('landing');
    }

    _cacheDOMElements() {
      // Views
      this.viewLanding = document.getElementById('view-landing');
      this.viewCreate = document.getElementById('view-create');
      this.viewJoin = document.getElementById('view-join');
      this.viewInvite = document.getElementById('view-invite');
      this.viewChat = document.getElementById('view-chat');

      // Modals
      this.modalVerification = document.getElementById('modal-verification');
      this.modalPrivacy = document.getElementById('modal-privacy');
      this.modalAdmission = document.getElementById('modal-admission');
      this.admissionGuestNick = document.getElementById('admission-guest-nick');
      this.btnAdmitGuest = document.getElementById('btn-admit-guest');
      this.btnRejectGuest = document.getElementById('btn-reject-guest');
      this.modalDeterrent = document.getElementById('modal-deterrent');
      this.privacyBlurOverlay = document.getElementById('privacy-blur-overlay');

      // Invitation elements
      this.inviteCodeDisplay = document.getElementById('invite-code-display');
      this.btnCopyCode = document.getElementById('btn-copy-code');
      this.btnCopyLink = document.getElementById('btn-copy-link');
      this.btnEnterRoom = document.getElementById('btn-enter-room');
      this.btnShareInvite = document.getElementById('btn-share-invite');

      // Chat header elements
      this.chatRoomTitle = document.getElementById('chat-room-title');
      this.chatParticipants = document.getElementById('chat-participants');
      this.chatStatusIndicator = document.getElementById('chat-status-indicator');
      this.chatStatusText = document.getElementById('chat-status-text');
      this.chatTransportBadge = document.getElementById('chat-transport-badge');
      this.btnVerifySession = document.getElementById('btn-verify-session');
      this.btnClearChat = document.getElementById('btn-clear-chat');
      this.btnRemoveGuest = document.getElementById('btn-remove-guest');
      this.btnLeaveRoom = document.getElementById('btn-leave-room');

      // Left Sidebar elements
      this.chatSidebar = document.getElementById('chat-sidebar');
      this.btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
      this.sidebarRoomCode = document.getElementById('sidebar-room-code');
      this.btnSidebarCopy = document.getElementById('btn-sidebar-copy');
      this.sidebarParticipantBadge = document.getElementById('sidebar-participant-badge');
      this.mobileParticipantCount = document.getElementById('mobile-participant-count');
      this.sidebarParticipantsList = document.getElementById('sidebar-participants-list');
      this.sidebarPendingWrap = document.getElementById('sidebar-pending-wrap');
      this.sidebarPendingNick = document.getElementById('sidebar-pending-nick');
      this.btnSidebarAdmit = document.getElementById('btn-sidebar-admit');
      this.btnSidebarReject = document.getElementById('btn-sidebar-reject');

      // Toast container
      this.toastContainer = document.getElementById('toast-container');

      // Network URL for sharing across Wi-Fi / Hotspot / LAN
      this.networkAccessUrl = '';
      if (typeof fetch === 'function') {
        fetch('/api/network-info')
          .then(res => res.json())
          .then(data => {
            if (data && data.primaryNetworkUrl) {
              this.networkAccessUrl = data.primaryNetworkUrl;
            }
          })
          .catch(() => {});
      }
    }

    showView(viewName) {
      this.currentView = viewName;
      const views = [this.viewLanding, this.viewCreate, this.viewJoin, this.viewInvite, this.viewChat];
      views.forEach(v => {
        if (v) v.classList.remove('active');
      });

      if (viewName === 'landing' && this.viewLanding) this.viewLanding.classList.add('active');
      if (viewName === 'create' && this.viewCreate) this.viewCreate.classList.add('active');
      if (viewName === 'join' && this.viewJoin) this.viewJoin.classList.add('active');
      if (viewName === 'invite' && this.viewInvite) this.viewInvite.classList.add('active');
      if (viewName === 'chat' && this.viewChat) this.viewChat.classList.add('active');

      // Close all modals when switching primary view
      this.closeModal(this.modalVerification);
      this.closeModal(this.modalPrivacy);
      this.closeModal(this.modalAdmission);
      this.closeModal(this.modalDeterrent);
    }

    openModal(modalElement) {
      if (modalElement) {
        modalElement.classList.add('active');
        modalElement.setAttribute('aria-hidden', 'false');
      }
    }

    closeModal(modalElement) {
      if (modalElement) {
        modalElement.classList.remove('active');
        modalElement.setAttribute('aria-hidden', 'true');
      }
    }

    showToast(message, type = 'info', duration = 3500) {
      if (!this.toastContainer) return;

      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;

      const icon = document.createElement('span');
      icon.className = 'toast-icon';
      icon.textContent = type === 'error' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️';

      const text = document.createElement('span');
      text.className = 'toast-text';
      text.textContent = message;

      toast.appendChild(icon);
      toast.appendChild(text);

      this.toastContainer.appendChild(toast);

      setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 400);
      }, duration);
    }

    /**
     * Copy invitation code to clipboard with fallback.
     * @param {string} code
     */
    async copyInvitationCode(code) {
      if (!code) return;

      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(code);
          this.showToast('Room code copied to clipboard!', 'success');
          return;
        }
      } catch (err) {
        console.warn('[Clipboard API failed, using manual fallback]', err);
      }

      // Manual selection fallback
      const textArea = document.createElement('textarea');
      textArea.value = code;
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();

      try {
        document.execCommand('copy');
        this.showToast('Room code copied to clipboard!', 'success');
      } catch (err) {
        this.showToast('Could not auto-copy. Please highlight and copy manually: ' + code, 'info', 6000);
      } finally {
        document.body.removeChild(textArea);
      }
    }

    /**
     * Copy direct join link to clipboard (supports Wi-Fi, Mobile Data, and Hotspot join).
     * @param {string} code
     */
    async copyJoinLink(code) {
      if (!code) return;
      let origin = (typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : '';
      if (!origin || origin.startsWith('file://')) {
        origin = this.networkAccessUrl || 'http://localhost:8080';
      } else if ((origin.includes('localhost') || origin.includes('127.0.0.1')) && this.networkAccessUrl) {
        origin = this.networkAccessUrl;
      }
      const link = `${origin}/?code=${encodeURIComponent(code)}`;

      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(link);
          this.showToast('Direct join link copied to clipboard!', 'success');
          return;
        }
      } catch (err) {
        console.warn('[Clipboard API failed for link, using fallback]', err);
      }

      this.copyInvitationCode(link);
    }

    /**
     * Native Web Share API if supported
     * @param {string} code
     */
    async shareInvitationCode(code) {
      if (!code) return;
      let origin = (typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : '';
      if (!origin || origin.startsWith('file://')) origin = 'http://localhost:8080';
      const link = `${origin}/?code=${encodeURIComponent(code)}`;
      const shareText = `Join my private, end-to-end encrypted room on VanishText.\nRoom Code: ${code}\nDirect Join Link: ${link}`;

      if (navigator.share) {
        try {
          await navigator.share({
            title: 'VanishText Private Room Invitation',
            text: shareText,
            url: link
          });
          return;
        } catch (e) {
          if (e.name !== 'AbortError') {
            this.copyJoinLink(code);
          }
          return;
        }
      }
      this.copyJoinLink(code);
    }

    /**
     * Update chat status indicators
     */
    updateChatStatus(status, text, transportName) {
      if (this.chatStatusIndicator) {
        this.chatStatusIndicator.className = `status-dot status-${status}`;
      }
      if (this.chatStatusText) {
        this.chatStatusText.textContent = text;
      }
      if (this.chatTransportBadge && transportName) {
        this.chatTransportBadge.textContent = transportName;
      }
    }

    /**
     * Update participant names in header
     */
    updateParticipants(localNick, remoteNick, count = 1, maxCount = 2, roomType = 'direct') {
      if (!this.chatParticipants) return;
      if (roomType === 'group') {
        const total = typeof count === 'number' && count >= 1 ? count : 1;
        const max = typeof maxCount === 'number' && maxCount >= 2 ? maxCount : 10;
        if (total > 1) {
          const others = total - 1;
          this.chatParticipants.textContent = `${localNick} (You) & ${others} member${others > 1 ? 's' : ''} (${total}/${max})`;
        } else {
          this.chatParticipants.textContent = `${localNick} (You) • Waiting for members (1/${max})...`;
        }
      } else {
        if (remoteNick) {
          this.chatParticipants.textContent = `${localNick} (You) & ${remoteNick}`;
        } else {
          this.chatParticipants.textContent = `${localNick} (You) • Waiting for partner...`;
        }
      }
    }

    /**
     * Populate Verification Modal with SAS & Fingerprint details
     */
    showVerificationDetails(verificationData, localNick, remoteNick) {
      if (!verificationData) return;

      const sasCodeEl = document.getElementById('verify-sas-code');
      const sasEmojiEl = document.getElementById('verify-sas-emoji');
      const sasHexEl = document.getElementById('verify-sas-hex');
      const verifyUsersEl = document.getElementById('verify-users');

      if (sasCodeEl) sasCodeEl.textContent = verificationData.sasCode || '------';
      if (sasEmojiEl) sasEmojiEl.textContent = verificationData.emojiFingerprint || '🔒 🛡️ ⚡ 🔑';
      if (sasHexEl) sasHexEl.textContent = verificationData.hexFingerprint || '----:----:----:----';
      if (verifyUsersEl) verifyUsersEl.textContent = `${localNick} & ${remoteNick || 'Participant 2'}`;

      this.openModal(this.modalVerification);
    }

    /**
     * Update the left sidebar: room code, participant count, participant list, and inline removal controls.
     */
    updateSidebar(formattedCode, participantsMap, isCreator, onRemoveParticipantCallback) {
      if (this.sidebarRoomCode && formattedCode) {
        this.sidebarRoomCode.textContent = formattedCode;
      }

      const totalCount = participantsMap ? (participantsMap.size || 1) : 1;
      if (this.sidebarParticipantBadge) {
        this.sidebarParticipantBadge.textContent = `${totalCount} Online`;
      }
      if (this.mobileParticipantCount) {
        this.mobileParticipantCount.textContent = totalCount;
      }

      if (!this.sidebarParticipantsList) return;
      this.sidebarParticipantsList.innerHTML = '';

      if (participantsMap && participantsMap.size > 0) {
        for (const [id, p] of participantsMap.entries()) {
          const item = document.createElement('div');
          item.className = `sidebar-participant-item ${p.isSelf ? 'is-self' : ''}`;

          const avatar = document.createElement('div');
          avatar.className = 'participant-avatar';
          const initial = (p.nickname && p.nickname.length > 0) ? p.nickname.charAt(0).toUpperCase() : 'U';
          avatar.textContent = initial;

          const meta = document.createElement('div');
          meta.className = 'participant-meta';

          const nameSpan = document.createElement('span');
          nameSpan.className = 'participant-name';
          nameSpan.textContent = p.nickname + (p.isSelf ? ' (You)' : '');

          const roleTag = document.createElement('span');
          roleTag.className = `participant-role-tag ${p.isOwner ? 'role-owner' : 'role-member'}`;
          roleTag.textContent = p.isOwner ? 'Owner' : 'Participant';

          meta.appendChild(nameSpan);
          meta.appendChild(roleTag);
          item.appendChild(avatar);
          item.appendChild(meta);

          // If current user is the room owner (creator) and target is not self, provide inline removal
          if (isCreator && !p.isSelf) {
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'btn-remove-participant';
            removeBtn.title = `Remove ${p.nickname} from room`;
            removeBtn.textContent = '✕';
            removeBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              if (typeof onRemoveParticipantCallback === 'function') {
                onRemoveParticipantCallback(id, p.nickname);
              }
            });
            item.appendChild(removeBtn);
          }

          this.sidebarParticipantsList.appendChild(item);
        }
      }
    }

    /**
     * Show admission request dialog and sidebar banner to room creator
     */
    showAdmissionPrompt(guestNick) {
      if (this.admissionGuestNick) {
        this.admissionGuestNick.textContent = guestNick || 'Guest';
      }
      if (this.sidebarPendingNick) {
        this.sidebarPendingNick.textContent = guestNick || 'Guest';
      }
      if (this.sidebarPendingWrap) {
        this.sidebarPendingWrap.style.display = 'flex';
      }
      this.openModal(this.modalAdmission);
    }

    /**
     * Hide admission request dialog and sidebar banner
     */
    hideAdmissionPrompt() {
      this.closeModal(this.modalAdmission);
      if (this.sidebarPendingWrap) {
        this.sidebarPendingWrap.style.display = 'none';
      }
    }

    /**
     * Configure creator-only buttons based on role and active guest state
     */
    setCreatorControls(isCreator, hasGuest) {
      if (this.btnRemoveGuest) {
        this.btnRemoveGuest.style.display = (isCreator && hasGuest) ? 'inline-flex' : 'none';
      }
    }

    _bindGlobalEvents() {
      // Privacy Mode Blur on Window Blur / Document Hidden
      const handlePrivacyBlur = () => {
        if (!this.privacyBlurEnabled) return;
        if (this.currentView === 'chat') {
          if (document.hidden || !document.hasFocus()) {
            if (this.privacyBlurOverlay) this.privacyBlurOverlay.classList.add('visible');
          } else {
            if (this.privacyBlurOverlay) this.privacyBlurOverlay.classList.remove('visible');
          }
        }
      };

      window.addEventListener('blur', handlePrivacyBlur);
      window.addEventListener('focus', () => {
        if (this.privacyBlurOverlay) this.privacyBlurOverlay.classList.remove('visible');
      });
      document.addEventListener('visibilitychange', handlePrivacyBlur);

      if (this.privacyBlurOverlay) {
        this.privacyBlurOverlay.addEventListener('click', () => {
          this.privacyBlurOverlay.classList.remove('visible');
        });
      }

      // Screenshot and DevTools Shortcut Deterrence
      window.addEventListener('keydown', (e) => {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const ctrlOrCmd = isMac ? e.metaKey : e.ctrlKey;

        // F12, PrintScreen
        // Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C (DevTools)
        // Ctrl+U (View Source), Ctrl+S (Save Page), Ctrl+P (Print Page)
        const isF12 = e.key === 'F12';
        const isPrintScreen = e.key === 'PrintScreen';
        const isDevToolsCombo = ctrlOrCmd && e.shiftKey && ['I', 'J', 'C', 'i', 'j', 'c'].includes(e.key);
        const isInspectShortcut = ctrlOrCmd && ['u', 'U', 's', 'S', 'p', 'P'].includes(e.key);

        if (isF12 || isPrintScreen || isDevToolsCombo || isInspectShortcut) {
          e.preventDefault();
          e.stopPropagation();

          this.showToast('⚠️ Screenshot / inspection shortcut intercepted. VanishText protects privacy.', 'error', 4000);
          console.warn('[VanishText Security Notice] Browser shortcut intercepted. Note: OS-level screen capture cannot be blocked by any web application.');
          return false;
        }
      }, true);
    }
  }

  window.VanishUI = new VanishUIController();
})(window);
