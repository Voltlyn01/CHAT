/**
 * VanishText {Made by SUVX}
 * Main Application Orchestrator
 */

(function (window) {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {
    // 1. Initialize UI controller
    window.VanishUI.init();

    // 2. Initialize Room Session
    const roomSession = new window.VanishRoomSession();

    // 3. Initialize Chat Controller with DOM elements
    const chatController = new window.VanishChatController({
      messageList: document.getElementById('chat-messages-container'),
      textarea: document.getElementById('chat-input-textarea'),
      sendBtn: document.getElementById('btn-send-message'),
      charCount: document.getElementById('chat-char-counter')
    });
    chatController.attachRoom(roomSession);

    // Track active verification details
    let currentVerificationData = null;

    // 4. Room Session State Handler
    roomSession.onStateChange((newState, details) => {
      switch (newState) {
        case window.VANISH_ROOM_STATES.CREATING:
          // Loading state handled in form submit
          break;

        case window.VANISH_ROOM_STATES.WAITING_FOR_PEER:
          if (window.VanishUI.inviteCodeDisplay) {
            window.VanishUI.inviteCodeDisplay.textContent = details.formattedCode || '----';
          }
          window.VanishUI.showView('invite');
          window.VanishUI.updateChatStatus('waiting', details.roomType === 'group' ? 'Waiting for members to join...' : 'Waiting for partner to join...', details.transportName);
          window.VanishUI.updateParticipants(roomSession.localNickname, '', 1, details.maxParticipants, details.roomType);

          const typeBadgeWait = document.getElementById('chat-type-badge');
          if (typeBadgeWait) {
            if (details.roomType === 'group') {
              typeBadgeWait.style.display = 'inline-block';
              typeBadgeWait.textContent = `Group Room (1/${details.maxParticipants || 10})`;
            } else {
              typeBadgeWait.style.display = 'none';
            }
          }
          break;

        case window.VANISH_ROOM_STATES.JOINING:
          window.VanishUI.showView('chat');
          window.VanishUI.updateChatStatus('waiting', 'Connecting to secure room...', 'WebRTC P2P');
          window.VanishUI.updateParticipants(roomSession.localNickname, 'Host (connecting...)');
          chatController.clearMessages();
          chatController.addSystemNotice('Connecting to room host via secure peer-to-peer network...');
          break;

        case window.VANISH_ROOM_STATES.HANDSHAKE:
          window.VanishUI.showView('chat');
          window.VanishUI.updateChatStatus('handshake', details.message || 'Exchanging encryption keys...', roomSession.transport ? roomSession.transport.getTransportName() : '');
          chatController.addSystemNotice(details.message || 'Exchanging ephemeral ECDH cryptographic keys...');
          break;

        case window.VANISH_ROOM_STATES.CONNECTED:
          window.VanishUI.showView('chat');
          currentVerificationData = details.verification;

          window.VanishUI.updateChatStatus('connected', 'End-to-End Encrypted', details.transportName);
          window.VanishUI.updateParticipants(
            details.localNickname,
            details.remoteNickname,
            details.participantCount,
            details.maxParticipants,
            details.roomType
          );

          const typeBadgeConn = document.getElementById('chat-type-badge');
          if (typeBadgeConn) {
            if (details.roomType === 'group') {
              typeBadgeConn.style.display = 'inline-block';
              typeBadgeConn.textContent = `Group Room (${details.participantCount || 2}/${details.maxParticipants || 10})`;
            } else {
              typeBadgeConn.style.display = 'none';
            }
          }

          if (window.VanishUI.chatRoomTitle) {
            window.VanishUI.chatRoomTitle.textContent = details.roomName || (details.roomType === 'group' ? 'Group Room' : 'Private Room');
          }

          if (window.VanishUI.btnVerifySession && details.verification) {
            window.VanishUI.btnVerifySession.style.display = 'inline-flex';
            const sasShort = details.verification.sasCode || 'Verify';
            window.VanishUI.btnVerifySession.innerHTML = `<span>🛡️</span><span>${sasShort}</span>`;
          }

          const cipherDesc = details.roomType === 'group' ? 'AES-256-GCM Group Secret' : 'AES-256-GCM / ECDH P-256';
          chatController.addSystemNotice(`Encrypted session active. E2EE verified (${cipherDesc}).`);
          break;

        case window.VANISH_ROOM_STATES.PEER_DISCONNECTED:
          window.VanishUI.updateChatStatus('disconnected', 'Participant Disconnected', roomSession.transport ? roomSession.transport.getTransportName() : '');
          window.VanishUI.updateParticipants(roomSession.localNickname, '');
          chatController.addSystemNotice(details.message || 'Participant left the conversation.', true);
          break;

        case window.VANISH_ROOM_STATES.ROOM_FULL:
          window.VanishUI.showToast(details.message || 'This room is full. Only two participants are allowed.', 'error', 6000);
          window.VanishUI.showView('landing');
          break;

        case window.VANISH_ROOM_STATES.EXPIRED:
          window.VanishUI.showToast(details.message || 'Room session expired. All data permanently destroyed.', 'info', 6000);
          chatController.clearMessages();
          window.VanishUI.showView('landing');
          break;

        case window.VANISH_ROOM_STATES.ERROR:
          window.VanishUI.showToast(details.error || 'A room error occurred.', 'error', 5000);
          break;

        case window.VANISH_ROOM_STATES.IDLE:
          if (window.VanishUI.btnVerifySession) {
            window.VanishUI.btnVerifySession.style.display = 'none';
          }
          break;
      }
    });

    // 5. Wire Landing Page Navigation
    const btnOpenCreate = document.getElementById('btn-open-create');
    const btnOpenJoin = document.getElementById('btn-open-join');
    const btnCancelCreate = document.getElementById('btn-cancel-create');
    const btnCancelJoin = document.getElementById('btn-cancel-join');
    const btnPrivacyModal = document.getElementById('btn-privacy-modal');
    const btnClosePrivacyModal = document.getElementById('btn-close-privacy');
    const btnCloseVerifyModal = document.getElementById('btn-close-verify');

    if (btnOpenCreate) {
      btnOpenCreate.addEventListener('click', () => {
        window.VanishUI.showView('create');
        const nickInput = document.getElementById('create-nickname');
        if (nickInput) nickInput.focus();
      });
    }

    if (btnOpenJoin) {
      btnOpenJoin.addEventListener('click', () => {
        window.VanishUI.showView('join');
        const codeInput = document.getElementById('join-code');
        if (codeInput) codeInput.focus();
      });
    }

    if (btnCancelCreate) {
      btnCancelCreate.addEventListener('click', () => window.VanishUI.showView('landing'));
    }

    if (btnCancelJoin) {
      btnCancelJoin.addEventListener('click', () => window.VanishUI.showView('landing'));
    }

    if (btnPrivacyModal) {
      btnPrivacyModal.addEventListener('click', () => {
        window.VanishUI.openModal(window.VanishUI.modalPrivacy);
      });
    }

    if (btnClosePrivacyModal) {
      btnClosePrivacyModal.addEventListener('click', () => {
        window.VanishUI.closeModal(window.VanishUI.modalPrivacy);
      });
    }

    if (btnCloseVerifyModal) {
      btnCloseVerifyModal.addEventListener('click', () => {
        window.VanishUI.closeModal(window.VanishUI.modalVerification);
      });
    }

    // 6. Create Room Form Submit
    const formCreateRoom = document.getElementById('form-create-room');
    const btnSubmitCreate = document.getElementById('btn-submit-create');

    if (formCreateRoom) {
      formCreateRoom.addEventListener('submit', async (e) => {
        e.preventDefault();
        const nickname = document.getElementById('create-nickname').value;
        const roomName = document.getElementById('create-roomname').value;
        const transportSelect = document.getElementById('create-transport-mode');
        const preferredTransport = transportSelect ? transportSelect.value : 'auto';

        const nickVal = window.VanishValidation.validateNickname(nickname);
        if (!nickVal.valid) {
          window.VanishUI.showToast(nickVal.error, 'error');
          return;
        }

        const roomTypeSelect = document.getElementById('create-room-type');
        const roomType = roomTypeSelect ? roomTypeSelect.value : 'direct';

        btnSubmitCreate.disabled = true;
        btnSubmitCreate.textContent = 'Generating Secure Room...';

        try {
          await roomSession.createRoom(nickname, roomName, preferredTransport, roomType);
        } catch (err) {
          console.error('[Create Room Error]', err);
          window.VanishUI.showToast(err.message || 'Could not create private room.', 'error');
          btnSubmitCreate.disabled = false;
          btnSubmitCreate.textContent = roomType === 'group' ? 'CREATE GROUP ROOM' : 'CREATE PRIVATE ROOM';
        } finally {
          btnSubmitCreate.disabled = false;
          btnSubmitCreate.textContent = roomType === 'group' ? 'CREATE GROUP ROOM' : 'CREATE PRIVATE ROOM';
        }
      });
    }

    const selectRoomType = document.getElementById('create-room-type');
    const roomTypeHint = document.getElementById('room-type-hint');
    if (selectRoomType) {
      selectRoomType.addEventListener('change', () => {
        const isGroup = selectRoomType.value === 'group';
        if (roomTypeHint) {
          roomTypeHint.textContent = isGroup
            ? 'Group conversation for up to 10 participants with AES-256-GCM encryption.'
            : 'Direct 1-to-1 conversation with pairwise ECDH end-to-end encryption.';
        }
        if (btnSubmitCreate) {
          btnSubmitCreate.textContent = isGroup ? 'CREATE GROUP ROOM' : 'CREATE PRIVATE ROOM';
        }
      });
    }

    // 7. Invitation Screen Buttons
    if (window.VanishUI.btnCopyCode) {
      window.VanishUI.btnCopyCode.addEventListener('click', () => {
        window.VanishUI.copyInvitationCode(roomSession.formattedCode);
      });
    }

    if (window.VanishUI.btnShareInvite) {
      window.VanishUI.btnShareInvite.addEventListener('click', () => {
        window.VanishUI.shareInvitationCode(roomSession.formattedCode);
      });
    }

    if (window.VanishUI.btnEnterRoom) {
      window.VanishUI.btnEnterRoom.addEventListener('click', () => {
        window.VanishUI.showView('chat');
        window.VanishUI.updateChatStatus('waiting', 'Waiting for partner to join...', roomSession.transport ? roomSession.transport.getTransportName() : '');
        window.VanishUI.updateParticipants(roomSession.localNickname, '');
        chatController.addSystemNotice(`Room ready. Share invitation code: ${roomSession.formattedCode}`);
      });
    }

    // 8. Join Room Form Submit & Code Auto-formatting
    const formJoinRoom = document.getElementById('form-join-room');
    const joinCodeInput = document.getElementById('join-code');
    const btnSubmitJoin = document.getElementById('btn-submit-join');

    if (joinCodeInput) {
      joinCodeInput.addEventListener('input', (e) => {
        const val = e.target.value;
        const formatted = window.VanishValidation.formatRoomCode(val);
        e.target.value = formatted;
      });
    }

    if (formJoinRoom) {
      formJoinRoom.addEventListener('submit', async (e) => {
        e.preventDefault();
        const rawCode = document.getElementById('join-code').value;
        const nickname = document.getElementById('join-nickname').value;
        const transportSelect = document.getElementById('join-transport-mode');
        const preferredTransport = transportSelect ? transportSelect.value : 'auto';

        const codeVal = window.VanishValidation.validateRoomCode(rawCode);
        if (!codeVal.valid) {
          window.VanishUI.showToast(codeVal.error, 'error');
          return;
        }

        const nickVal = window.VanishValidation.validateNickname(nickname);
        if (!nickVal.valid) {
          window.VanishUI.showToast(nickVal.error, 'error');
          return;
        }

        btnSubmitJoin.disabled = true;
        btnSubmitJoin.textContent = 'Joining & Verifying Slot...';

        try {
          await roomSession.joinRoom(rawCode, nickname, preferredTransport);
        } catch (err) {
          console.error('[Join Room Error]', err);
          window.VanishUI.showToast(err.message || 'Failed to join room.', 'error', 6000);
          chatController.clearMessages();
          roomSession.leaveRoom();
          window.VanishUI.showView('join');
          btnSubmitJoin.disabled = false;
          btnSubmitJoin.textContent = 'JOIN ROOM';
        } finally {
          btnSubmitJoin.disabled = false;
          btnSubmitJoin.textContent = 'JOIN ROOM';
        }
      });
    }

    // 9. Chat Input, Auto-expand & Send Handling
    const chatTextarea = document.getElementById('chat-input-textarea');
    const btnSendMessage = document.getElementById('btn-send-message');
    const charCounter = document.getElementById('chat-char-counter');

    if (chatTextarea) {
      chatTextarea.addEventListener('input', () => {
        // Auto-expand textarea height up to 140px
        chatTextarea.style.height = 'auto';
        chatTextarea.style.height = Math.min(chatTextarea.scrollHeight, 140) + 'px';

        const len = chatTextarea.value.length;
        if (charCounter) {
          charCounter.textContent = `${len} / 2000`;
          if (len > 1900) {
            charCounter.classList.add('warning');
          } else {
            charCounter.classList.remove('warning');
          }
        }
      });

      chatTextarea.addEventListener('keydown', (e) => {
        // Enter sends message, Shift+Enter adds newline
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          chatController.handleSendMessage();
        }
      });
    }

    if (btnSendMessage) {
      btnSendMessage.addEventListener('click', () => {
        chatController.handleSendMessage();
      });
    }

    // 10. Verification SAS Badge Click
    if (window.VanishUI.btnVerifySession) {
      window.VanishUI.btnVerifySession.addEventListener('click', () => {
        window.VanishUI.showVerificationDetails(
          currentVerificationData,
          roomSession.localNickname,
          roomSession.remoteNickname
        );
      });
    }

    // 11. Leave Room Button
    if (window.VanishUI.btnLeaveRoom) {
      window.VanishUI.btnLeaveRoom.addEventListener('click', () => {
        if (confirm('Leave room and permanently destroy all active chat messages and session keys?')) {
          chatController.clearMessages();
          roomSession.leaveRoom();
          window.VanishUI.showToast('You left the room. Session keys and messages wiped.', 'info');
          window.VanishUI.showView('landing');
        }
      });
    }

    // 12. Privacy Blur Toggle in Header
    const togglePrivacyBlur = document.getElementById('toggle-privacy-blur');
    if (togglePrivacyBlur) {
      togglePrivacyBlur.addEventListener('change', (e) => {
        window.VanishUI.privacyBlurEnabled = e.target.checked;
        window.VanishUI.showToast(`Privacy blur shield ${e.target.checked ? 'enabled' : 'disabled'}.`, 'info');
      });
    }

    // 13. Immediate cleanup on tab close, page refresh, or navigation
    window.addEventListener('beforeunload', () => {
      chatController.clearMessages();
      roomSession.leaveRoom();
    });
    window.addEventListener('pagehide', () => {
      chatController.clearMessages();
      roomSession.leaveRoom();
    });
  });
})(window);
